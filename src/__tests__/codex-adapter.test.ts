import assert from 'node:assert/strict';
import test from 'node:test';
import { codexAdapter } from '../agents/codex-adapter.js';
import type { EngineState } from '../agents/protocol.js';

const freshState = (): EngineState => ({
  finalResult: null,
  lastAssistantText: '',
  rawStdout: '',
  rawStderr: '',
});

const run = (events: unknown[]): EngineState => {
  const state = freshState();
  for (const event of events) {
    codexAdapter.consumeEvent(state, event);
  }
  return state;
};

/** Captured verbatim from codex-cli 0.155.1 in the workbench pod. */
const THREAD_STARTED = {
  type: 'thread.started',
  thread_id: '01a0ba94-f8f8-7e91-b351-e399136e5763',
};
const ITEM_COMPLETED = {
  type: 'item.completed',
  item: {
    id: 'item_0',
    type: 'agent_message',
    text: '```python\ndef is_prime(n):\n    return n > 1\n```',
  },
};
const TURN_COMPLETED = {
  type: 'turn.completed',
  usage: {
    input_tokens: 10042,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 42,
    reasoning_output_tokens: 0,
  },
};

void test('codexAdapter runs exec in json mode', () => {
  const args = codexAdapter.buildCliArgs({ prompt: 'do the thing' });

  assert.equal(codexAdapter.outputMode, 'jsonl');
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--json'));
  // The prompt is a positional, because CliRunner never writes to stdin.
  assert.equal(args[args.length - 1], 'do the thing');
});

void test('codexAdapter passes additional workspaces as --add-dir', () => {
  const args = codexAdapter.buildCliArgs({
    prompt: 'p',
    includeDirectories: ['/a', '/b'],
  });

  assert.deepEqual(
    args.filter((value, index) => args[index - 1] === '--add-dir'),
    ['/a', '/b'],
  );
});

void test('codexAdapter records the thread id for resuming', () => {
  const state = run([THREAD_STARTED]);

  assert.equal(state.sessionId, '01a0ba94-f8f8-7e91-b351-e399136e5763');
});

void test('codexAdapter maps usage, keeping cached as a subset', () => {
  const state = run([
    THREAD_STARTED,
    { type: 'turn.started' },
    ITEM_COMPLETED,
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 20142,
        cached_input_tokens: 9856,
        cache_write_input_tokens: 0,
        output_tokens: 83,
        reasoning_output_tokens: 16,
      },
    },
  ]);

  const outcome = codexAdapter.finalize(state);
  assert.equal(outcome.ok, true);
  // cached is part of input, so total is input + output and never adds cached.
  assert.deepEqual(outcome.ok && outcome.usage, {
    input: 20142,
    output: 83,
    cached: 9856,
    thinking: 16,
    total: 20225,
  });
});

void test('codexAdapter returns the assistant message as the result text', () => {
  const state = run([THREAD_STARTED, ITEM_COMPLETED, TURN_COMPLETED]);

  const outcome = codexAdapter.finalize(state);
  assert.equal(outcome.ok, true);
  assert.match(outcome.ok ? outcome.text : '', /def is_prime/);
});

void test('codexAdapter fails when the turn produced no assistant message', () => {
  const state = run([THREAD_STARTED, TURN_COMPLETED]);

  const outcome = codexAdapter.finalize(state);
  assert.equal(outcome.ok, false);
  assert.match(!outcome.ok ? outcome.error : '', /without producing an assistant/i);
});

void test('codexAdapter fails when no terminal turn event arrived', () => {
  const state = run([THREAD_STARTED, ITEM_COMPLETED]);

  const outcome = codexAdapter.finalize(state);
  assert.equal(outcome.ok, false);
  assert.match(!outcome.ok ? outcome.error : '', /no terminal turn event/i);
});

void test('codexAdapter ignores unknown events instead of throwing', () => {
  const state = run([
    THREAD_STARTED,
    { type: 'item.started', item: { type: 'reasoning' } },
    { type: 'something_new', payload: 1 },
    'not an object',
    null,
    ITEM_COMPLETED,
    TURN_COMPLETED,
  ]);

  const outcome = codexAdapter.finalize(state);
  assert.equal(outcome.ok, true);
});
