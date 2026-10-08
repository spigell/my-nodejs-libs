import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  KEEPALIVE_LAST_TEXT,
  KEEPALIVE_TEXT,
  TranscriptReader,
  typedText,
} from '../agents/claude-cache-keeper.js';

const ESC = '\x1b';
// Claude Code pads the prompt marker with a no-break space.
const MARKER = '❯\u00a0';

void test('typedText reads an empty input box as empty', () => {
  assert.equal(typedText(`${MARKER}${ESC}[7m ${ESC}[27m`), '');
});

void test('typedText ignores a dim prompt suggestion under the cursor', () => {
  assert.equal(
    typedText(
      `${MARKER}${ESC}[7mf${ESC}[27m${ESC}[2mix the failing test${ESC}[22m`,
    ),
    '',
  );
});

void test('typedText returns a typed draft', () => {
  assert.equal(
    typedText(`${MARKER}deploy the${ESC}[7m ${ESC}[27m`),
    'deploy the',
  );
});

void test('typedText returns a keepalive left in the box', () => {
  assert.equal(typedText(`${MARKER}${KEEPALIVE_TEXT}`), KEEPALIVE_TEXT);
});

const user = (timestamp: string, content: string): string =>
  JSON.stringify({ type: 'user', timestamp, message: { content } }) + '\n';

const assistant = (timestamp: string): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 200_000,
        cache_creation_input_tokens: 1_000,
        cache_creation: { ephemeral_1h_input_tokens: 1_000 },
      },
    },
  }) + '\n';

void test('TranscriptReader tracks the cache, the last real prompt and the last bump', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-keeper-'));
  const path = join(dir, 'session.jsonl');
  try {
    writeFileSync(
      path,
      user('2026-10-08T00:00:00Z', 'fix the build') +
        assistant('2026-10-08T00:00:30Z'),
    );
    const reader = new TranscriptReader();
    let state = reader.read(path);
    assert.equal(state.ttl, 3600);
    assert.equal(state.context, 201_002);
    assert.equal(state.idle, true);
    assert.equal(state.lastPrompt, Date.parse('2026-10-08T00:00:00Z') / 1000);
    assert.equal(state.lastBumpSent, false);

    // Keepalives move the request start but are not real prompts.
    appendFileSync(
      path,
      user('2026-10-08T00:55:00Z', KEEPALIVE_TEXT) +
        assistant('2026-10-08T00:55:05Z'),
    );
    state = reader.read(path);
    assert.equal(state.reqStart, Date.parse('2026-10-08T00:55:00Z') / 1000);
    assert.equal(state.lastPrompt, Date.parse('2026-10-08T00:00:00Z') / 1000);
    assert.equal(state.lastBumpSent, false);

    appendFileSync(
      path,
      user('2026-10-08T01:50:00Z', KEEPALIVE_LAST_TEXT) +
        assistant('2026-10-08T01:50:05Z'),
    );
    assert.equal(reader.read(path).lastBumpSent, true);

    appendFileSync(
      path,
      user('2026-10-08T02:10:00Z', 'continue') +
        assistant('2026-10-08T02:10:20Z'),
    );
    state = reader.read(path);
    assert.equal(state.lastBumpSent, false);
    assert.equal(state.lastPrompt, Date.parse('2026-10-08T02:10:00Z') / 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
