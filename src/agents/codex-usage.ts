import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CODEX_USAGE_ENDPOINT =
  'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_TOKEN_REFRESH_ENDPOINT =
  'https://auth.openai.com/oauth/token';
export const CODEX_CLI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export type CodexUsageWindow = {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  limit_reached: boolean;
};

export type CodexUsage = {
  agent: 'codex';
  plan_type: string;
  rate_limit: {
    allowed: boolean;
    limit_reached: boolean;
    primary_window: CodexUsageWindow;
    secondary_window: CodexUsageWindow;
  };
};

export type GetCodexUsageOptions = {
  accessToken?: string;
  accountId?: string;
  authPath?: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  userAgent?: string;
  refreshEndpoint?: string;
  oauthClientId?: string;
  refreshBeforeExpiryMs?: number;
  staleRefreshMs?: number;
};

type JsonObject = Record<string, unknown>;

type CodexCredentials = {
  accessToken: string;
  accountId: string;
};

type CodexTokens = CodexCredentials & {
  refreshToken?: string;
};

type LoadedCodexCredentials = {
  document: JsonObject;
  tokensDocument: JsonObject;
  tokens: CodexTokens;
  lastRefreshMs?: number;
  resolvedPath: string;
};

/**
 * Why a refresh failed. Permanent failures mean the stored refresh token can
 * never be used again and the account must be logged in through the Codex CLI;
 * transient failures are safe to retry on the next poll.
 */
export class CodexTokenRefreshError extends Error {
  public readonly permanent: boolean;
  public readonly code: string | undefined;
  public readonly status: number | undefined;

  constructor(
    message: string,
    options: {
      permanent: boolean;
      code?: string;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'CodexTokenRefreshError';
    this.permanent = options.permanent;
    this.code = options.code;
    this.status = options.status;
  }
}

// Mirrors CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES in the Codex CLI.
const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
// Mirrors TOKEN_REFRESH_INTERVAL (days) in the Codex CLI, used only when the
// access token carries no readable `exp` claim.
const DEFAULT_STALE_REFRESH_MS = 8 * 24 * 60 * 60 * 1000;
// Refresh tokens rotate, so these leave the account unusable until re-login.
const PERMANENT_REFRESH_ERROR_CODES = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
]);
const inFlightCredentialRefreshes = new Map<
  string,
  Promise<LoadedCodexCredentials>
>();

