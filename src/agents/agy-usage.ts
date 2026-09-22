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

export type AgyUsageBucket = {
  id: string;
  name: string;
  window: string;
  /** agy's own polarity: 1 = full headroom, 0 = exhausted. */
  remaining_fraction: number;
  /** Absolute ISO-8601, unlike Codex which reports seconds-until-reset. */
  reset_time: string;
  limit_reached: boolean;
};

export type AgyUsageGroup = {
  name: string;
  /** Parsed from the group description; empty when agy stops emitting it. */
  models: string[];
  buckets: AgyUsageBucket[];
};

export type AgyUsage = {
  agent: 'agy';
  groups: AgyUsageGroup[];
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
    return {
      agent: 'agy',
      groups: normalizeGroups(data.groups),
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
      finish(
        new Error(`Agy usage command timed out after ${timeoutMs}ms`),
      );
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
  return {
    name: readString(value.name, `${fieldName}.name`),
    models: parseGroupModels(value.description),
    buckets: normalizeBuckets(value.buckets, `${fieldName}.buckets`),
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
  const remainingFraction = readFiniteNumber(
    value.remaining_fraction,
    `${fieldName}.remaining_fraction`,
  );
  return {
    id: readString(value.id, `${fieldName}.id`),
    name: typeof value.name === 'string' ? value.name : '',
    window: readString(value.window, `${fieldName}.window`),
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
  if (typeof value !== 'string') {
    return [];
  }
  const marker = 'Models within this group:';
  const markerIndex = value.indexOf(marker);
  if (markerIndex === -1) {
    return [];
  }
  return value
    .slice(markerIndex + marker.length)
    .split(',')
    .map((model) => model.trim().replace(/\.$/, ''))
    .filter(Boolean);
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
