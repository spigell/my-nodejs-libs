import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

import {
  agyAdapter,
  claudeAdapter,
  CliRunner,
  createJsonlParser,
  geminiAdapter,
  type CliAdapter,
  type CliBuildArgs,
  type EngineState,
  type RawOutputInspectionArgs,
} from '../index.js';

void test('createJsonlParser handles chunks, blank lines, invalid lines, and final lines', () => {
  const events: unknown[] = [];
  const invalidLines: string[] = [];
  const parser = createJsonlParser({
    onLine: (event) => events.push(event),
    onInvalidLine: (line) => invalidLines.push(line),
  });

  parser.write('{"type":"message","content":"hel');
  parser.write('lo"}\n\nnot-json\n{"type":"result"');
  parser.end();

  assert.deepEqual(events, [{ type: 'message', content: 'hello' }]);
  assert.deepEqual(invalidLines, ['not-json', '{"type":"result"']);
});

void test('geminiAdapter detects interactive login prompts', () => {
  assert.equal(
    geminiAdapter.inspectRawOutput?.({
      stream: 'stderr',
      text: 'Error: interactive login required before continuing',
    }),
    'Gemini authentication required. The CLI is waiting for interactive OAuth login.',
  );
});

void test('geminiAdapter finalizes text and token usage from JSONL events', () => {
  const state: EngineState = {
    finalResult: null,
    lastAssistantText: '',
    rawStdout: '',
    rawStderr: '',
  };

  geminiAdapter.consumeEvent(state, {
    type: 'message',
    session_id: 'session-1',
    role: 'assistant',
    content: [{ text: 'Done.' }],
  });
  geminiAdapter.consumeEvent(state, {
    type: 'result',
    status: 'success',
    stats: {
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 2,
    },
  });

  assert.equal(state.sessionId, 'session-1');
  assert.deepEqual(geminiAdapter.finalize(state), {
    ok: true,
    text: 'Done.',
    usage: {
      input: 10,
      output: 5,
      total: 15,
      cached: 2,
    },
  });
});

void test('claudeAdapter defaults to strict MCP configuration', () => {
  const readOnlyTools = [
    'Read',
    'Glob',
    'Grep',
    'mcp__github-mcp__search_code',
  ];
  assert.deepEqual(
    claudeAdapter.buildCliArgs({
      prompt: 'Inspect the deployment',
      sessionId: 'session-claude',
      model: 'claude-sonnet-4-5',
      includeDirectories: ['/spigell-reforge-ai', '/third-party'],
      mcpConfigPath: '/isolated/claude/classifier/mcp.json',
      tools: readOnlyTools,
      allowedTools: readOnlyTools,
      permissionMode: 'dontAsk',
    }),
    [
      '--print',
      'Inspect the deployment',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Glob,Grep,mcp__github-mcp__search_code',
      '--allowedTools',
      'Read,Glob,Grep,mcp__github-mcp__search_code',
      '--model',
      'claude-sonnet-4-5',
      '--resume',
      'session-claude',
      '--add-dir',
      '/spigell-reforge-ai',
      '--add-dir',
      '/third-party',
      '--mcp-config',
      '/isolated/claude/classifier/mcp.json',
      '--strict-mcp-config',
    ],
  );
});

void test('claudeAdapter enables strict MCP configuration explicitly', () => {
  const cliArgs = claudeAdapter.buildCliArgs({
    prompt: 'Inspect the deployment',
    mcpConfigPath: '/isolated/claude/mcp.json',
    strictMcpConfig: true,
  });

  assert.deepEqual(cliArgs.slice(-3), [
    '--mcp-config',
    '/isolated/claude/mcp.json',
    '--strict-mcp-config',
  ]);
});

