export type TokenUsage = {
  input?: number;
  output?: number;
  total?: number;
  cached?: number;
};

/**
 * What one model contributed to a run, aggregated over every API call the run
 * made to it.
 *
 * Per model rather than per run because a run is not billed at one rate: the
 * agent model does the work while the CLI's own auxiliary calls use a smaller
 * one, and a single figure hides which of the two an expensive run spent on.
 */
export type ModelUsage = {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  webSearchRequests: number;
  costUsd: number;
};

export type CliPermissionDenial = {
  toolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
};

export type EngineState = {
  finalResult: unknown;
  lastAssistantText: string;
  sessionId?: string;
  rawStdout: string;
  rawStderr: string;
};

export type EngineOutcome =
  | {
      ok: true;
      text: string;
      /** The whole run's token usage. */
      usage: TokenUsage | null;
      /** What the run cost, as the CLI reported it. Absent when the engine does
       * not report a cost. Never computed from a pricing table here: a repricing
       * must not silently rewrite what a past run cost. */
      costUsd?: number;
      /** The run's usage split by model. Absent when the engine reports no
       * breakdown. */
      modelUsage?: ModelUsage[];
      permissionDenials?: CliPermissionDenial[];
    }
  | { ok: false; error: string; errorType?: string };

export type RawOutputInspectionArgs = {
  stream: 'stdout' | 'stderr';
  text: string;
};

export type CliPermissionMode = 'default' | 'acceptEdits' | 'dontAsk' | 'plan';

export type CliBuildArgs = {
  prompt: string;
  sessionId?: string;
  model?: string;
  printTimeoutMs?: number;
  includeDirectories?: readonly string[];
  mcpConfigPath?: string;
  strictMcpConfig?: boolean;
  systemPromptFile?: string;
  tools?: readonly string[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  permissionMode?: CliPermissionMode;
  dangerouslySkipPermissions?: boolean;
};

export type CliAdapter = {
  name: string;
  outputMode?: 'jsonl' | 'text';
  buildCliArgs(args: CliBuildArgs): string[];
  consumeEvent(state: EngineState, event: unknown): void;
  finalize(state: EngineState): EngineOutcome;
  inspectRawOutput?(args: RawOutputInspectionArgs): string | null;
};
