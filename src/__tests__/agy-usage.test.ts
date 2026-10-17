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
        {
          name: 'Gemini 4 Argon',
          description:
            'For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.',
          buckets: [
            {
              id: 'gemini-argon-wtu-weekly',
              name: 'Gemini 4 Argon Weekly Limit',
              window: 'weekly',
              remaining_fraction: 1,
              reset_time: '2026-10-24T12:00:25Z',
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

void test('parseAgyUsage reads quota groups and normalizes families from command_result', () => {
  const usage = parseAgyUsage(stdout);

  assert.equal(usage.agent, 'agy');
  assert.equal(usage.groups.length, 3);

  const [gemini, thirdParty, argon] = usage.groups;
  assert.equal(gemini?.name, 'Gemini Models');
  assert.deepEqual(gemini?.families, ['gemini']);
  assert.deepEqual(gemini?.models, ['Gemini Flash', 'Gemini Pro']);

  assert.deepEqual(thirdParty?.families, ['claude', 'gpt']);
  assert.deepEqual(thirdParty?.models, [
    'Claude Opus',
    'Claude Sonnet',
    'GPT-OSS',
  ]);

  assert.equal(argon?.name, 'Gemini 4 Argon');
  assert.deepEqual(argon?.families, ['argon']);
  assert.deepEqual(argon?.models, ['Gemini 4 Argon']);

  const weekly = gemini?.buckets.find(
    (bucket) => bucket.id === 'gemini-weekly',
  );
  assert.equal(weekly?.window, 'weekly');
  assert.equal(weekly?.normalized_window, 'seven_day');
  assert.equal(weekly?.remaining_fraction, 0.8076949119567871);
  assert.equal(weekly?.reset_time, '2026-09-23T02:28:11Z');
  assert.equal(weekly?.limit_reached, false);

  const fiveHour = gemini?.buckets.find((bucket) => bucket.id === 'gemini-5h');
  assert.equal(fiveHour?.window, '5h');
  assert.equal(fiveHour?.normalized_window, 'five_hour');
});

void test('parseAgyUsage populates normalized family map covering all observed families', () => {
  const usage = parseAgyUsage(stdout);

  assert.ok(usage.families.gemini);
  assert.equal(usage.families.gemini.family, 'gemini');
  assert.equal(usage.families.gemini.group_name, 'Gemini Models');
  assert.equal(usage.families.gemini.five_hour?.id, 'gemini-5h');
  assert.equal(usage.families.gemini.seven_day?.id, 'gemini-weekly');

  assert.ok(usage.families.claude);
  assert.equal(usage.families.claude.family, 'claude');
  assert.equal(usage.families.claude.group_name, 'Claude and GPT models');
  assert.equal(usage.families.claude.five_hour?.id, '3p-5h');
  assert.equal(usage.families.claude.seven_day?.id, '3p-weekly');

  assert.ok(usage.families.gpt);
  assert.equal(usage.families.gpt.family, 'gpt');
  assert.equal(usage.families.gpt.group_name, 'Claude and GPT models');
  assert.equal(usage.families.gpt.five_hour?.id, '3p-5h');
  assert.equal(usage.families.gpt.seven_day?.id, '3p-weekly');

  assert.ok(usage.families.argon);
  assert.equal(usage.families.argon.family, 'argon');
  assert.equal(usage.families.argon.group_name, 'Gemini 4 Argon');
  assert.equal(usage.families.argon.seven_day?.id, 'gemini-argon-wtu-weekly');
  // Argon has no five-hour limit upstream: missing window must remain explicitly null
  assert.equal(usage.families.argon.five_hour, null);
  assert.equal(usage.groups[2]?.five_hour, null);
});

void test('parseAgyUsage marks an exhausted bucket as limit reached', () => {
  const usage = parseAgyUsage(stdout);
  const exhausted = usage.groups
    .flatMap((group) => group.buckets)
    .find((bucket) => bucket.id === '3p-5h');

  assert.equal(exhausted?.remaining_fraction, 0);
  assert.equal(exhausted?.limit_reached, true);
});

void test('parseAgyUsage leaves missing windows explicit and handles partial groups', () => {
  const partialPayload = JSON.stringify({
    event: 'command_result',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Five Hour Only Group',
            description: 'Custom',
            buckets: [
              {
                id: 'custom-5h',
                window: '5h',
                remaining_fraction: 0.5,
                reset_time: '2026-10-24T12:00:00Z',
              },
            ],
          },
          {
            name: 'Empty Buckets Group',
            description: 'Custom',
            buckets: [],
          },
        ],
      },
    },
  });

  const usage = parseAgyUsage(partialPayload);
  assert.equal(usage.groups[0]?.five_hour?.id, 'custom-5h');
  assert.equal(usage.groups[0]?.seven_day, null);
  assert.equal(usage.groups[1]?.five_hour, null);
  assert.equal(usage.groups[1]?.seven_day, null);
  assert.equal(usage.families.gemini, null);
  assert.equal(usage.families.argon, null);
  assert.equal(usage.families.claude, null);
  assert.equal(usage.families.gpt, null);
});

