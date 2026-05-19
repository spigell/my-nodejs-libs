import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type {
  CliAdapter,
  CliBuildArgs,
  EngineOutcome,
  EngineState,
  TokenUsage,
} from './protocol.js';

export type CliRunnerLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
};

export type CliRunnerArgs = {
  command: string;
  adapter: CliAdapter;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  logger?: CliRunnerLogger;
};

export type ExecutionResult = {
  text: string;
  tokenUsage?: TokenUsage;
  sessionId?: string;
  durationMs: number;
  warnings: string[];
};

export type CliRunOptions = {
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
  includeDirectories?: readonly string[];
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type JsonlParser = {
  write(chunk: unknown): void;
  end(): void;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_LIMIT_BYTES = 8 * 1024;

const defaultLogger: CliRunnerLogger = {
  info(message: string, meta?: Record<string, unknown>) {
    if (meta) {
      console.info(`[CliRunner] ${message}`, meta);
      return;
    }

    console.info(`[CliRunner] ${message}`);
  },
};

export class CliRunner {
  private readonly args: CliRunnerArgs;

  constructor(args: CliRunnerArgs) {
    this.args = args;
  }

  async run(
    prompt: string,
    options?: CliRunOptions | string,
  ): Promise<ExecutionResult> {
    const timeoutMs = this.args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    const logger = this.args.logger ?? defaultLogger;
    const normalizedOptions =
      typeof options === 'string' ? { sessionId: options } : (options ?? {});
    const buildArgs: CliBuildArgs = { prompt };
    if (normalizedOptions.sessionId !== undefined) {
      buildArgs.sessionId = normalizedOptions.sessionId;
    }
    if (normalizedOptions.model !== undefined) {
      buildArgs.model = normalizedOptions.model;
    }
    if (normalizedOptions.includeDirectories !== undefined) {
      buildArgs.includeDirectories = normalizedOptions.includeDirectories;
    }
    const cliArgs = this.args.adapter.buildCliArgs(buildArgs);

    logger.info('spawn_start', {
      command: this.args.command,
      cwd: this.args.cwd,
      session_id: normalizedOptions.sessionId ?? null,
      model: normalizedOptions.model ?? null,
      argv: cliArgs,
    });

    if (!path.isAbsolute(this.args.cwd)) {
      throw new Error(
        `The provided cwd "${this.args.cwd}" is wrong and must be an absolute path.`,
      );
    }

    if (!fs.existsSync(this.args.cwd)) {
      throw new Error(`The provided cwd "${this.args.cwd}" does not exist.`);
    }

    normalizedOptions.signal?.throwIfAborted();

    const child = spawn(this.args.command, cliArgs, {
      cwd: this.args.cwd,
      env: {
        ...process.env,
        ...(this.args.env || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    logger.info('spawned', {
      command: this.args.command,
      pid: child.pid ?? null,
      cwd: this.args.cwd,
    });

    const state: EngineState = {
      finalResult: null as unknown,
      lastAssistantText: '',
    };

    const parserWarnings: string[] = [];
    const parser = createJsonlParser({
      onLine: (event) => {
        this.args.adapter.consumeEvent(state, event);
      },
      onInvalidLine: (line) => {
        parserWarnings.push(line);
      },
    });

    let stderr = '';
    let rawStdoutTail = '';
    let rawStderrTail = '';
    let killedByTimeout = false;
    let killedByAbortSignal = false;
    let abortReason: string | null = null;

    const timeoutHandle = setTimeout(() => {
      killedByTimeout = true;
      stderr = `${this.args.command} timed out after ${timeoutMs}ms`;
      child.kill('SIGTERM');
    }, timeoutMs);

    const abortHandler = () => {
      killedByAbortSignal = true;
      abortReason = `${this.args.command} aborted`;
      child.kill('SIGTERM');
    };

    normalizedOptions.signal?.addEventListener('abort', abortHandler, {
      once: true,
    });

    child.stdout.on('data', (chunk) => {
      const text = normalizeChunk(chunk);
      normalizedOptions.onStdout?.(text);
      rawStdoutTail = appendOutputTail(rawStdoutTail, text);

      const inspectionError = this.args.adapter.inspectRawOutput?.({
        stream: 'stdout',
        text,
      });
      if (inspectionError && !abortReason) {
        abortReason = inspectionError;
        child.kill('SIGTERM');
        return;
      }

      try {
        parser.write(chunk);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr = `${this.args.command} stream parse error: ${message}`;
        abortReason = stderr;
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = normalizeChunk(chunk);
      normalizedOptions.onStderr?.(text);
      stderr += text;
      rawStderrTail = appendOutputTail(rawStderrTail, text);

      const inspectionError = this.args.adapter.inspectRawOutput?.({
        stream: 'stderr',
        text,
      });
      if (inspectionError && !abortReason) {
        abortReason = inspectionError;
        child.kill('SIGTERM');
      }
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });

    logger.info('spawn_close', {
      command: this.args.command,
      pid: child.pid ?? null,
      exit_code: exitCode,
      duration_ms: Date.now() - start,
      aborted: abortReason !== null,
      timed_out: killedByTimeout,
      derived_session_id: state.sessionId ?? null,
    });

    clearTimeout(timeoutHandle);
    normalizedOptions.signal?.removeEventListener('abort', abortHandler);

    if (killedByTimeout) {
      throw new Error(
        formatRunnerError({
          detail: stderr || `${this.args.command} timed out`,
          stdout: rawStdoutTail,
          stderr: rawStderrTail,
        }),
      );
    }

    if (killedByAbortSignal) {
      throw new Error(
        formatRunnerError({
          detail: abortReason ?? `${this.args.command} aborted`,
          stdout: rawStdoutTail,
          stderr: rawStderrTail,
          exitCode,
        }),
      );
    }

    if (abortReason) {
      throw new Error(
        formatRunnerError({
          detail: abortReason,
          stdout: rawStdoutTail,
          stderr: rawStderrTail,
          exitCode,
        }),
      );
    }

    try {
      parser.end();
      const outcome = this.args.adapter.finalize(state);
      if (!outcome.ok) {
        throw new Error(formatEngineOutcomeError(this.args.command, outcome));
      }

      return {
        text: outcome.text,
        durationMs: Date.now() - start,
        warnings: parserWarnings,
        ...(outcome.usage ? { tokenUsage: outcome.usage } : {}),
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = shouldPreferStructuredError(message)
        ? message
        : stderr.trim() || message || `${this.args.command} wrapper failed`;
      if (shouldSuppressErrorTails(detail)) {
        throw new Error(detail, {
          cause: error,
        });
      }
      throw new Error(
        formatRunnerError({
          detail,
          stdout: rawStdoutTail,
          stderr: rawStderrTail,
          ...(exitCode !== 0 ? { exitCode } : {}),
        }),
        {
          cause: error,
        },
      );
    }
  }
}

function formatEngineOutcomeError(
  command: string,
  outcome: Extract<EngineOutcome, { ok: false }>,
): string {
  if (outcome.errorType === 'FatalTurnLimitedError') {
    return `${outcome.errorType}: ${outcome.error}`;
  }

  return outcome.error || `${command} call failed`;
}

function shouldPreferStructuredError(message: string): boolean {
  return message.startsWith('FatalTurnLimitedError:');
}

function shouldSuppressErrorTails(message: string): boolean {
  return shouldPreferStructuredError(message);
}

function normalizeChunk(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
}

function appendOutputTail(current: string, next: string): string {
  const combined = `${current}${next}`;
  return combined.length > OUTPUT_TAIL_LIMIT_BYTES
    ? combined.slice(-OUTPUT_TAIL_LIMIT_BYTES)
    : combined;
}

function formatRunnerError(args: {
  detail: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
}): string {
  const lines = [args.detail];
  if (args.exitCode !== undefined) {
    lines[0] = `${lines[0]} (exit ${args.exitCode})`;
  }
  if (args.stdout.trim()) {
    lines.push('', '[stdout tail]', args.stdout.trimEnd());
  }
  if (args.stderr.trim()) {
    lines.push('', '[stderr tail]', args.stderr.trimEnd());
  }
  return lines.join('\n');
}

export function createJsonlParser(args: {
  onLine: (event: unknown) => void;
  onInvalidLine: (line: string) => void;
}): JsonlParser {
  const state = { buffer: '' };
  const parseLine = (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      args.onInvalidLine(line);
      return;
    }

    args.onLine(parsed);
  };

  return {
    write(chunk: unknown) {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk);
      state.buffer += text;

      while (true) {
        const newlineIndex = state.buffer.indexOf('\n');
        if (newlineIndex === -1) {
          break;
        }

        const line = state.buffer.slice(0, newlineIndex).trim();
        state.buffer = state.buffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }

        parseLine(line);
      }
    },
    end() {
      const line = state.buffer.trim();
      if (!line) {
        return;
      }

      parseLine(line);
    },
  };
}
