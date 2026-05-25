export type TokenUsage = {
  input?: number;
  output?: number;
  total?: number;
  cached?: number;
};

export type EngineState = {
  finalResult: unknown;
  lastAssistantText: string;
  sessionId?: string;
  rawStdout: string;
  rawStderr: string;
};

export type EngineOutcome =
  | { ok: true; text: string; usage: TokenUsage | null }
  | { ok: false; error: string; errorType?: string };

export type RawOutputInspectionArgs = {
  stream: 'stdout' | 'stderr';
  text: string;
};

export type CliBuildArgs = {
  prompt: string;
  sessionId?: string;
  model?: string;
  printTimeoutMs?: number;
  includeDirectories?: readonly string[];
};

export type CliAdapter = {
  name: string;
  outputMode?: 'jsonl' | 'text';
  buildCliArgs(args: CliBuildArgs): string[];
  consumeEvent(state: EngineState, event: unknown): void;
  finalize(state: EngineState): EngineOutcome;
  inspectRawOutput?(args: RawOutputInspectionArgs): string | null;
};
