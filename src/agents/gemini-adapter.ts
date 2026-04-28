import type {
  CliAdapter,
  CliBuildArgs,
  EngineOutcome,
  EngineState,
  RawOutputInspectionArgs,
  TokenUsage,
} from './protocol.js';

export const DEFAULT_GEMINI_CLI_MODEL = 'gemini-3-flash-preview';

const GEMINI_OAUTH_PATTERNS = [
  'device authorization flow',
  'please visit',
  'open this url',
  'open the following url',
  'verification code',
  'waiting for authentication',
  'waiting for login',
  'login required',
  'interactive login required',
];

function inspectOAuthPrompt(
  args: RawOutputInspectionArgs,
  adapterName: string,
): string | null {
  const text = args.text.trim();
  if (!text) {
    return null;
  }

  const normalized = text.toLowerCase();
  if (!GEMINI_OAUTH_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return null;
  }

  return `${adapterName} authentication required. The CLI is waiting for interactive OAuth login.`;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          if (typeof obj.text === 'string') {
            return obj.text;
          }
          if (typeof obj.content === 'string') {
            return obj.content;
          }
        }
        return '';
      })
      .filter(Boolean);
    return parts.join('').trim();
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string') {
      return obj.text.trim();
    }
    if (typeof obj.content === 'string') {
      return obj.content.trim();
    }
    if (Array.isArray(obj.parts)) {
      return extractText(obj.parts);
    }
  }

  return '';
}

function normalizeError(input: unknown, defaultMessage: string): string {
  if (typeof input === 'string' && input.trim()) {
    return input.trim();
  }

  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      return obj.message.trim();
    }
  }

  return defaultMessage;
}

function normalizeErrorType(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const obj = input as Record<string, unknown>;
  if (typeof obj.type === 'string' && obj.type.trim()) {
    return obj.type.trim();
  }

  return undefined;
}

function normalizeUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const obj = usage as Record<string, unknown>;
  const input =
    obj.input_tokens ?? obj.input ?? obj.prompt_tokens ?? obj.inputTokenCount;
  const output =
    obj.output_tokens ??
    obj.output ??
    obj.completion_tokens ??
    obj.outputTokenCount;
  const total =
    obj.total_tokens ??
    obj.total ??
    obj.totalTokenCount ??
    (typeof input === 'number' && typeof output === 'number'
      ? input + output
      : undefined);
  const cached = obj.cached ?? obj.cached_tokens ?? obj.cache_tokens;

  const normalized: TokenUsage = {};
  if (typeof input === 'number') {
    normalized.input = input;
  }
  if (typeof output === 'number') {
    normalized.output = output;
  }
  if (typeof total === 'number') {
    normalized.total = total;
  }
  if (typeof cached === 'number') {
    normalized.cached = cached;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function maybeStoreSessionId(
  state: EngineState,
  event: Record<string, unknown>,
): void {
  if (state.sessionId) {
    return;
  }

  const sessionId = event.session_id;
  if (typeof sessionId === 'string' && sessionId.trim()) {
    state.sessionId = sessionId;
  }
}

export const geminiAdapter: CliAdapter = {
  name: 'gemini',
  buildCliArgs(args: CliBuildArgs) {
    const selectedModel = args.model?.trim() || DEFAULT_GEMINI_CLI_MODEL;
    const cliArgs = [
      '--yolo',
      '--model',
      selectedModel,
      '--output-format',
      'stream-json',
      '--prompt',
      args.prompt,
    ];

    for (const directory of args.includeDirectories ?? []) {
      cliArgs.push('--include-directories', directory);
    }

    if (args.sessionId) {
      cliArgs.push('--resume', args.sessionId);
    }
    return cliArgs;
  },
  consumeEvent(state: EngineState, event: unknown) {
    if (!event || typeof event !== 'object') {
      return;
    }

    const obj = event as Record<string, unknown>;
    maybeStoreSessionId(state, obj);

    if (obj.type === 'message') {
      const role =
        obj.role ?? (obj.message as Record<string, unknown> | undefined)?.role;
      const content =
        obj.content ??
        (obj.message as Record<string, unknown> | undefined)?.content;
      if (role === 'assistant') {
        const delta =
          obj.delta === true ||
          (obj.message as Record<string, unknown> | undefined)?.delta === true;
        const text =
          delta && typeof content === 'string' ? content : extractText(content);
        if (text) {
          state.lastAssistantText = delta
            ? `${state.lastAssistantText}${text}`
            : text;
        }
      }
      return;
    }

    if (obj.type === 'result') {
      state.finalResult = obj;
    }
  },
  finalize(state: EngineState): EngineOutcome {
    if (!state.finalResult || typeof state.finalResult !== 'object') {
      throw new Error('Gemini parser error: missing terminal result event');
    }

    const result = state.finalResult as Record<string, unknown>;
    const status = result.status;
    const isError =
      result.is_error === true || status === 'error' || status === 'failed';
    if (isError) {
      const errorType = normalizeErrorType(result.error);
      return {
        ok: false,
        error: normalizeError(result.error, 'Gemini command failed'),
        ...(errorType ? { errorType } : {}),
      };
    }

    if (!state.lastAssistantText) {
      throw new Error(
        'Gemini parser error: success result without assistant text',
      );
    }

    return {
      ok: true,
      text: state.lastAssistantText,
      usage: normalizeUsage(result.stats),
    };
  },
  inspectRawOutput(args: RawOutputInspectionArgs) {
    return inspectOAuthPrompt(args, 'Gemini');
  },
};
