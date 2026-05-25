import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

import {
  agyAdapter,
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

void test('agyAdapter detects interactive login prompts', () => {
  assert.equal(
    agyAdapter.inspectRawOutput?.({
      stream: 'stderr',
      text: 'Login required. Please visit the browser flow to authenticate.',
    }),
    'Agy authentication required. The CLI is waiting for interactive login.',
  );
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