void test('parseAgyUsage rejects malformed data', () => {
  const assertParseError = (data: unknown, pattern: RegExp) => {
    const json = JSON.stringify({
      event: 'command_result',
      command: { name: 'usage', data },
    });
    assert.throws(() => parseAgyUsage(json), pattern);
  };

  assertParseError({}, /groups must be an array/);
  assertParseError(
    { groups: ['not an object'] },
    /groups\[0\] must be an object/,
  );
  assertParseError(
    { groups: [{ name: '', buckets: [] }] },
    /groups\[0\]\.name must be a non-empty string/,
  );
  assertParseError(
    { groups: [{ name: 'G', buckets: 'not array' }] },
    /groups\[0\]\.buckets must be an array/,
  );
  assertParseError(
    { groups: [{ name: 'G', buckets: ['not object'] }] },
    /groups\[0\]\.buckets\[0\] must be an object/,
  );
  assertParseError(
    {
      groups: [
        {
          name: 'G',
          buckets: [
            {
              id: 'b',
              window: '5h',
              remaining_fraction: '1',
              reset_time: '2026-10-01',
            },
          ],
        },
      ],
    },
    /remaining_fraction must be a finite number/,
  );
  assertParseError(
    {
      groups: [
        {
          name: 'G',
          buckets: [
            {
              id: 'b',
              window: '',
              remaining_fraction: 1,
              reset_time: '2026-10-01',
            },
          ],
        },
      ],
    },
    /window must be a non-empty string/,
  );
  assertParseError(
    {
      groups: [
        {
          name: 'G',
          buckets: [
            { id: 'b', window: '5h', remaining_fraction: 1, reset_time: '' },
          ],
        },
      ],
    },
    /reset_time must be a non-empty string/,
  );

  const missingCommand = JSON.stringify({ event: 'command_result' });
  assert.throws(
    () => parseAgyUsage(missingCommand),
    /missing a command object/,
  );

  const missingData = JSON.stringify({ event: 'command_result', command: {} });
  assert.throws(() => parseAgyUsage(missingData), /missing command\.data/);
});

void test('parseAgyUsage rejects output without a command_result event', () => {
  assert.throws(
    () => parseAgyUsage(`${resultLine}\n`),
    /did not contain a command_result event line/,
  );
});

void test('parseAgyUsage ignores non-JSON noise lines', () => {
  const usage = parseAgyUsage(`warning: something\n${stdout}`);
  assert.equal(usage.groups.length, 3);
});

void test('getAgyUsage parses the spawned CLI output', async () => {
  const usage = await getAgyUsage(nodeEmitting(stdout));

  assert.equal(usage.agent, 'agy');
  assert.equal(usage.groups.length, 3);
});

void test('getAgyUsage rejects when the CLI exits non-zero', async () => {
  await assert.rejects(
    getAgyUsage({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("not logged in"); process.exit(3);'],
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
