import type {
  CliAdapter,
  CliBuildArgs,
  EngineOutcome,
  EngineState,
} from './protocol.js';

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
};