void test('claudeAdapter can disable strict MCP configuration', () => {
  const cliArgs = claudeAdapter.buildCliArgs({
    prompt: 'Inspect the deployment',
    mcpConfigPath: '/isolated/claude/mcp.json',
    strictMcpConfig: false,
  });

  assert.deepEqual(cliArgs.slice(-2), [
    '--mcp-config',
    '/isolated/claude/mcp.json',
  ]);
  assert.doesNotMatch(cliArgs.join(' '), /--strict-mcp-config/);
});

void test('claudeAdapter appends a system prompt file from build args', () => {
  const cliArgs = claudeAdapter.buildCliArgs({
    prompt: 'Inspect the deployment',
    systemPromptFile: ' /isolated/claude/system.md ',
  });

  assert.deepEqual(cliArgs.slice(-2), [
    '--append-system-prompt-file',
    '/isolated/claude/system.md',
  ]);
});

void test('claudeAdapter disables all tools for a classifier', () => {
  const cliArgs = claudeAdapter.buildCliArgs({
    prompt: 'Classify this untrusted message',
    permissionMode: 'dontAsk',
  });

  assert.deepEqual(cliArgs, [
    '--print',
    'Classify this untrusted message',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--tools',
    '',
  ]);
  assert.doesNotMatch(cliArgs.join(' '), /dangerously-skip-permissions/);
});

void test('claudeAdapter rejects conflicting permission options', () => {
  assert.throws(
    () =>
      claudeAdapter.buildCliArgs({
        prompt: 'Run',
        dangerouslySkipPermissions: true,
        permissionMode: 'dontAsk',
      }),
    /cannot combine dangerouslySkipPermissions with permissionMode/,
  );
});

void test('claudeAdapter finalizes text, session, and cache-aware usage', () => {
  const state: EngineState = {
    finalResult: null,
    lastAssistantText: '',
    rawStdout: '',
    rawStderr: '',
  };

  claudeAdapter.consumeEvent(state, {
    type: 'system',
    subtype: 'init',
    session_id: 'claude-session-1',
  });
  claudeAdapter.consumeEvent(state, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Intermediate response' }],
    },
  });
  claudeAdapter.consumeEvent(state, {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Final response',
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 20,
      output_tokens: 6,
    },
  });

  assert.equal(state.sessionId, 'claude-session-1');
  assert.deepEqual(claudeAdapter.finalize(state), {
    ok: true,
    text: 'Final response',
    usage: {
      input: 34,
      output: 6,
      total: 40,
      cached: 20,
    },
    permissionDenials: [],
  });
});

void test('claudeAdapter reports the whole run rather than its final API call', () => {
  // The terminal event as the Claude CLI actually emits it, captured from a
  // real headless run. The divergence is the point: `usage` describes the final
  // API call (44 output tokens) while `modelUsage` covers the run (58, across
  // its main and auxiliary calls). Reading `usage` as the run's total was this
  // adapter's bug.
  const state: EngineState = {
    finalResult: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'pong',
      total_cost_usd: 0.0187875,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 8160,
        cache_read_input_tokens: 16435,
        output_tokens: 44,
      },
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 534,
          outputTokens: 58,
          cacheReadInputTokens: 16435,
          cacheCreationInputTokens: 8160,
          webSearchRequests: 0,
          costUSD: 0.0187875,
          contextWindow: 200000,
        },
      },
    },
    lastAssistantText: '',
    rawStdout: '',
    rawStderr: '',
  };

  assert.deepEqual(claudeAdapter.finalize(state), {
    ok: true,
    text: 'pong',
    usage: {
      // 534 + 8160 + 16435, not the final call's 10 + 8160 + 16435.
      input: 25129,
      output: 58,
      total: 25187,
      cached: 16435,
    },
    costUsd: 0.0187875,
    modelUsage: [
      {
        model: 'claude-haiku-4-5-20251001',
        input: 534,
        output: 58,
        cacheRead: 16435,
        cacheCreation: 8160,
        webSearchRequests: 0,
        costUsd: 0.0187875,
      },
    ],
    permissionDenials: [],
  });
});

