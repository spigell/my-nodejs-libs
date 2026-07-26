import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_USAGE_ENDPOINT =
  'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_TOKEN_REFRESH_ENDPOINT =
  'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_CODE_OAUTH_CLIENT_ID =
  '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export type ClaudeUsageWindow = {
  utilization: number;
  resets_at: string | null;
};

export type ClaudeExtraUsage = {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency: string | null;
};

export type ClaudeUsageModel = {
  id: string | null;
  display_name: string;
};

export type ClaudeUsageLimit = {
  kind: string;
  group: string | null;
  percent: number;
  resets_at: string | null;
  is_active: boolean;
  scope: {
    model: ClaudeUsageModel | null;
  } | null;
};

export type ClaudeUsage = {
  agent: 'claude';
  five_hour: ClaudeUsageWindow | null;
  seven_day: ClaudeUsageWindow | null;
  seven_day_sonnet: ClaudeUsageWindow | null;
  seven_day_opus: ClaudeUsageWindow | null;
  limits: ClaudeUsageLimit[];
  extra_usage: ClaudeExtraUsage | null;
};

export type GetClaudeUsageOptions = {
  accessToken?: string;
  credentialsPath?: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  userAgent?: string;
  refreshEndpoint?: string;
  oauthClientId?: string;
  refreshBeforeExpiryMs?: number;
};

type JsonObject = Record<string, unknown>;

type ClaudeOAuthCredentials = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

type LoadedClaudeCredentials = {
  document: JsonObject;
  oauthDocument: JsonObject;
  oauth: ClaudeOAuthCredentials;
  resolvedPath: string;
};

const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
const inFlightCredentialRefreshes = new Map<
  string,
  Promise<LoadedClaudeCredentials>
>();

export async function getClaudeUsage(
  options: GetClaudeUsageOptions = {},
): Promise<ClaudeUsage> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const explicitAccessToken = options.accessToken?.trim();
  let credentials = explicitAccessToken
    ? null
    : await readClaudeCredentials(options.credentialsPath);
  if (
    credentials &&
    shouldRefreshCredentials(
      credentials.oauth,
      options.refreshBeforeExpiryMs ?? DEFAULT_REFRESH_BEFORE_EXPIRY_MS,
    )
  ) {
    credentials = await refreshClaudeCredentials({
      credentials,
      fetchImplementation,
      options,
      force: false,
    });
  }

  let accessToken = explicitAccessToken || credentials?.oauth.accessToken;
  if (!accessToken) {
    throw new Error('Claude OAuth access token is unavailable');
  }
  let response = await requestClaudeUsage(
    fetchImplementation,
    accessToken,
    options,
  );
  if (response.status === 401 && credentials) {
    await response.body?.cancel();
    credentials = await refreshClaudeCredentials({
      credentials,
      fetchImplementation,
      options,
      force: true,
    });
    accessToken = credentials.oauth.accessToken;
    response = await requestClaudeUsage(
      fetchImplementation,
      accessToken,
      options,
    );
  }
  if (!response.ok) {
    const detail = await readResponseError(response);
    throw new Error(
      `Claude usage request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }

  return normalizeClaudeUsage(await response.json());
}

export function resolveClaudeCredentialsPath(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  return path.join(configDir, '.credentials.json');
}

async function readClaudeCredentials(
  credentialsPath = resolveClaudeCredentialsPath(),
): Promise<LoadedClaudeCredentials> {
  let resolvedPath: string;
  try {
    resolvedPath = await fs.realpath(credentialsPath);
  } catch (error) {
    throw new Error(
      `Unable to resolve Claude credentials at ${credentialsPath}`,
      {
        cause: error,
      },
    );
  }

  let content: string;
  try {
    content = await fs.readFile(resolvedPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read Claude credentials at ${resolvedPath}`, {
      cause: error,
    });
  }

  let document: JsonObject;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('credentials root must be an object');
    }
    document = parsed as JsonObject;
  } catch (error) {
    throw new Error(
      `Claude credentials at ${resolvedPath} are not valid JSON`,
      { cause: error },
    );
  }

  const oauthValue = document.claudeAiOauth;
  if (
    !oauthValue ||
    typeof oauthValue !== 'object' ||
    Array.isArray(oauthValue)
  ) {
    throw new Error(
      `Claude credentials at ${resolvedPath} do not contain a claudeAiOauth object`,
    );
  }
  const oauthDocument = oauthValue as JsonObject;
  const accessToken = oauthDocument.accessToken;
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error(
      `Claude credentials at ${resolvedPath} do not contain claudeAiOauth.accessToken`,
    );
  }

  const refreshToken =
    typeof oauthDocument.refreshToken === 'string' &&
    oauthDocument.refreshToken.trim()
      ? oauthDocument.refreshToken.trim()
      : undefined;
  const expiresAt =
    typeof oauthDocument.expiresAt === 'number' &&
    Number.isFinite(oauthDocument.expiresAt)
      ? oauthDocument.expiresAt
      : undefined;

  return {
    document,
    oauthDocument,
    oauth: {
      accessToken: accessToken.trim(),
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
    resolvedPath,
  };
}

