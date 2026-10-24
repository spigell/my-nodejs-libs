import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type {
  CliAdapter,
  CliBuildArgs,
  CliPermissionDenial,
  CliPermissionMode,
  CliReasoningEffort,
  EngineOutcome,
  EngineState,
  ModelUsage,
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
  /**
   * How long the process gets to exit after SIGTERM before it is sent SIGKILL.
   * Without it, a CLI that deadlocks on shutdown holds the run open forever.
   */
  killGraceMs?: number;
  /**
   * How long the process gets to exit by itself once the adapter reports a
   * complete result, before it is terminated.
   */
  resultExitGraceMs?: number;
  logger?: CliRunnerLogger;
  /**
   * Called for each parsed event as it streams in, before the adapter sees it.
   *
   * Lets a caller forward live progress somewhere without waiting for the run
   * to finish. It must never throw: a subscriber's failure is not the run's
   * failure, so exceptions are caught and logged rather than propagated.
   */
  onEvent?: (event: unknown) => void;
};

export type ExecutionResult = {
  text: string;
  /** The whole run's token usage, not its final API call. */
  tokenUsage?: TokenUsage;
  /** What the run cost, as the engine reported it. Absent when the engine
   * reports no cost. */
  costUsd?: number;
  /** The run's usage split by model. Absent when the engine reports no
   * breakdown. */
  modelUsage?: ModelUsage[];
  permissionDenials?: CliPermissionDenial[];
  sessionId?: string;
  durationMs: number;
  warnings: string[];
};

