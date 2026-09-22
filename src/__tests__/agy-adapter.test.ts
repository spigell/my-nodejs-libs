import assert from 'node:assert/strict';
import test from 'node:test';
import { agyAdapter } from '../agents/agy-adapter.js';
import type { EngineState } from '../agents/protocol.js';

const freshState = (): EngineState => ({
  finalResult: null,
  lastAssistantText: '',
  rawStdout: '',
  rawStderr: '',
});

/**
 * Captured verbatim from agy 1.2.7 running in the workbench pod. The tool list
 * is trimmed, but every key kept here appeared exactly as written.
 */
const INIT_EVENT = {
  event: 'init',
  conversation_id: '0e7cac42-8441-4539-8385-ae6f965c07e9',
  init: {
    cwd: '/tmp',
    tools: ['run_command', 'view_file', 'replace_file_content'],
    permission_mode: 'always-proceed',
  },
};

/** The timeout shape: SUCCESS, but an empty response and a zeroed usage block. */
const TIMED_OUT_RESULT_EVENT = {
  event: 'result',
  result: {
    conversation_id: '0e7cac42-8441-4539-8385-ae6f965c07e9',
    status: 'SUCCESS',
    response: '',
    duration_seconds: 0,
    num_turns: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
    },
  },
};

const run = (events: unknown[]): EngineState => {
  const state = freshState();
  for (const event of events) {
    agyAdapter.consumeEvent(state, event);
  }
  return state;
};

void test('agyAdapter asks for stream-json so events can be parsed at all', () => {
  const args = agyAdapter.buildCliArgs({ prompt: 'do the thing' });

  assert.equal(agyAdapter.outputMode, 'jsonl');
  const formatIndex = args.indexOf('--output-format');
  assert.notEqual(formatIndex, -1);
  assert.equal(args[formatIndex + 1], 'stream-json');
  assert.deepEqual(args.slice(args.indexOf('-p'), args.indexOf('-p') + 2), [
    '-p',
    'do the thing',
  ]);
});

void test('agyAdapter resumes a conversation when given a session id', () => {
  const args = agyAdapter.buildCliArgs({ prompt: 'again', sessionId: 'abc-123' });

  const index = args.indexOf('--conversation');
  assert.notEqual(index, -1);
  assert.equal(args[index + 1], 'abc-123');
});

void test('agyAdapter records the conversation id from the init event', () => {
  // The id must survive a run that dies before producing a result, or a failed
  // run cannot be resumed.
  const state = run([INIT_EVENT]);

  assert.equal(state.sessionId, '0e7cac42-8441-4539-8385-ae6f965c07e9');
});

void test('agyAdapter maps the usage block onto TokenUsage', () => {
  const state = run([
    INIT_EVENT,
    {
      event: 'result',
      result: {
        conversation_id: '0e7cac42-8441-4539-8385-ae6f965c07e9',
        status: 'SUCCESS',
        response: 'pong',
        duration_seconds: 4,
        num_turns: 1,
        usage: {
          input_tokens: 1200,
          output_tokens: 34,
          thinking_tokens: 88,
          cache_read_tokens: 1024,
          total_tokens: 1322,
        },
      },
    },
  ]);

  const outcome = agyAdapter.finalize(state);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.text, 'pong');
  // thinking stays separate from output: folding it in would make a
  // reasoning-heavy run look like a merely verbose one.
  assert.deepEqual(outcome.ok && outcome.usage, {
    input: 1200,
    output: 34,
    thinking: 88,
    cached: 1024,
    total: 1322,
  });
});

void test('agyAdapter treats a SUCCESS with an empty response as a failure', () => {
  const state = run([INIT_EVENT, TIMED_OUT_RESULT_EVENT]);

  const outcome = agyAdapter.finalize(state);
  // This exact payload is what a print timeout produces. Reporting it as a
  // successful empty answer would silently bill a task as done.
  assert.equal(outcome.ok, false);
  assert.match(!outcome.ok ? outcome.error : '', /empty response/i);
});

void test('agyAdapter fails when no terminal result event arrived', () => {
  const state = run([INIT_EVENT]);

  const outcome = agyAdapter.finalize(state);
  assert.equal(outcome.ok, false);
  assert.match(!outcome.ok ? outcome.error : '', /no terminal result event/i);
});

void test('agyAdapter reports a non-SUCCESS status as a failure', () => {
  const state = run([
    INIT_EVENT,
    {
      event: 'result',
      result: { conversation_id: 'x', status: 'ERROR', response: 'boom' },
    },
  ]);

  const outcome = agyAdapter.finalize(state);
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok ? outcome.errorType : '', 'ERROR');
});

void test('agyAdapter concatenates streamed text deltas', () => {
  // Captured shape: agy streams a turn as step_update events carrying
  // text_delta, and the closing step (state DONE) also reports that step's
  // usage. Replacing instead of concatenating would keep only the last chunk.
  const state = run([
    INIT_EVENT,
    {
      event: 'step_update',
      step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' },
    },
    {
      event: 'step_update',
      step_update: {
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'def is_prime(',
      },
    },
    {
      event: 'step_update',
      step_update: {
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'n): pass',
        usage: { input_tokens: 17590, output_tokens: 1225 },
      },
    },
  ]);

  assert.equal(state.lastAssistantText, 'def is_prime(n): pass');
});

void test('agyAdapter prefers the result response over accumulated deltas', () => {
  const state = run([
    INIT_EVENT,
    {
      event: 'step_update',
      step_update: {
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'partial',
      },
    },
    {
      event: 'result',
      result: { conversation_id: 'x', status: 'SUCCESS', response: 'the whole answer' },
    },
  ]);

  // The result repeats the full response, so it wins: that keeps the text
  // correct even if a delta was dropped.
  const outcome = agyAdapter.finalize(state);
  assert.equal(outcome.ok && outcome.text, 'the whole answer');
});

void test('agyAdapter bills the turn, not the whole conversation', () => {
  // Measured on agy 1.2.7: on a resumed conversation the closing step reported
  // input 19092 while the terminal result reported 36682 -- exactly turn one
  // plus turn two. Using the result would re-charge the earlier turn.
  const state = run([
    INIT_EVENT,
    {
      event: 'step_update',
      step_update: {
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'answer',
        usage: {
          input_tokens: 19092,
          output_tokens: 265,
          thinking_tokens: 238,
          cache_read_tokens: 0,
          total_tokens: 19357,
        },
      },
    },
    {
      event: 'result',
      result: {
        conversation_id: 'x',
        status: 'SUCCESS',
        response: 'answer',
        num_turns: 2,
        usage: {
          input_tokens: 36682,
          output_tokens: 1490,
          thinking_tokens: 1411,
          cache_read_tokens: 0,
          total_tokens: 38172,
        },
      },
    },
  ]);

  const outcome = agyAdapter.finalize(state);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.usage?.input, 19092);
  assert.equal(outcome.ok && outcome.usage?.total, 19357);
});

void test('agyAdapter ignores unknown events instead of throwing', () => {
  // The intermediate event vocabulary of a real turn has not been observed yet,
  // so unrecognised events must never break a run.
  const state = run([
    INIT_EVENT,
    { event: 'tool_call', tool_call: { name: 'run_command' } },
    { event: 'something_new', something_new: { nested: true } },
    'not an object',
    null,
    {
      event: 'result',
      result: { conversation_id: 'x', status: 'SUCCESS', response: 'done' },
    },
  ]);

  const outcome = agyAdapter.finalize(state);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.text, 'done');
  assert.equal(outcome.ok && outcome.usage, null);
});
