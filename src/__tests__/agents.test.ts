import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createJsonlParser,
  geminiAdapter,
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
