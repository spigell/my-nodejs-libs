import assert from 'node:assert/strict';
import test from 'node:test';

import { getAgyUsage, parseAgyUsage } from '../agents/agy-usage.js';

/**
 * Captured verbatim from `agy -p '/usage' --dangerously-skip-permissions
 * --output-format stream-json` on agy 1.2.7. The trailing `result` line is
 * included because the parser must ignore it and read only `command_result`.
 */
const commandResultLine = JSON.stringify({
  event: 'command_result',
  command: {
    name: 'usage',
    data: {
      description:
        'Within each group, models share a weekly limit and a 5-hour limit.',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              description: 'You have used some of your weekly limit.',
              window: 'weekly',
              remaining_fraction: 0.8076949119567871,
              reset_time: '2026-09-23T02:28:11Z',
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              description: 'You have used some of your 5-hour limit.',
              window: '5h',
              remaining_fraction: 0.5055623054504395,
              reset_time: '2026-09-19T14:57:44Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          description:
            'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          buckets: [
            {
              id: '3p-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.5732713341712952,
              reset_time: '2026-09-26T02:00:23Z',
            },
            {
              id: '3p-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0,
              reset_time: '2026-09-19T14:51:55Z',
            },
          ],
        },
      ],
    },
  },
});

const resultLine = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: '',
    status: 'SUCCESS',
    num_turns: 0,
    usage: { total_tokens: 0 },
  },
});

const stdout = `${commandResultLine}\n${resultLine}\n`;

const nodeEmitting = (text: string) => ({
  command: process.execPath,
  args: ['-e', `process.stdout.write(${JSON.stringify(text)})`],
});

void test('parseAgyUsage reads quota groups from the command_result line', () => {
  const usage = parseAgyUsage(stdout);

  assert.equal(usage.agent, 'agy');
  assert.equal(usage.groups.length, 2);

  const [gemini, thirdParty] = usage.groups;
  assert.equal(gemini?.name, 'Gemini Models');
  assert.deepEqual(gemini?.models, ['Gemini Flash', 'Gemini Pro']);
  assert.deepEqual(thirdParty?.models, [
    'Claude Opus',
    'Claude Sonnet',
    'GPT-OSS',
  ]);

  const weekly = gemini?.buckets.find((bucket) => bucket.id === 'gemini-weekly');
  assert.equal(weekly?.window, 'weekly');
  assert.equal(weekly?.remaining_fraction, 0.8076949119567871);
  // agy reports an absolute timestamp, unlike Codex's reset_after_seconds.
  assert.equal(weekly?.reset_time, '2026-09-23T02:28:11Z');
  assert.equal(weekly?.limit_reached, false);
});

void test('parseAgyUsage marks an exhausted bucket as limit reached', () => {
  const usage = parseAgyUsage(stdout);
  const exhausted = usage.groups
    .flatMap((group) => group.buckets)
    .find((bucket) => bucket.id === '3p-5h');

  assert.equal(exhausted?.remaining_fraction, 0);
  assert.equal(exhausted?.limit_reached, true);
});

void test('parseAgyUsage rejects output without a command_result event', () => {
  assert.throws(
    () => parseAgyUsage(`${resultLine}\n`),
    /did not contain a command_result event line/,
  );
});

void test('parseAgyUsage ignores non-JSON noise lines', () => {
  const usage = parseAgyUsage(`warning: something\n${stdout}`);
  assert.equal(usage.groups.length, 2);
});

void test('getAgyUsage parses the spawned CLI output', async () => {
  const usage = await getAgyUsage(nodeEmitting(stdout));

  assert.equal(usage.agent, 'agy');
  assert.equal(usage.groups.length, 2);
});

void test('getAgyUsage rejects when the CLI exits non-zero', async () => {
  await assert.rejects(
    getAgyUsage({
      command: process.execPath,
      args: [
        '-e',
        'process.stderr.write("not logged in"); process.exit(3);',
      ],
    }),
    /exited with code 3: not logged in/,
  );
});

void test('getAgyUsage times out instead of blocking the caller', async () => {
  await assert.rejects(
    getAgyUsage({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000);'],
      timeoutMs: 250,
    }),
    /timed out after 250ms/,
  );
});
