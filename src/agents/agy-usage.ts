import { spawn as defaultSpawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

export const AGY_USAGE_COMMAND = 'agy';
export const AGY_USAGE_ARGS = [
  '-p',
  '/usage',
  '--dangerously-skip-permissions',
  '--output-format',
  'stream-json',
] as const;

/**
 * `/usage` is answered locally by the CLI: it reports `num_turns: 0` and
 * `total_tokens: 0`, so polling it consumes no model quota. It does cost a
 * process spawn plus auth (~3.5s measured on 1.2.7), which is why callers must
 * cache rather than call it per candidate agent.
 */
export const AGY_USAGE_DEFAULT_TIMEOUT_MS = 30_000;

export const AGY_MODEL_FAMILIES = ['gemini', 'argon', 'claude', 'gpt'] as const;
export type AgyModelFamily = (typeof AGY_MODEL_FAMILIES)[number];

export const AGY_WINDOW_NAMES: Record<string, string> = {
  '18000': 'five_hour',
  '604800': 'seven_day',
  '5h': 'five_hour',
  weekly: 'seven_day',
};

export function normalizeAgyWindow(window: string): string {
  return AGY_WINDOW_NAMES[window] ?? window;
}

export type AgyUsageBucket = {
  id: string;
  name: string;
  window: string;
  /** Normalized window identifier ('five_hour' | 'seven_day' | raw window). */
  normalized_window: string;
  /** agy's own polarity: 1 = full headroom, 0 = exhausted. */
  remaining_fraction: number;
  /** Absolute ISO-8601, unlike Codex which reports seconds-until-reset. */
  reset_time: string;
  limit_reached: boolean;
};

export type AgyUsageGroup = {
  name: string;
  /**
   * Recognized model families drawing on this group (e.g. ['gemini'],
   * ['argon'], or ['claude', 'gpt']).
   */
  families: AgyModelFamily[];
  /** Parsed from the group description; empty when agy stops emitting it. */
  models: string[];
  buckets: AgyUsageBucket[];
  /** Five-hour rate limit window bucket, or null when the provider has none. */
  five_hour: AgyUsageBucket | null;
  /** Seven-day / weekly rate limit window bucket, or null when the provider has none. */
  seven_day: AgyUsageBucket | null;
};

export type AgyFamilyUsage = {
  family: AgyModelFamily;
  group_name: string;
  models: string[];
  /** Five-hour rate limit window bucket, or null when the provider has none. */
  five_hour: AgyUsageBucket | null;
  /** Seven-day / weekly rate limit window bucket, or null when the provider has none. */
  seven_day: AgyUsageBucket | null;
};

export type AgyUsage = {
  agent: 'agy';
  groups: AgyUsageGroup[];
  /**
   * Normalized view by model family. A missing quota window remains null
   * (never synthetic 0 or 100%).
   */
  families: Record<AgyModelFamily, AgyFamilyUsage | null>;
};

export type GetAgyUsageOptions = {
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  spawn?: typeof defaultSpawn;
};

type JsonObject = Record<string, unknown>;

export async function getAgyUsage(
  options: GetAgyUsageOptions = {},
): Promise<AgyUsage> {
  const stdout = await runAgyUsageCommand(options);
  return parseAgyUsage(stdout);
}

/**
 * Pull the quota payload out of agy's stream-json output.
 *
 * Only the first `command_result` line is read. The trailing `result` line
 * repeats the identical payload alongside a pre-rendered text summary, so
 * parsing both is wasted work.
 */
export function parseAgyUsage(stdout: string): AgyUsage {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isJsonObject(parsed) || parsed.event !== 'command_result') {
      continue;
    }
    const command = parsed.command;
    if (!isJsonObject(command)) {
      throw new Error('Agy usage command_result is missing a command object');
    }
    const data = command.data;
    if (!isJsonObject(data)) {
      throw new Error('Agy usage command_result is missing command.data');
    }
    const groups = normalizeGroups(data.groups);
    return {
      agent: 'agy',
      groups,
      families: buildFamilyMap(groups),
    };
  }

  throw new Error(
    'Agy usage output did not contain a command_result event line',
  );
}