void test('claudeAdapter sums usage across every model a run drove', () => {
  const state: EngineState = {
    finalResult: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done',
      total_cost_usd: 1.5,
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 3,
          costUSD: 1.4,
        },
        'claude-haiku-4-5': {
          inputTokens: 10,
          outputTokens: 2,
          costUSD: 0.1,
        },
        // Malformed entries must not cost the run its accounting.
        '': { costUSD: 99 },
        'claude-broken': null,
      },
    },
    lastAssistantText: '',
    rawStdout: '',
    rawStderr: '',
  };

  const outcome = claudeAdapter.finalize(state);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.modelUsage?.length, 2);
  assert.deepEqual(outcome.usage, {
    input: 100 + 5 + 3 + 10,
    output: 22,
    total: 140,
    cached: 5,
  });
  assert.equal(outcome.costUsd, 1.5);
});

void test('claudeAdapter omits cost and model usage when the CLI reports none', () => {
  const state: EngineState = {
    finalResult: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done',
      usage: { input_tokens: 4, output_tokens: 1 },
    },
    lastAssistantText: '',
    rawStdout: '',
    rawStderr: '',
  };

  const outcome = claudeAdapter.finalize(state);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // Absent rather than zero: a zero cost is a claim the run was free.
  assert.equal('costUsd' in outcome, false);
  assert.equal('modelUsage' in outcome, false);
  // Falls back to the final call's usage so a CLI without modelUsage keeps
  // the previous behaviour.
  assert.deepEqual(outcome.usage, {
    input: 4,
    output: 1,
    total: 5,
    cached: 0,
  });
});

void test('claudeAdapter normalizes terminal permission denials', () => {
  const state: EngineState = {
    finalResult: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Completed with a denied write.',
      permission_denials: [
        {
          tool_name: 'Write',
          tool_use_id: 'toolu_01ABC',
          tool_input: {
            file_path: '/workspace/deployment.yaml',
            content: 'replicas: 3',
          },
        },
        {
          tool_name: '',
          tool_use_id: 'toolu_invalid',
          tool_input: {},
        },
      ],
    },
    lastAssistantText: '',
    rawStdout: '',
    rawStderr: '',
  };

  assert.deepEqual(claudeAdapter.finalize(state), {
    ok: true,
    text: 'Completed with a denied write.',
    usage: null,
    permissionDenials: [
      {
        toolName: 'Write',
        toolUseId: 'toolu_01ABC',
        toolInput: {
          file_path: '/workspace/deployment.yaml',
          content: 'replicas: 3',
        },
      },
    ],
  });
});

void test('claudeAdapter detects authentication failures', () => {
  assert.equal(
    claudeAdapter.inspectRawOutput?.({
      stream: 'stderr',
      text: 'Not logged in. Please run /login to continue.',
    }),
    'Claude authentication required. Log in to Claude Code or provide valid Anthropic credentials.',
  );
});

void test('claudeAdapter returns terminal errors', () => {
  const state: EngineState = {
    finalResult: {
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'The request was rejected',
    },
    lastAssistantText: '',
    rawStdout: '',
    rawStderr: '',
  };

  assert.deepEqual(claudeAdapter.finalize(state), {
    ok: false,
    error: 'The request was rejected',
  });
});

void test('claudeAdapter normalizes terminal authentication errors', () => {
  const state: EngineState = {
    finalResult: {
      type: 'result',
      subtype: 'error',
      is_error: true,
      error: 'Invalid API key',
    },
    lastAssistantText: '',
    rawStdout: '',
    rawStderr: '',
  };

  assert.deepEqual(claudeAdapter.finalize(state), {
    ok: false,
    error:
      'Claude authentication required. Log in to Claude Code or provide valid Anthropic credentials.',
  });
});