function shouldRefreshCredentials(
  credentials: ClaudeOAuthCredentials,
  refreshBeforeExpiryMs: number,
): boolean {
  if (credentials.expiresAt === undefined) {
    return false;
  }
  if (!Number.isFinite(refreshBeforeExpiryMs) || refreshBeforeExpiryMs < 0) {
    throw new Error('refreshBeforeExpiryMs must be a non-negative number');
  }

  return credentials.expiresAt <= Date.now() + refreshBeforeExpiryMs;
}

async function requestClaudeUsage(
  fetchImplementation: typeof globalThis.fetch,
  accessToken: string,
  options: GetClaudeUsageOptions,
): Promise<Response> {
  return fetchImplementation(options.endpoint ?? CLAUDE_USAGE_ENDPOINT, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
      'user-agent': options.userAgent?.trim() || 'claude-code/2.1.0',
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function refreshClaudeCredentials(args: {
  credentials: LoadedClaudeCredentials;
  fetchImplementation: typeof globalThis.fetch;
  options: GetClaudeUsageOptions;
  force: boolean;
}): Promise<LoadedClaudeCredentials> {
  const existing = inFlightCredentialRefreshes.get(
    args.credentials.resolvedPath,
  );
  if (existing) {
    return existing;
  }

  const refresh = performClaudeCredentialRefresh(args).finally(() => {
    inFlightCredentialRefreshes.delete(args.credentials.resolvedPath);
  });
  inFlightCredentialRefreshes.set(args.credentials.resolvedPath, refresh);
  return refresh;
}

async function performClaudeCredentialRefresh(args: {
  credentials: LoadedClaudeCredentials;
  fetchImplementation: typeof globalThis.fetch;
  options: GetClaudeUsageOptions;
  force: boolean;
}): Promise<LoadedClaudeCredentials> {
  const latest = await readClaudeCredentials(args.credentials.resolvedPath);
  const tokenChanged =
    latest.oauth.accessToken !== args.credentials.oauth.accessToken;
  if (
    tokenChanged ||
    (!args.force &&
      !shouldRefreshCredentials(
        latest.oauth,
        args.options.refreshBeforeExpiryMs ?? DEFAULT_REFRESH_BEFORE_EXPIRY_MS,
      ))
  ) {
    return latest;
  }

  const refreshToken = latest.oauth.refreshToken;
  if (!refreshToken) {
    throw new Error(
      `Claude credentials at ${latest.resolvedPath} are expired or unauthorized and do not contain claudeAiOauth.refreshToken`,
    );
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id:
      args.options.oauthClientId?.trim() || CLAUDE_CODE_OAUTH_CLIENT_ID,
  });
  const response = await args.fetchImplementation(
    args.options.refreshEndpoint ?? CLAUDE_TOKEN_REFRESH_ENDPOINT,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      ...(args.options.signal ? { signal: args.options.signal } : {}),
    },
  );
  if (!response.ok) {
    const detail = await readResponseError(response);
    throw new Error(
      `Claude OAuth token refresh failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }

  const refreshed = normalizeRefreshResponse(await response.json());
  const refreshedOauthDocument: JsonObject = {
    ...latest.oauthDocument,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? refreshToken,
    expiresAt: Date.now() + refreshed.expiresIn * 1000,
  };
  const refreshedDocument: JsonObject = {
    ...latest.document,
    claudeAiOauth: refreshedOauthDocument,
  };
  await writeClaudeCredentials(latest.resolvedPath, refreshedDocument);

  return readClaudeCredentials(latest.resolvedPath);
}

function normalizeRefreshResponse(value: unknown): {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Claude OAuth token refresh response must be an object');
  }

  const response = value as JsonObject;
  if (
    typeof response.access_token !== 'string' ||
    !response.access_token.trim()
  ) {
    throw new Error(
      'Claude OAuth token refresh response does not contain access_token',
    );
  }
  if (
    typeof response.expires_in !== 'number' ||
    !Number.isFinite(response.expires_in) ||
    response.expires_in <= 0
  ) {
    throw new Error(
      'Claude OAuth token refresh response does not contain a positive expires_in',
    );
  }

  const refreshToken =
    typeof response.refresh_token === 'string' && response.refresh_token.trim()
      ? response.refresh_token.trim()
      : undefined;
  return {
    accessToken: response.access_token.trim(),
    expiresIn: response.expires_in,
    ...(refreshToken ? { refreshToken } : {}),
  };
}

async function writeClaudeCredentials(
  credentialsPath: string,
  document: JsonObject,
): Promise<void> {
  const stats = await fs.stat(credentialsPath);
  const tempPath = path.join(
    path.dirname(credentialsPath),
    `.${path.basename(credentialsPath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await fs.writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: stats.mode & 0o777,
    });
    await fs.rename(tempPath, credentialsPath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

function normalizeClaudeUsage(value: unknown): ClaudeUsage {
  if (!value || typeof value !== 'object') {
    throw new Error('Claude usage response must be a JSON object');
  }

  const usage = value as Record<string, unknown>;
  return {
    agent: 'claude',
    five_hour: normalizeWindow(usage.five_hour, 'five_hour'),
    seven_day: normalizeWindow(usage.seven_day, 'seven_day'),
    seven_day_sonnet: normalizeWindow(
      usage.seven_day_sonnet,
      'seven_day_sonnet',
    ),
    seven_day_opus: normalizeWindow(usage.seven_day_opus, 'seven_day_opus'),
    limits: normalizeLimits(usage.limits),
    extra_usage: normalizeExtraUsage(usage.extra_usage),
  };
}

function normalizeWindow(
  value: unknown,
  fieldName: string,
): ClaudeUsageWindow | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!value || typeof value !== 'object') {
    throw new Error(
      `Claude usage field ${fieldName} must be an object or null`,
    );
  }

  const window = value as Record<string, unknown>;
  if (
    typeof window.utilization !== 'number' ||
    !Number.isFinite(window.utilization)
  ) {
    throw new Error(
      `Claude usage field ${fieldName}.utilization must be a finite number`,
    );
  }
  if (window.resets_at !== null && typeof window.resets_at !== 'string') {
    throw new Error(
      `Claude usage field ${fieldName}.resets_at must be a string or null`,
    );
  }

  return {
    utilization: window.utilization,
    resets_at: window.resets_at,
  };
}

function normalizeExtraUsage(value: unknown): ClaudeExtraUsage | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Claude usage field extra_usage must be an object or null');
  }

  const extraUsage = value as Record<string, unknown>;
  if (typeof extraUsage.is_enabled !== 'boolean') {
    throw new Error(
      'Claude usage field extra_usage.is_enabled must be a boolean',
    );
  }

  return {
    is_enabled: extraUsage.is_enabled,
    monthly_limit: normalizeNullableNumber(
      extraUsage.monthly_limit,
      'extra_usage.monthly_limit',
    ),
    used_credits: normalizeNullableNumber(
      extraUsage.used_credits,
      'extra_usage.used_credits',
    ),
    utilization: normalizeNullableNumber(
      extraUsage.utilization,
      'extra_usage.utilization',
    ),
    currency: normalizeNullableString(
      extraUsage.currency,
      'extra_usage.currency',
    ),
  };
}