function runAgyUsageCommand(options: GetAgyUsageOptions): Promise<string> {
  const spawnFn = options.spawn ?? defaultSpawn;
  const command = options.command ?? AGY_USAGE_COMMAND;
  const args = [...(options.args ?? AGY_USAGE_ARGS)];
  const timeoutMs = options.timeoutMs ?? AGY_USAGE_DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    };
    const child = spawnFn(command, args, spawnOptions);

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error: Error | undefined, value?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
        return;
      }
      resolve(value ?? '');
    };

    // A hung `/usage` must degrade to the caller's failure policy, never block
    // the poll loop. SIGKILL follows SIGTERM because the CLI is a wrapper and
    // has been reported to ignore a polite stop while printing.
    const killChild = () => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 2_000).unref?.();
    };

    const timer = setTimeout(() => {
      killChild();
      finish(new Error(`Agy usage command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      killChild();
      finish(new Error('Agy usage command was aborted'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => {
      finish(
        new Error(`Failed to run "${command}": ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        finish(undefined, stdout);
        return;
      }
      const detail = stderr.trim().slice(0, 500);
      finish(
        new Error(
          `Agy usage command exited with code ${code}${detail ? `: ${detail}` : ''}`,
        ),
      );
    });
  });
}

function normalizeGroups(value: unknown): AgyUsageGroup[] {
  if (!Array.isArray(value)) {
    throw new Error('Agy usage field groups must be an array');
  }
  return value.map((group, index) => normalizeGroup(group, `groups[${index}]`));
}

function normalizeGroup(value: unknown, fieldName: string): AgyUsageGroup {
  if (!isJsonObject(value)) {
    throw new Error(`Agy usage field ${fieldName} must be an object`);
  }
  const name = readString(value.name, `${fieldName}.name`);
  const models = parseGroupModels(value.description);
  const buckets = normalizeBuckets(value.buckets, `${fieldName}.buckets`);
  const families = resolveAgyFamilies(name, value.description, buckets, models);

  const fiveHour =
    buckets.find((bucket) => bucket.normalized_window === 'five_hour') ?? null;
  const sevenDay =
    buckets.find((bucket) => bucket.normalized_window === 'seven_day') ?? null;

  return {
    name,
    families,
    models,
    buckets,
    five_hour: fiveHour,
    seven_day: sevenDay,
  };
}

function normalizeBuckets(value: unknown, fieldName: string): AgyUsageBucket[] {
  if (!Array.isArray(value)) {
    throw new Error(`Agy usage field ${fieldName} must be an array`);
  }
  return value.map((bucket, index) =>
    normalizeBucket(bucket, `${fieldName}[${index}]`),
  );
}

function normalizeBucket(value: unknown, fieldName: string): AgyUsageBucket {
  if (!isJsonObject(value)) {
    throw new Error(`Agy usage field ${fieldName} must be an object`);
  }
  const rawWindow = readString(value.window, `${fieldName}.window`);
  const remainingFraction = readFiniteNumber(
    value.remaining_fraction,
    `${fieldName}.remaining_fraction`,
  );
  return {
    id: readString(value.id, `${fieldName}.id`),
    name: typeof value.name === 'string' ? value.name : '',
    window: rawWindow,
    normalized_window: normalizeAgyWindow(rawWindow),
    remaining_fraction: remainingFraction,
    reset_time: readString(value.reset_time, `${fieldName}.reset_time`),
    limit_reached: remainingFraction <= 0,
  };
}

/**
 * Group descriptions read "Models within this group: Gemini Flash, Gemini Pro".
 * The model list matters because quota is per group, so a gate has to know
 * which group the configured model draws on.
 */
function parseGroupModels(value: unknown): string[] {
  if (typeof value === 'string') {
    const marker = 'Models within this group:';
    const markerIndex = value.indexOf(marker);
    if (markerIndex !== -1) {
      let rest = value.slice(markerIndex + marker.length).trim();
      const lineEnd = rest.indexOf('\n');
      if (lineEnd !== -1) {
        rest = rest.slice(0, lineEnd).trim();
      }
      const sentenceEnd = rest.search(/[;.](?:\s+|\s*$)/);
      if (sentenceEnd !== -1) {
        rest = rest.slice(0, sentenceEnd);
      }
      return rest
        .split(',')
        .map((model) => model.trim().replace(/\.$/, ''))
        .filter(Boolean);
    }
  }
  return [];
}

