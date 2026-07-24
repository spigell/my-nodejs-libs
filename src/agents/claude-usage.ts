import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_USAGE_ENDPOINT =
  'https://api.anthropic.com/api/oauth/usage';

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
};

type ClaudeCredentials = {
  claudeAiOauth?: {
    accessToken?: unknown;
  };
};

export async function getClaudeUsage(
  options: GetClaudeUsageOptions = {},
): Promise<ClaudeUsage> {
  const accessToken =
    options.accessToken?.trim() ||
    (await readClaudeAccessToken(options.credentialsPath));
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const response = await fetchImplementation(
    options.endpoint ?? CLAUDE_USAGE_ENDPOINT,
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
        'user-agent': options.userAgent?.trim() || 'claude-code/2.1.0',
      },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

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

async function readClaudeAccessToken(
  credentialsPath = resolveClaudeCredentialsPath(),
): Promise<string> {
  let content: string;
  try {
    content = await fs.readFile(credentialsPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read Claude credentials at ${credentialsPath}`, {
      cause: error,
    });
  }

  let credentials: ClaudeCredentials;
  try {
    credentials = JSON.parse(content) as ClaudeCredentials;
  } catch (error) {
    throw new Error(
      `Claude credentials at ${credentialsPath} are not valid JSON`,
      { cause: error },
    );
  }

  const accessToken = credentials.claudeAiOauth?.accessToken;
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error(
      `Claude credentials at ${credentialsPath} do not contain claudeAiOauth.accessToken`,
    );
  }

  return accessToken.trim();
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