function normalizeLimits(value: unknown): ClaudeUsageLimit[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('Claude usage field limits must be an array');
  }

  return value.map((entry, index) => normalizeLimit(entry, index));
}

function normalizeLimit(value: unknown, index: number): ClaudeUsageLimit {
  const fieldName = `limits[${index}]`;
  if (!value || typeof value !== 'object') {
    throw new Error(`Claude usage field ${fieldName} must be an object`);
  }

  const limit = value as Record<string, unknown>;
  if (typeof limit.kind !== 'string' || !limit.kind) {
    throw new Error(`Claude usage field ${fieldName}.kind must be a string`);
  }
  if (typeof limit.percent !== 'number' || !Number.isFinite(limit.percent)) {
    throw new Error(
      `Claude usage field ${fieldName}.percent must be a finite number`,
    );
  }
  if (typeof limit.is_active !== 'boolean') {
    throw new Error(
      `Claude usage field ${fieldName}.is_active must be a boolean`,
    );
  }

  return {
    kind: limit.kind,
    group: normalizeNullableString(limit.group, `${fieldName}.group`),
    percent: limit.percent,
    resets_at: normalizeNullableString(
      limit.resets_at,
      `${fieldName}.resets_at`,
    ),
    is_active: limit.is_active,
    scope: normalizeLimitScope(limit.scope, fieldName),
  };
}