export async function getCodexUsage(
  options: GetCodexUsageOptions = {},
): Promise<CodexUsage> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const explicitAccessToken = options.accessToken?.trim();
  const explicitAccountId = options.accountId?.trim();
  if (Boolean(explicitAccessToken) !== Boolean(explicitAccountId)) {
    throw new Error(
      'Codex accessToken and accountId must be provided together',
    );
  }

  const explicitCredentials =
    explicitAccessToken && explicitAccountId
      ? { accessToken: explicitAccessToken, accountId: explicitAccountId }
      : null;
  let credentials = explicitCredentials
    ? null
    : await readCodexCredentials(options.authPath);
  if (credentials && shouldRefreshCredentials(credentials, options)) {
    credentials = await refreshCodexCredentials({
      credentials,
      fetchImplementation,
      options,
      force: false,
    });
  }

  let tokens: CodexCredentials | undefined =
    explicitCredentials ?? credentials?.tokens;
  if (!tokens) {
    throw new Error('Codex OAuth access token is unavailable');
  }
  let response = await requestCodexUsage(fetchImplementation, tokens, options);
  if (response.status === 401 && credentials) {
    await response.body?.cancel();
    credentials = await refreshCodexCredentials({
      credentials,
      fetchImplementation,
      options,
      force: true,
    });
    tokens = credentials.tokens;
    response = await requestCodexUsage(fetchImplementation, tokens, options);
  }

  if (!response.ok) {
    const detail = await readResponseError(response);
    throw new Error(
      `Codex usage request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }

  return normalizeCodexUsage(await response.json());
}

export function resolveCodexAuthPath(): string {
  const codexHome =
    process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'auth.json');
}

async function readCodexCredentials(
  authPath = resolveCodexAuthPath(),
): Promise<LoadedCodexCredentials> {
  // Isolated Codex homes symlink auth.json at the shared credential file, so a
  // refresh must resolve the link and write through to the real file.
  let resolvedPath: string;
  try {
    resolvedPath = await fs.realpath(authPath);
  } catch (error) {
    throw new Error(`Unable to read Codex credentials at ${authPath}`, {
      cause: error,
    });
  }

  let content: string;
  try {
    content = await fs.readFile(resolvedPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read Codex credentials at ${resolvedPath}`, {
      cause: error,
    });
  }

  let document: JsonObject;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isJsonObject(parsed)) {
      throw new Error('credentials root must be an object');
    }
    document = parsed;
  } catch (error) {
    throw new Error(`Codex credentials at ${resolvedPath} are not valid JSON`, {
      cause: error,
    });
  }

  const tokens = document.tokens;
  if (!isJsonObject(tokens)) {
    throw new Error(
      `Codex credentials at ${resolvedPath} do not contain a tokens object`,
    );
  }
  const accessToken = tokens.access_token;
  const accountId = tokens.account_id;
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error(
      `Codex credentials at ${resolvedPath} do not contain tokens.access_token`,
    );
  }
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new Error(
      `Codex credentials at ${resolvedPath} do not contain tokens.account_id`,
    );
  }

  const refreshToken =
    typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim()
      ? tokens.refresh_token.trim()
      : undefined;
  const lastRefreshMs = parseTimestampMs(document.last_refresh);

  return {
    document,
    tokensDocument: tokens,
    tokens: {
      accessToken: accessToken.trim(),
      accountId: accountId.trim(),
      ...(refreshToken ? { refreshToken } : {}),
    },
    ...(lastRefreshMs !== undefined ? { lastRefreshMs } : {}),
    resolvedPath,
  };
}

/**
 * The Codex refresh response carries no `expires_in`, so expiry comes from the
 * access token's own `exp` claim. When that cannot be read, fall back to the
 * age of `last_refresh`, exactly as the Codex CLI does.
 */
function shouldRefreshCredentials(
  credentials: LoadedCodexCredentials,
  options: GetCodexUsageOptions,
): boolean {
  const refreshBeforeExpiryMs =
    options.refreshBeforeExpiryMs ?? DEFAULT_REFRESH_BEFORE_EXPIRY_MS;
  if (!Number.isFinite(refreshBeforeExpiryMs) || refreshBeforeExpiryMs < 0) {
    throw new Error('refreshBeforeExpiryMs must be a non-negative number');
  }
  const staleRefreshMs = options.staleRefreshMs ?? DEFAULT_STALE_REFRESH_MS;
  if (!Number.isFinite(staleRefreshMs) || staleRefreshMs < 0) {
    throw new Error('staleRefreshMs must be a non-negative number');
  }

  const expiresAtMs = parseJwtExpiryMs(credentials.tokens.accessToken);
  if (expiresAtMs !== undefined) {
    return expiresAtMs <= Date.now() + refreshBeforeExpiryMs;
  }
  if (credentials.lastRefreshMs === undefined) {
    return false;
  }

  return credentials.lastRefreshMs < Date.now() - staleRefreshMs;
}

