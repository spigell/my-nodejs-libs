import type {
  CliAdapter,
  CliBuildArgs,
  EngineOutcome,
  EngineState,
  RawOutputInspectionArgs,
  TokenUsage,
} from './protocol.js';

const CLAUDE_AUTH_PATTERNS = [
  'please run /login',
  'not logged in',
  'authentication required',
  'invalid api key',
  'api key is missing',
];

function inspectAuthenticationPrompt(
  args: RawOutputInspectionArgs,
): string | null {
  const normalized = args.text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (
    !normalized ||
    !CLAUDE_AUTH_PATTERNS.some((pattern) => normalized.includes(pattern))
  ) {
    return null;
  }

  return 'Claude authentication required. Log in to Claude Code or provide valid Anthropic credentials.';
}

function extractText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const block = item as Record<string, unknown>;
      return block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '';
    })
    .join('')
    .trim();
}

function readTokenCount(usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function normalizeUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const usage = value as Record<string, unknown>;
  const uncachedInput = readTokenCount(usage, 'input_tokens');
  const cacheCreation = readTokenCount(usage, 'cache_creation_input_tokens');
  const cached = readTokenCount(usage, 'cache_read_input_tokens');
  const output = readTokenCount(usage, 'output_tokens');
  const hasTokenCounts = [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'output_tokens',
  ].some((key) => typeof usage[key] === 'number');

  if (!hasTokenCounts) {
    return null;
  }

  const input = uncachedInput + cacheCreation + cached;
  return {
    input,
    output,
    total: input + output,
    cached,
  };
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

function normalizeError(result: Record<string, unknown>): string {
  if (typeof result.error === 'string' && result.error.trim()) {
    return result.error.trim();
  }
  if (typeof result.result === 'string' && result.result.trim()) {
    return result.result.trim();
  }

  return 'Claude command failed';
}

export const claudeAdapter: CliAdapter = {
  name: 'claude',
  buildCliArgs(args: CliBuildArgs) {
    if (args.dangerouslySkipPermissions && args.permissionMode) {
      throw new Error(
        'Claude CLI args cannot combine dangerouslySkipPermissions with permissionMode',
      );
    }

    const cliArgs = [
      '--print',
      args.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
    ];

    if (args.dangerouslySkipPermissions) {
      cliArgs.push('--dangerously-skip-permissions');
    }
    if (args.permissionMode) {
      cliArgs.push('--permission-mode', args.permissionMode);
    }
    cliArgs.push('--tools', (args.tools ?? []).join(','));
    if (args.allowedTools && args.allowedTools.length > 0) {
      cliArgs.push('--allowedTools', args.allowedTools.join(','));
    }
    if (args.disallowedTools && args.disallowedTools.length > 0) {
      cliArgs.push('--disallowedTools', args.disallowedTools.join(','));
    }
    if (args.model?.trim()) {
      cliArgs.push('--model', args.model.trim());
    }
    if (args.sessionId) {
      cliArgs.push('--resume', args.sessionId);
    }
    for (const directory of args.includeDirectories ?? []) {
      cliArgs.push('--add-dir', directory);
    }
    if (args.mcpConfigPath) {
      cliArgs.push('--mcp-config', args.mcpConfigPath);
      if (args.strictMcpConfig !== false) {
        cliArgs.push('--strict-mcp-config');
      }
    }

    return cliArgs;
  },
  consumeEvent(state: EngineState, event: unknown) {
    if (!event || typeof event !== 'object') {
      return;
    }

    const obj = event as Record<string, unknown>;
    maybeStoreSessionId(state, obj);

    if (obj.type === 'assistant') {
      const message =
        obj.message && typeof obj.message === 'object'
          ? (obj.message as Record<string, unknown>)
          : obj;
      const text = extractText(message.content);
      if (text) {
        state.lastAssistantText = text;
      }
      return;
    }

    if (obj.type === 'result') {
      state.finalResult = obj;
    }
  },
  finalize(state: EngineState): EngineOutcome {
    if (!state.finalResult || typeof state.finalResult !== 'object') {
      throw new Error('Claude parser error: missing terminal result event');
    }

    const result = state.finalResult as Record<string, unknown>;
    const subtype = result.subtype;
    const status = result.status;
    const isError =
      result.is_error === true ||
      subtype === 'error' ||
      status === 'error' ||
      status === 'failed';
    if (isError) {
      const error = normalizeError(result);
      return {
        ok: false,
        error:
          inspectAuthenticationPrompt({
            stream: 'stdout',
            text: error,
          }) ?? error,
      };
    }

    const resultText =
      typeof result.result === 'string' ? result.result.trim() : '';
    const text = resultText || state.lastAssistantText;
    if (!text) {
      throw new Error(
        'Claude parser error: success result without assistant text',
      );
    }

    return {
      ok: true,
      text,
      usage: normalizeUsage(result.usage),
    };
  },
  inspectRawOutput(args: RawOutputInspectionArgs) {
    return inspectAuthenticationPrompt(args);
  },
};