void test('agyAdapter builds print args with timeout and conversation id', () => {
  assert.deepEqual(
    agyAdapter.buildCliArgs({
      prompt: 'Say hello',
      sessionId: 'conversation-1',
      printTimeoutMs: 45_000,
    }),
    [
      '--dangerously-skip-permissions',
      '-p',
      'Say hello',
      '--print-timeout',
      '45000ms',
      '--conversation',
      'conversation-1',
    ],
  );
});

void test('agyAdapter finalizes plain stdout output', () => {
  const state: EngineState = {
    finalResult: null,
    lastAssistantText: '',
    rawStdout: '\nAgy result\n',
    rawStderr: '',
  };

  assert.deepEqual(agyAdapter.finalize(state), {
    ok: true,
    text: 'Agy result',
    usage: null,
  });
});

void test('agyAdapter rejects empty stdout output', () => {
  const state: EngineState = {
    finalResult: null,
    lastAssistantText: '',
    rawStdout: ' \n\t ',
    rawStderr: '',
  };

  assert.deepEqual(agyAdapter.finalize(state), {
    ok: false,
    error: 'Agy command succeeded without producing any stdout output',
  });
});

void test('CliRunner supports text-mode adapters without JSONL parsing', async () => {
  const textAdapter: CliAdapter = {
    name: 'text-fixture',
    outputMode: 'text',
    buildCliArgs() {
      return ['-e', 'process.stdout.write("plain text result\\n")'];
    },
    consumeEvent() {},
    finalize(state) {
      return {
        ok: true,
        text: state.rawStdout.trim(),
        usage: null,
      };
    },
  };

  const runner = new CliRunner({
    command: process.execPath,
    adapter: textAdapter,
    cwd: process.cwd(),
    logger: { info() {} },
  });

  const result = await runner.run('ignored');

  assert.equal(result.text, 'plain text result');
  assert.deepEqual(result.warnings, []);
});

void test('CliRunner timeout still applies to text-mode adapters', async () => {
  const textAdapter: CliAdapter = {
    name: 'text-timeout',
    outputMode: 'text',
    buildCliArgs() {
      return ['-e', 'setTimeout(() => process.stdout.write("late"), 1000)'];
    },
    consumeEvent() {},
    finalize(state) {
      return {
        ok: true,
        text: state.rawStdout.trim(),
        usage: null,
      };
    },
  };

  const runner = new CliRunner({
    command: process.execPath,
    adapter: textAdapter,
    cwd: process.cwd(),
    timeoutMs: 50,
    logger: { info() {} },
  });

  await assert.rejects(runner.run('ignored'), /timed out after 50ms/);
});

void test('CliRunner propagates options and terminal permission denials', async () => {
  const receivedBuildArgs: CliBuildArgs[] = [];
  const resultLine = `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    permission_denials: [
      {
        tool_name: 'Bash',
        tool_use_id: 'toolu_01DENIED',
        tool_input: { command: 'kubectl delete pod api-0' },
      },
    ],
  })}\n`;
  const adapter: CliAdapter = {
    ...claudeAdapter,
    buildCliArgs(args) {
      receivedBuildArgs.push(args);
      return ['-e', `process.stdout.write(${JSON.stringify(resultLine)})`];
    },
  };
  const runner = new CliRunner({
    command: process.execPath,
    adapter,
    cwd: process.cwd(),
    env: { CLAUDE_SYSTEM_PROMPT_FILE: '/isolated/claude/system.md' },
    logger: { info() {} },
  });

  const result = await runner.run('Inspect', {
    mcpConfigPath: '/isolated/claude/mcp.json',
    strictMcpConfig: false,
  });

  assert.equal(receivedBuildArgs.length, 1);
  assert.equal(receivedBuildArgs[0]?.strictMcpConfig, false);
  assert.equal(
    receivedBuildArgs[0]?.systemPromptFile,
    '/isolated/claude/system.md',
  );
  assert.deepEqual(result.permissionDenials, [
    {
      toolName: 'Bash',
      toolUseId: 'toolu_01DENIED',
      toolInput: { command: 'kubectl delete pod api-0' },
    },
  ]);
});