/** Reads the `exp` claim without verifying the signature. */
function parseJwtExpiryMs(token: string): number | undefined {
  const segments = token.split('.');
  if (segments.length < 2) {
    return undefined;
  }

  let claims: unknown;
  try {
    claims = JSON.parse(
      Buffer.from(segments[1] ?? '', 'base64url').toString('utf8'),
    ) as unknown;
  } catch {
    return undefined;
  }
  if (!isJsonObject(claims)) {
    return undefined;
  }
  const expiry = claims.exp;

  return typeof expiry === 'number' && Number.isFinite(expiry)
    ? expiry * 1000
    : undefined;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

async function requestCodexUsage(
  fetchImplementation: typeof globalThis.fetch,
  credentials: CodexCredentials,
  options: GetCodexUsageOptions,
): Promise<Response> {
  return fetchImplementation(options.endpoint ?? CODEX_USAGE_ENDPOINT, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${credentials.accessToken}`,
      'chatgpt-account-id': credentials.accountId,
      ...(options.userAgent ? { 'user-agent': options.userAgent } : {}),
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function refreshCodexCredentials(args: {
  credentials: LoadedCodexCredentials;
  fetchImplementation: typeof globalThis.fetch;
  options: GetCodexUsageOptions;
  force: boolean;
}): Promise<LoadedCodexCredentials> {
  const existing = inFlightCredentialRefreshes.get(
    args.credentials.resolvedPath,
  );
  if (existing) {
    return existing;
  }

  const refresh = performCodexCredentialRefresh(args).finally(() => {
    inFlightCredentialRefreshes.delete(args.credentials.resolvedPath);
  });
  inFlightCredentialRefreshes.set(args.credentials.resolvedPath, refresh);
  return refresh;
}

async function performCodexCredentialRefresh(args: {
  credentials: LoadedCodexCredentials;
  fetchImplementation: typeof globalThis.fetch;
  options: GetCodexUsageOptions;
  force: boolean;
}): Promise<LoadedCodexCredentials> {
  // Re-read first: a rotated refresh token may only be spent once, so a
  // refresh another process already completed must be adopted, not repeated.
  const latest = await readCodexCredentials(args.credentials.resolvedPath);
  const tokenChanged =
    latest.tokens.accessToken !== args.credentials.tokens.accessToken;
  if (
    tokenChanged ||
    (!args.force && !shouldRefreshCredentials(latest, args.options))
  ) {
    return latest;
  }

  const refreshToken = latest.tokens.refreshToken;
  if (!refreshToken) {
    throw new CodexTokenRefreshError(
      `Codex credentials at ${latest.resolvedPath} are expired or unauthorized and do not contain tokens.refresh_token`,
      { permanent: true },
    );
  }

  // The ChatGPT refresh grant is JSON-encoded; only the authorization-code and
  // gateway grants are form-encoded.
  const body = JSON.stringify({
    client_id: args.options.oauthClientId?.trim() || CODEX_CLI_OAUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  let response: Response;
  try {
    response = await args.fetchImplementation(
      args.options.refreshEndpoint ?? CODEX_TOKEN_REFRESH_ENDPOINT,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body,
        ...(args.options.signal ? { signal: args.options.signal } : {}),
      },
    );
  } catch (error) {
    throw new CodexTokenRefreshError(
      `Codex OAuth token refresh failed: ${describeError(error)}`,
      { permanent: false, cause: error },
    );
  }
  if (!response.ok) {
    throw await buildRefreshRejection(response);
  }

  const refreshed = normalizeRefreshResponse(await response.json());
  const refreshedTokensDocument: JsonObject = {
    ...latest.tokensDocument,
    access_token: refreshed.accessToken,
    refresh_token: refreshed.refreshToken ?? refreshToken,
    ...(refreshed.idToken ? { id_token: refreshed.idToken } : {}),
  };
  const refreshedDocument: JsonObject = {
    ...latest.document,
    tokens: refreshedTokensDocument,
    last_refresh: new Date().toISOString(),
  };
  await writeCodexCredentials(latest.resolvedPath, refreshedDocument);

  return readCodexCredentials(latest.resolvedPath);
}

/**
 * A rotated refresh token is spent on every attempt, so a rejection that names
 * the token itself must not be retried.
 */
async function buildRefreshRejection(
  response: Response,
): Promise<CodexTokenRefreshError> {
  const detail = await readResponseError(response);
  const code = parseOAuthErrorCode(detail);
  const permanent =
    response.status === 401 ||
    (code !== undefined && PERMANENT_REFRESH_ERROR_CODES.has(code)) ||
    (response.status === 400 && code === 'invalid_grant');
  const suffix = permanent ? '. Log in again with the Codex CLI.' : '';

  return new CodexTokenRefreshError(
    `Codex OAuth token refresh failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}${suffix}`,
    {
      permanent,
      status: response.status,
      ...(code ? { code } : {}),
    },
  );
}

function parseOAuthErrorCode(detail: string): string | undefined {
  if (!detail) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(detail) as unknown;
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) {
    return undefined;
  }
  const code = parsed.error_code ?? parsed.error;

  return typeof code === 'string' && code.trim()
    ? code.trim().toLowerCase()
    : undefined;
}

function normalizeRefreshResponse(value: unknown): {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
} {
  if (!isJsonObject(value)) {
    throw new CodexTokenRefreshError(
      'Codex OAuth token refresh response must be an object',
      { permanent: false },
    );
  }
  if (typeof value.access_token !== 'string' || !value.access_token.trim()) {
    throw new CodexTokenRefreshError(
      'Codex OAuth token refresh response does not contain access_token',
      { permanent: false },
    );
  }

  const refreshToken =
    typeof value.refresh_token === 'string' && value.refresh_token.trim()
      ? value.refresh_token.trim()
      : undefined;
  const idToken =
    typeof value.id_token === 'string' && value.id_token.trim()
      ? value.id_token.trim()
      : undefined;

  return {
    accessToken: value.access_token.trim(),
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
  };
}

async function writeCodexCredentials(
  authPath: string,
  document: JsonObject,
): Promise<void> {
  const stats = await fs.stat(authPath);
  const tempPath = path.join(
    path.dirname(authPath),
    `.${path.basename(authPath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await fs.writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: stats.mode & 0o777,
    });
    await fs.rename(tempPath, authPath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readResponseError(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

function normalizeCodexUsage(value: unknown): CodexUsage {
  if (!isJsonObject(value)) {
    throw new Error('Codex usage response must be a JSON object');
  }
  const planType = value.plan_type;
  if (typeof planType !== 'string') {
    throw new Error('Codex usage field plan_type must be a string');
  }
  const rateLimit = value.rate_limit;
  if (!isJsonObject(rateLimit)) {
    throw new Error('Codex usage field rate_limit must be an object');
  }

  return {
    agent: 'codex',
    plan_type: planType,
    rate_limit: {
      allowed: readBoolean(rateLimit.allowed, 'rate_limit.allowed'),
      limit_reached: readBoolean(
        rateLimit.limit_reached,
        'rate_limit.limit_reached',
      ),
      primary_window: normalizeWindow(
        rateLimit.primary_window,
        'rate_limit.primary_window',
      ),
      secondary_window: normalizeWindow(
        rateLimit.secondary_window,
        'rate_limit.secondary_window',
      ),
    },
  };
}

function normalizeWindow(value: unknown, fieldName: string): CodexUsageWindow {
  if (!isJsonObject(value)) {
    throw new Error(`Codex usage field ${fieldName} must be an object`);
  }
  const usedPercent = readFiniteNumber(
    value.used_percent,
    `${fieldName}.used_percent`,
  );
  return {
    used_percent: usedPercent,
    limit_window_seconds: readFiniteNumber(
      value.limit_window_seconds,
      `${fieldName}.limit_window_seconds`,
    ),
    reset_after_seconds: readFiniteNumber(
      value.reset_after_seconds,
      `${fieldName}.reset_after_seconds`,
    ),
    limit_reached: readOptionalBoolean(
      value.limit_reached,
      `${fieldName}.limit_reached`,
      usedPercent >= 100,
    ),
  };
}

function readFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Codex usage field ${fieldName} must be a finite number`);
  }
  return value;
}

function readBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Codex usage field ${fieldName} must be a boolean`);
  }
  return value;
}

function readOptionalBoolean(
  value: unknown,
  fieldName: string,
  fallback: boolean,
): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  return readBoolean(value, fieldName);
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
