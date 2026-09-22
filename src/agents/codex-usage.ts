import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CODEX_USAGE_ENDPOINT =
  'https://chatgpt.com/backend-api/wham/usage';

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
};

type JsonObject = Record<string, unknown>;

type CodexCredentials = {
  accessToken: string;
  accountId: string;
};

export async function getCodexUsage(
  options: GetCodexUsageOptions = {},
): Promise<CodexUsage> {
  const explicitAccessToken = options.accessToken?.trim();
  const explicitAccountId = options.accountId?.trim();
  if (Boolean(explicitAccessToken) !== Boolean(explicitAccountId)) {
    throw new Error(
      'Codex accessToken and accountId must be provided together',
    );
  }

  const credentials =
    explicitAccessToken && explicitAccountId
      ? {
          accessToken: explicitAccessToken,
          accountId: explicitAccountId,
        }
      : await readCodexCredentials(options.authPath);
  const response = await (options.fetch ?? globalThis.fetch)(
    options.endpoint ?? CODEX_USAGE_ENDPOINT,
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credentials.accessToken}`,
        'chatgpt-account-id': credentials.accountId,
        ...(options.userAgent ? { 'user-agent': options.userAgent } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

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
): Promise<CodexCredentials> {
  let content: string;
  try {
    content = await fs.readFile(authPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read Codex credentials at ${authPath}`, {
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
    throw new Error(`Codex credentials at ${authPath} are not valid JSON`, {
      cause: error,
    });
  }

  const tokens = document.tokens;
  if (!isJsonObject(tokens)) {
    throw new Error(
      `Codex credentials at ${authPath} do not contain a tokens object`,
    );
  }
  const accessToken = tokens.access_token;
  const accountId = tokens.account_id;
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error(
      `Codex credentials at ${authPath} do not contain tokens.access_token`,
    );
  }
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new Error(
      `Codex credentials at ${authPath} do not contain tokens.account_id`,
    );
  }

  return {
    accessToken: accessToken.trim(),
    accountId: accountId.trim(),
  };
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
