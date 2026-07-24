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
  type EngineState,
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

void test('claudeAdapter builds stream JSON args for a resumable run', () => {
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