function normalizeLimitScope(
  value: unknown,
  parentFieldName: string,
): ClaudeUsageLimit['scope'] {
  if (value === null || value === undefined) {
    return null;
  }
  if (!value || typeof value !== 'object') {
    throw new Error(
      `Claude usage field ${parentFieldName}.scope must be an object or null`,
    );
  }

  const scope = value as Record<string, unknown>;
  const model = scope.model;
  if (model === null || model === undefined) {
    return { model: null };
  }
  if (!model || typeof model !== 'object') {
    throw new Error(
      `Claude usage field ${parentFieldName}.scope.model must be an object or null`,
    );
  }

  const modelRecord = model as Record<string, unknown>;
  if (
    (modelRecord.id !== null && typeof modelRecord.id !== 'string') ||
    typeof modelRecord.display_name !== 'string'
  ) {
    throw new Error(
      `Claude usage field ${parentFieldName}.scope.model must contain a string or null id and a string display_name`,
    );
  }

  return {
    model: {
      id: modelRecord.id,
      display_name: modelRecord.display_name,
    },
  };
}

function normalizeNullableNumber(
  value: unknown,
  fieldName: string,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Claude usage field ${fieldName} must be a number or null`);
  }

  return value;
}

function normalizeNullableString(
  value: unknown,
  fieldName: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Claude usage field ${fieldName} must be a string or null`);
  }

  return value;
}

async function readResponseError(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  if (!text) {
    return '';
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === 'string') {
      return error;
    }
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') {
        return message;
      }
    }
    if (typeof parsed.message === 'string') {
      return parsed.message;
    }
  } catch {
    // Fall back to the response text below.
  }

  return text.slice(0, 500);
}
