import type {
  CliAdapter,
  CliBuildArgs,
  EngineOutcome,
  EngineState,
  TokenUsage,
} from './protocol.js';

/**
 * Agy tags every NDJSON line with `event` and nests that event's payload under
 * a key of the same name: `{"event":"result","result":{...}}`. This differs
 * from the Gemini CLI, which uses `type` and a flat payload, so the two
 * adapters cannot share a parser.
 *
 * Shapes here were read off agy 1.2.7 output, not from its documentation.
 */
type AgyEvent = {
  event: string;
  [key: string]: unknown;
};

/** The terminal event. Its `usage` block is the only token accounting agy emits. */
type AgyResult = {
  conversation_id?: string;
  status?: string;
  response?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: Record<string, unknown>;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Maps agy's usage block onto `TokenUsage`.
 *
 * `thinking_tokens` is kept separate rather than folded into `output`: agy
 * reports them apart, and merging them would make a reasoning-heavy run
 * indistinguishable from a verbose one.
 */
function normalizeUsage(usage: unknown): TokenUsage | null {
  const obj = asRecord(usage);
  if (!obj) {
    return null;
  }

  const normalized: TokenUsage = {};
  const input = asNumber(obj.input_tokens);
  const output = asNumber(obj.output_tokens);
  const thinking = asNumber(obj.thinking_tokens);
  const cached = asNumber(obj.cache_read_tokens);
  const total = asNumber(obj.total_tokens);

  if (input !== undefined) {
    normalized.input = input;
  }
  if (output !== undefined) {
    normalized.output = output;
  }
  if (thinking !== undefined) {
    normalized.thinking = thinking;
  }
  if (cached !== undefined) {
    normalized.cached = cached;
  }
  if (total !== undefined) {
    normalized.total = total;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

/**
 * Only `SUCCESS` counts as success. Agy's failure vocabulary has not been
 * observed, so anything else is treated as a failure rather than matched
 * against a guessed list of error strings.
 */
function isSuccessStatus(status: unknown): boolean {
  return typeof status === 'string' && status.trim().toUpperCase() === 'SUCCESS';
}

export const agyAdapter: CliAdapter = {
  name: 'agy',
  outputMode: 'jsonl',
  buildCliArgs(args: CliBuildArgs) {
    const printTimeoutMs = args.printTimeoutMs ?? 10 * 60 * 1000;
    const cliArgs = [
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '-p',
      args.prompt,
      '--print-timeout',
      `${printTimeoutMs}ms`,
    ];

    if (args.sessionId) {
      cliArgs.push('--conversation', args.sessionId);
    }

    return cliArgs;
  },
  consumeEvent(state: EngineState, event: unknown) {
    const obj = asRecord(event) as AgyEvent | undefined;
    if (!obj || typeof obj.event !== 'string') {
      return;
    }

    // Both `init` and `result` carry the conversation id, so a run stays
    // resumable even when it fails before producing a result.
    const payload = asRecord(obj[obj.event]);
    const conversationId = payload?.conversation_id ?? obj.conversation_id;
    if (
      !state.sessionId &&
      typeof conversationId === 'string' &&
      conversationId.trim()
    ) {
      state.sessionId = conversationId;
    }

    // Incremental assistant text. Agy streams a turn as `step_update` events
    // carrying a `text_delta`, so the deltas are concatenated rather than
    // replaced. The closing step (state DONE) also carries that step's usage.
    if (obj.event === 'step_update') {
      const delta = payload?.text_delta;
      if (typeof delta === 'string' && delta) {
        state.lastAssistantText += delta;
      }
      // The closing step carries this turn's own usage. Keep it: the terminal
      // result reports a conversation-wide total instead.
      const stepUsage = normalizeUsage(payload?.usage);
      if (stepUsage) {
        state.perTurnUsage = stepUsage;
      }
      return;
    }

    if (obj.event === 'result') {
      state.finalResult = payload ?? obj;
      // The result repeats the whole response, so it replaces the accumulated
      // deltas: it is authoritative, and trusting it keeps the text correct
      // even when a delta was dropped.
      const response = payload?.response;
      if (typeof response === 'string' && response.trim()) {
        state.lastAssistantText = response;
      }
    }
  },
  finalize(state: EngineState): EngineOutcome {
    const result = asRecord(state.finalResult) as AgyResult | undefined;
    if (!result) {
      return {
        ok: false,
        error:
          'Agy produced no terminal result event; the run was cut short before it reported a status',
      };
    }

    if (!isSuccessStatus(result.status)) {
      return {
        ok: false,
        error: `Agy run finished with status ${
          typeof result.status === 'string' && result.status.trim()
            ? result.status
            : '<missing>'
        }`,
        ...(typeof result.status === 'string' && result.status.trim()
          ? { errorType: result.status.trim() }
          : {}),
      };
    }

    const text = (state.lastAssistantText || '').trim();
    if (!text) {
      // A turn that hit the print timeout still reports SUCCESS with an empty
      // response and a zeroed usage block, so an empty response is a failure
      // rather than an empty-but-valid answer.
      return {
        ok: false,
        error:
          'Agy reported SUCCESS but returned an empty response, which is what a print timeout looks like',
      };
    }

    return {
      ok: true,
      text,
      // Per-turn usage wins over the result's block. Measured on agy 1.2.7: a
      // second turn reported input 19092 while the result said 36682, exactly
      // turn one plus turn two. Billing a resumed run from the result would
      // re-charge every earlier turn.
      usage: state.perTurnUsage ?? normalizeUsage(result.usage),
    };
  },
};
