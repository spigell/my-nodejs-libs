import type {
  CliAdapter,
  CliBuildArgs,
  EngineOutcome,
  EngineState,
  TokenUsage,
} from './protocol.js';

/**
 * Codex tags each NDJSON line with a top-level `type` and keeps its payload
 * flat -- unlike agy, which uses `event` plus a nested object of the same
 * name. The two cannot share a parser.
 *
 * Shapes here were read off codex-cli 0.155.1 output, not its documentation.
 */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Maps codex's usage block onto `TokenUsage`.
 *
 * `cached_input_tokens` is a subset of `input_tokens` rather than an addition
 * to it, so it is reported as `cached` and never summed into the total.
 * Measured on 0.155.1: a resumed turn reported input 20142, of which 9856
 * were cached.
 */
function normalizeUsage(usage: unknown): TokenUsage | null {
  const obj = asRecord(usage);
  if (!obj) {
    return null;
  }

  const normalized: TokenUsage = {};
  const input = asNumber(obj.input_tokens);
  const output = asNumber(obj.output_tokens);
  const cached = asNumber(obj.cached_input_tokens);
  const thinking = asNumber(obj.reasoning_output_tokens);

  if (input !== undefined) {
    normalized.input = input;
  }
  if (output !== undefined) {
    normalized.output = output;
  }
  if (cached !== undefined) {
    normalized.cached = cached;
  }
  if (thinking !== undefined) {
    normalized.thinking = thinking;
  }
  if (input !== undefined && output !== undefined) {
    normalized.total = input + output;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

export const codexAdapter: CliAdapter = {
  name: 'codex',
  outputMode: 'jsonl',
  buildCliArgs(args: CliBuildArgs) {
    // `--json` is the only way codex reports token usage, and it turns a run
    // into events that can be streamed while it is still going.
    const cliArgs = ['exec', '--json'];

    for (const directory of args.includeDirectories ?? []) {
      cliArgs.push('--add-dir', directory);
    }

    if (args.sessionId) {
      cliArgs.push('resume', args.sessionId);
    }

    // The prompt goes as a positional rather than on stdin: CliRunner does not
    // write to a child's stdin, and `codex exec` accepts either.
    cliArgs.push(args.prompt);
    return cliArgs;
  },
  consumeEvent(state: EngineState, event: unknown) {
    const obj = asRecord(event);
    if (!obj || typeof obj.type !== 'string') {
      return;
    }

    if (obj.type === 'thread.started') {
      const threadId = obj.thread_id;
      if (!state.sessionId && typeof threadId === 'string' && threadId) {
        state.sessionId = threadId;
      }
      return;
    }

    if (obj.type === 'item.completed') {
      const item = asRecord(obj.item);
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        // Codex delivers an assistant message whole rather than as deltas, so
        // the latest one replaces rather than appends.
        state.lastAssistantText = item.text;
      }
      return;
    }

    if (obj.type === 'turn.completed') {
      state.finalResult = obj;
      const usage = normalizeUsage(obj.usage);
      if (usage) {
        state.perTurnUsage = usage;
      }
      return;
    }

    if (obj.type === 'turn.failed' || obj.type === 'error') {
      state.finalResult = obj;
    }
  },
  finalize(state: EngineState): EngineOutcome {
    const result = asRecord(state.finalResult);
    if (!result) {
      return {
        ok: false,
        error:
          'Codex produced no terminal turn event; the run ended before reporting a result',
      };
    }

    if (result.type === 'turn.failed' || result.type === 'error') {
      const detail = asRecord(result.error)?.message ?? result.message;
      return {
        ok: false,
        error:
          typeof detail === 'string' && detail.trim()
            ? detail
            : 'Codex reported a failed turn',
      };
    }

    const text = (state.lastAssistantText || '').trim();
    if (!text) {
      return {
        ok: false,
        error: 'Codex completed its turn without producing an assistant message',
      };
    }

    return {
      ok: true,
      text,
      usage: state.perTurnUsage ?? normalizeUsage(result.usage),
    };
  },
};
