import type {
  CliAdapter,
  CliBuildArgs,
  EngineOutcome,
  EngineState,
  RawOutputInspectionArgs,
} from './protocol.js';

const AGY_AUTH_PATTERNS = [
  'interactive login required',
  'login required',
  'please visit',
  'verification code',
  'waiting for authentication',
  'waiting for login',
  'sign in',
  'authenticate',
];

function inspectAuthPrompt(args: RawOutputInspectionArgs): string | null {
  const text = args.text.trim();
  if (!text) {
    return null;
  }

  const normalized = text.toLowerCase();
  if (!AGY_AUTH_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return null;
  }

  return 'Agy authentication required. The CLI is waiting for interactive login.';
}

export const agyAdapter: CliAdapter = {
  name: 'agy',
  outputMode: 'text',
  buildCliArgs(args: CliBuildArgs) {
    const printTimeoutMs = args.printTimeoutMs ?? 10 * 60 * 1000;
    const cliArgs = [
      '--dangerously-skip-permissions',
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
  consumeEvent() {},
  finalize(state: EngineState): EngineOutcome {
    const text = state.rawStdout.trim();
    if (!text) {
      return {
        ok: false,
        error: 'Agy command succeeded without producing any stdout output',
      };
    }

    return {
      ok: true,
      text,
      usage: null,
    };
  },
  inspectRawOutput(args: RawOutputInspectionArgs) {
    return inspectAuthPrompt(args);
  },
};