export type CliRunOptions = {
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
  includeDirectories?: readonly string[];
  reasoningEffort?: CliReasoningEffort;
  mcpConfigPath?: string;
  strictMcpConfig?: boolean;
  tools?: readonly string[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  permissionMode?: CliPermissionMode;
  dangerouslySkipPermissions?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  printTimeoutMs?: number;
};

export type JsonlParser = {
  write(chunk: unknown): void;
  end(): void;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 30 * 1000;
const DEFAULT_RESULT_EXIT_GRACE_MS = 30 * 1000;
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
    const killGraceMs = this.args.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const resultExitGraceMs =
      this.args.resultExitGraceMs ?? DEFAULT_RESULT_EXIT_GRACE_MS;
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
    buildArgs.printTimeoutMs = normalizedOptions.printTimeoutMs ?? timeoutMs;
    if (normalizedOptions.includeDirectories !== undefined) {
      buildArgs.includeDirectories = normalizedOptions.includeDirectories;
    }
    if (normalizedOptions.reasoningEffort !== undefined) {
      buildArgs.reasoningEffort = normalizedOptions.reasoningEffort;
    }
    if (normalizedOptions.mcpConfigPath !== undefined) {
      buildArgs.mcpConfigPath = normalizedOptions.mcpConfigPath;
    }
    if (normalizedOptions.strictMcpConfig !== undefined) {
      buildArgs.strictMcpConfig = normalizedOptions.strictMcpConfig;
    }
    if (this.args.env?.CLAUDE_SYSTEM_PROMPT_FILE !== undefined) {
      buildArgs.systemPromptFile = this.args.env.CLAUDE_SYSTEM_PROMPT_FILE;
    }
    if (normalizedOptions.tools !== undefined) {
      buildArgs.tools = normalizedOptions.tools;
    }
    if (normalizedOptions.allowedTools !== undefined) {
      buildArgs.allowedTools = normalizedOptions.allowedTools;
    }
    if (normalizedOptions.disallowedTools !== undefined) {
      buildArgs.disallowedTools = normalizedOptions.disallowedTools;
    }
    if (normalizedOptions.permissionMode !== undefined) {
      buildArgs.permissionMode = normalizedOptions.permissionMode;
    }
    if (normalizedOptions.dangerouslySkipPermissions !== undefined) {
      buildArgs.dangerouslySkipPermissions =
        normalizedOptions.dangerouslySkipPermissions;
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
      finalResult: null,
      lastAssistantText: '',
      rawStdout: '',
      rawStderr: '',
    };

    let stderr = '';
    let rawStdoutTail = '';
    let rawStderrTail = '';
    let stdoutDiagnosticTail = '';
    let stderrDiagnosticTail = '';
    let killedByTimeout = false;
    let killedByAbortSignal = false;
    let abortReason: string | null = null;
    let resultCompleted = false;
    let killHandle: NodeJS.Timeout | undefined;
    let resultExitHandle: NodeJS.Timeout | undefined;
    // SIGTERM alone is not enough: a CLI that deadlocks while shutting down
    // never exits, and the run would wait on it forever.
    const terminate = (): void => {
      child.kill('SIGTERM');
      killHandle ??= setTimeout(() => {
        logger.info('spawn_kill', {
          command: this.args.command,
          pid: child.pid ?? null,
          grace_ms: killGraceMs,
        });
        child.kill('SIGKILL');
      }, killGraceMs);
    };
    const applyDiagnosticInspection = (
      stream: 'stdout' | 'stderr',
      text: string,
    ): void => {
      if (!this.args.adapter.inspectRawOutput) {
        return;
      }

      const inspectionError = this.args.adapter.inspectRawOutput({
        stream,
        text,
      });
      if (inspectionError && !abortReason) {
        abortReason = inspectionError;
        terminate();
      }
    };
    const inspectDiagnostic = (
      stream: 'stdout' | 'stderr',
      text: string,
    ): void => {
      if (stream === 'stdout') {
        stdoutDiagnosticTail = appendOutputTail(stdoutDiagnosticTail, text);
      } else {
        stderrDiagnosticTail = appendOutputTail(stderrDiagnosticTail, text);
      }
      applyDiagnosticInspection(
        stream,
        stream === 'stdout' ? stdoutDiagnosticTail : stderrDiagnosticTail,
      );
    };
    const outputMode = this.args.adapter.outputMode ?? 'jsonl';
    const parserWarnings: string[] = [];
    const parser =
      outputMode === 'jsonl'
        ? createJsonlParser({
            onLine: (event) => {
              if (this.args.onEvent) {
                try {
                  this.args.onEvent(event);
                } catch (error) {
                  // A subscriber that throws must not kill the run: the agent's
                  // work matters more than the progress feed watching it.
                  logger.info(
                    `onEvent subscriber threw: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                }
              }
              this.args.adapter.consumeEvent(state, event);
              if (
                !resultCompleted &&
                this.args.adapter.hasCompletedResult?.(state)
              ) {
                // The turn is done; only the process exit is outstanding.
                resultCompleted = true;
                clearTimeout(timeoutHandle);
                resultExitHandle = setTimeout(() => {
                  logger.info('result_exit_timeout', {
                    command: this.args.command,
                    pid: child.pid ?? null,
                    grace_ms: resultExitGraceMs,
                  });
                  terminate();
                }, resultExitGraceMs);
              }
            },
            onInvalidLine: (line) => {
              parserWarnings.push(line);
              inspectDiagnostic('stdout', `${line}\n`);
            },
            onPendingLine: (line) => {
              if (isDefinitelyUnstructuredJsonlLine(line)) {
                applyDiagnosticInspection(
                  'stdout',
                  appendOutputTail(stdoutDiagnosticTail, line),
                );
              }
            },
          })
        : null;

    const timeoutHandle = setTimeout(() => {
      killedByTimeout = true;
      stderr = `${this.args.command} timed out after ${timeoutMs}ms`;
      terminate();
    }, timeoutMs);

    const abortHandler = () => {
      killedByAbortSignal = true;
      abortReason = `${this.args.command} aborted`;
      terminate();
    };

    normalizedOptions.signal?.addEventListener('abort', abortHandler, {
      once: true,
    });

    child.stdout.on('data', (chunk) => {
      const text = normalizeChunk(chunk);
      normalizedOptions.onStdout?.(text);
      state.rawStdout += text;
      rawStdoutTail = appendOutputTail(rawStdoutTail, text);

      if (parser) {
        try {
          parser.write(chunk);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          stderr = `${this.args.command} stream parse error: ${message}`;
          abortReason = stderr;
          terminate();
        }
      } else {
        inspectDiagnostic('stdout', text);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = normalizeChunk(chunk);
      normalizedOptions.onStderr?.(text);
      stderr += text;
      state.rawStderr += text;
      rawStderrTail = appendOutputTail(rawStderrTail, text);

      inspectDiagnostic('stderr', text);
    });

    let exitCode: number;
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 1));
      });
    } finally {
      clearTimeout(timeoutHandle);
      clearTimeout(killHandle);
      clearTimeout(resultExitHandle);
      normalizedOptions.signal?.removeEventListener('abort', abortHandler);
    }

    logger.info('spawn_close', {
      command: this.args.command,
      pid: child.pid ?? null,
      exit_code: exitCode,
      duration_ms: Date.now() - start,
      aborted: abortReason !== null,
      timed_out: killedByTimeout,
      result_completed: resultCompleted,
      derived_session_id: state.sessionId ?? null,
    });

    if (parser) {
      try {
        parser.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr = `${this.args.command} stream parse error: ${message}`;
        abortReason ??= stderr;
      }
    }

    if (killedByTimeout) {
      throw new Error(
        formatRunnerError({
          detail: stderr || `${this.args.command} timed out`,
          stdout: rawStdoutTail,
          stderr: rawStderrTail,
          exitCode,
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

    // A terminal event is not proof that the CLI exited successfully. An
    // undeclared policy also fails closed for third-party adapters. A result
    // the adapter declared complete is exempt: the runner may have killed it.
    if (
      !resultCompleted &&
      this.args.adapter.exitPolicy !== 'trust-result' &&
      exitCode !== 0
    ) {
      const diagnosticLine = [
        ...state.rawStdout.split(/\r?\n/),
        ...stderr.split(/\r?\n/),
      ].find((line) => line.includes('AGY_ERROR'));
      const diagnostic = diagnosticLine?.slice(
        diagnosticLine.indexOf('AGY_ERROR'),
        diagnosticLine.indexOf('AGY_ERROR') + 1024,
      );
      throw new Error(
        formatRunnerError({
          detail: `${this.args.adapter.name} process failed${diagnostic ? `: ${diagnostic}` : ''}`,
          stdout: rawStdoutTail,
          stderr: rawStderrTail,
          exitCode,
        }),
      );
    }

    try {
      const outcome = this.args.adapter.finalize(state);
      if (!outcome.ok) {
        throw new Error(formatEngineOutcomeError(this.args.command, outcome));
      }

      return {
        text: outcome.text,
        durationMs: Date.now() - start,
        warnings: parserWarnings,
        ...(outcome.usage ? { tokenUsage: outcome.usage } : {}),
        ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
        ...(outcome.modelUsage !== undefined
          ? { modelUsage: outcome.modelUsage }
          : {}),
        ...(outcome.permissionDenials !== undefined
          ? { permissionDenials: outcome.permissionDenials }
          : {}),
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

function isDefinitelyUnstructuredJsonlLine(line: string): boolean {
  const firstCharacter = line.trimStart()[0];
  return (
    firstCharacter !== undefined &&
    !'{["-0123456789tfn'.includes(firstCharacter)
  );
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
  onPendingLine?: (line: string) => void;
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

      if (state.buffer) {
        args.onPendingLine?.(state.buffer);
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
