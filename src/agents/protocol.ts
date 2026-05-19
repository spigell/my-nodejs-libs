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
  includeDirectories?: readonly string[];
};

export type CliAdapter = {
  name: string;
  buildCliArgs(args: CliBuildArgs): string[];
  consumeEvent(state: EngineState, event: unknown): void;
  finalize(state: EngineState): EngineOutcome;
  inspectRawOutput?(args: RawOutputInspectionArgs): string | null;
};