export function resolveAgyFamilies(
  name: string,
  description?: unknown,
  buckets?: readonly { id?: string; name?: string }[],
  models?: readonly string[],
): AgyModelFamily[] {
  const groupModels =
    models && models.length > 0 ? models : parseGroupModels(description);

  const families: AgyModelFamily[] = [];
  const addFamily = (family: AgyModelFamily) => {
    if (!families.includes(family)) {
      families.push(family);
    }
  };

  if (groupModels.length > 0) {
    for (const model of groupModels) {
      const lower = model.toLowerCase();
      if (lower.includes('argon')) {
        addFamily('argon');
      } else if (lower.includes('gemini')) {
        addFamily('gemini');
      }
      if (lower.includes('claude')) {
        addFamily('claude');
      }
      if (lower.includes('gpt')) {
        addFamily('gpt');
      }
    }
  }

  const lowerName = name.toLowerCase();
  if (lowerName.includes('argon')) {
    addFamily('argon');
  } else if (lowerName.includes('gemini') && !families.includes('argon')) {
    addFamily('gemini');
  }

  if (lowerName.includes('claude')) {
    addFamily('claude');
  }
  if (lowerName.includes('gpt')) {
    addFamily('gpt');
  }
  if (
    families.length === 0 &&
    (lowerName.includes('3p') ||
      lowerName.includes('third party') ||
      lowerName.includes('third-party'))
  ) {
    addFamily('claude');
    addFamily('gpt');
  }

  if (families.length === 0 && buckets && buckets.length > 0) {
    const bucketText = buckets
      .map((b) => `${b.id ?? ''} ${b.name ?? ''}`)
      .join(' ')
      .toLowerCase();

    if (bucketText.includes('argon')) {
      addFamily('argon');
    } else if (bucketText.includes('gemini')) {
      addFamily('gemini');
    }
    if (bucketText.includes('claude')) {
      addFamily('claude');
    }
    if (bucketText.includes('gpt')) {
      addFamily('gpt');
    }
    if (
      families.length === 0 &&
      (bucketText.includes('3p') ||
        bucketText.includes('third party') ||
        bucketText.includes('third-party'))
    ) {
      addFamily('claude');
      addFamily('gpt');
    }
  }

  return families;
}

/** Prefer a quota group that names the family itself over a group that merely lists its models. */
export function agyFamilyGroups(
  groups: readonly AgyUsageGroup[],
): Map<AgyModelFamily, AgyUsageGroup> {
  const owners = new Map<AgyModelFamily, AgyUsageGroup>();
  const scores = new Map<AgyModelFamily, number>();
  for (const group of groups) {
    for (const family of group.families) {
      const nameMatches = group.name.toLowerCase().includes(family);
      const bucketMatches = group.buckets.some((bucket) =>
        bucket.id.toLowerCase().includes(family),
      );
      const score = nameMatches ? 2 : bucketMatches ? 1 : 0;
      if (!owners.has(family) || score > (scores.get(family) ?? -1)) {
        owners.set(family, group);
        scores.set(family, score);
      }
    }
  }
  return owners;
}

function buildFamilyMap(
  groups: readonly AgyUsageGroup[],
): Record<AgyModelFamily, AgyFamilyUsage | null> {
  const result: Record<AgyModelFamily, AgyFamilyUsage | null> = {
    gemini: null,
    argon: null,
    claude: null,
    gpt: null,
  };

  for (const [family, group] of agyFamilyGroups(groups)) {
    result[family] = {
      family,
      group_name: group.name,
      models: group.models,
      five_hour: group.five_hour,
      seven_day: group.seven_day,
    };
  }

  return result;
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Agy usage field ${fieldName} must be a non-empty string`);
  }
  return value;
}

function readFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Agy usage field ${fieldName} must be a finite number`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
