import test from 'node:test';
import assert from 'node:assert/strict';

import { TelegramSender } from '../telegram/sender.js';

void test('TelegramSender sends Markdown without link previews through the v2 API', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl: string | undefined;
  let requestBody: URLSearchParams | undefined;

  globalThis.fetch = (input, init) => {
    requestUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    assert.equal(init?.method, 'POST');
    assert.ok(init?.body instanceof URLSearchParams);
    requestBody = init.body;
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }),
    );
  };

  try {
    await new TelegramSender('test-token', '12345').send('*hello*');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    requestUrl,
    'https://api.telegram.org/bottest-token/sendMessage',
  );
  assert.equal(requestBody?.get('chat_id'), '12345');
  assert.equal(requestBody?.get('text'), '*hello*');
  assert.equal(requestBody?.get('parse_mode'), 'Markdown');
  assert.equal(
    requestBody?.get('link_preview_options'),
    '{"is_disabled":true}',
  );
});