void test('CliRunner does not inspect structured JSONL content as diagnostics', async () => {
  const helmAnnotation =
    'nginx.ingress.kubernetes.io/auth-realm: Authentication Required';
  const output = [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Reading repository content.' }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: `metadata:\n  annotations:\n    ${helmAnnotation}`,
          },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Repository content is valid.',
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  const inspections: RawOutputInspectionArgs[] = [];
  const adapter: CliAdapter = {
    ...claudeAdapter,
    buildCliArgs() {
      const splitAt = output.indexOf(helmAnnotation) + helmAnnotation.length;
      const firstChunk = output.slice(0, splitAt);
      const finalChunk = `${output.slice(splitAt)}\n`;
      return [
        '-e',
        [
          `process.stdout.write(${JSON.stringify(firstChunk)});`,
          `setTimeout(() => process.stdout.write(${JSON.stringify(finalChunk)}), 25);`,
        ].join(''),
      ];
    },
    inspectRawOutput(args) {
      inspections.push(args);
      return claudeAdapter.inspectRawOutput?.(args) ?? null;
    },
  };
  const runner = new CliRunner({
    command: process.execPath,
    adapter,
    cwd: process.cwd(),
    logger: { info() {} },
  });

  const result = await runner.run('Inspect');

  assert.equal(result.text, 'Repository content is valid.');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(inspections, []);
});

void test('CliRunner detects split unstructured JSONL authentication diagnostics', async () => {
  const adapter: CliAdapter = {
    ...claudeAdapter,
    buildCliArgs() {
      return [
        '-e',
        [
          "process.stdout.write('Authentication ');",
          "setTimeout(() => process.stdout.write('required'), 25);",
          'setTimeout(() => undefined, 1000);',
        ].join(''),
      ];
    },
  };
  const runner = new CliRunner({
    command: process.execPath,
    adapter,
    cwd: process.cwd(),
    timeoutMs: 250,
    logger: { info() {} },
  });

  await assert.rejects(runner.run('Inspect'), (error: Error) => {
    assert.match(
      error.message,
      /Claude authentication required\. Log in to Claude Code or provide valid Anthropic credentials\./,
    );
    assert.doesNotMatch(error.message, /timed out/i);
    return true;
  });
});

void test('CliRunner detects split stderr authentication diagnostics', async () => {
  const adapter: CliAdapter = {
    ...claudeAdapter,
    buildCliArgs() {
      return [
        '-e',
        [
          "process.stderr.write('Invalid API ');",
          "setTimeout(() => process.stderr.write('key'), 25);",
          'setTimeout(() => undefined, 1000);',
        ].join(''),
      ];
    },
  };
  const runner = new CliRunner({
    command: process.execPath,
    adapter,
    cwd: process.cwd(),
    logger: { info() {} },
  });

  await assert.rejects(
    runner.run('Inspect'),
    /Claude authentication required\. Log in to Claude Code or provide valid Anthropic credentials\./,
  );
});

void test('CliRunner normalizes a terminal JSONL authentication error', async () => {
  const resultLine = `${JSON.stringify({
    type: 'result',
    subtype: 'error',
    is_error: true,
    error: 'Invalid API key',
  })}\n`;
  const adapter: CliAdapter = {
    ...claudeAdapter,
    buildCliArgs() {
      return ['-e', `process.stdout.write(${JSON.stringify(resultLine)})`];
    },
  };
  const runner = new CliRunner({
    command: process.execPath,
    adapter,
    cwd: process.cwd(),
    logger: { info() {} },
  });

  await assert.rejects(runner.run('Inspect'), (error: Error) => {
    assert.match(
      error.message,
      /Claude authentication required\. Log in to Claude Code or provide valid Anthropic credentials\./,
    );
    assert.doesNotMatch(error.message, /exit 143|interrupted by user/i);
    return true;
  });
});
