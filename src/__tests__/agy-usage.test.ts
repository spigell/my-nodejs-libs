import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getAgyUsage,
  parseAgyUsage,
  resolveAgyFamilies,
} from '../agents/agy-usage.js';

/**
 * Captured verbatim from `agy -p '/usage' --dangerously-skip-permissions
 * --output-format stream-json` on agy 1.3.3 (October 2026). The trailing `result`
 * line is included because the parser must ignore it and read only
 * `command_result`.
 *
 * Upstream observation:
 * - Gemini Models: weekly (`gemini-weekly`) and five-hour (`gemini-5h`)
 * - Claude and GPT models: weekly (`3p-weekly`) and five-hour (`3p-5h`)
 * - Gemini 4 Argon: weekly (`gemini-argon-wtu-weekly`) only. Upstream agy CLI emits
 *   no five-hour bucket for Argon; the absent window originates directly from the
 *   provider/CLI layer, not sidecar parsing or downstream metric normalization.
 */
const commandResultLine = JSON.stringify({
  event: 'command_result',
  command: {
    name: 'usage',
    data: {
      description:
        'Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models. The 5-hour limit smooths out aggregate demand to fairly distribute global capacity across all users, while your weekly limit is tied directly to your individual tier.',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              description:
                'You have used some of your weekly limit, it will fully refresh in 6 days, 11 hours.',
              window: 'weekly',
              remaining_fraction: 0.9186660051345825,
              reset_time: '2026-10-24T00:00:28Z',
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              description:
                'You have used some of your 5-hour limit, it will fully refresh in 4 hours, 39 minutes.',
              window: '5h',
              remaining_fraction: 0.9433193802833557,
              reset_time: '2026-10-17T16:59:43Z',
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
              remaining_fraction: 1,
              reset_time: '2026-10-24T12:20:07Z',
            },
            {
              id: '3p-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 1,
              reset_time: '2026-10-17T17:20:07Z',
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
              reset_time: '2026-10-24T12:20:07Z',
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
    response:
      'Gemini Models\tWeekly Limit Remaining\t92%\t2026-10-24T00:00:28Z\nGemini Models\tFive Hour Limit Remaining\t94%\t2026-10-17T16:59:43Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-24T12:20:07Z\nClaude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-17T17:20:07Z\nGemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-10-24T12:20:07Z\n',
    duration_seconds: 0,
    num_turns: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
    },
    command: {
      name: 'usage',
      data: {
        description:
          'Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models. The 5-hour limit smooths out aggregate demand to fairly distribute global capacity across all users, while your weekly limit is tied directly to your individual tier.',
        groups: [
          {
            name: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              {
                id: 'gemini-weekly',
                name: 'Weekly Limit Remaining',
                description:
                  'You have used some of your weekly limit, it will fully refresh in 6 days, 11 hours.',
                window: 'weekly',
                remaining_fraction: 0.9186660051345825,
                reset_time: '2026-10-24T00:00:28Z',
              },
              {
                id: 'gemini-5h',
                name: 'Five Hour Limit Remaining',
                description:
                  'You have used some of your 5-hour limit, it will fully refresh in 4 hours, 39 minutes.',
                window: '5h',
                remaining_fraction: 0.9433193802833557,
                reset_time: '2026-10-17T16:59:43Z',
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
                remaining_fraction: 1,
                reset_time: '2026-10-24T12:20:07Z',
              },
              {
                id: '3p-5h',
                name: 'Five Hour Limit Remaining',
                window: '5h',
                remaining_fraction: 1,
                reset_time: '2026-10-17T17:20:07Z',
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
                reset_time: '2026-10-24T12:20:07Z',
              },
            ],
          },
        ],
      },
    },
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
  assert.deepEqual(argon?.models, []);

  const weekly = gemini?.buckets.find(
    (bucket) => bucket.id === 'gemini-weekly',
  );
  assert.equal(weekly?.window, 'weekly');
  assert.equal(weekly?.normalized_window, 'seven_day');
  assert.equal(weekly?.remaining_fraction, 0.9186660051345825);
  assert.equal(weekly?.reset_time, '2026-10-24T00:00:28Z');
  assert.equal(weekly?.limit_reached, false);

  const fiveHour = gemini?.buckets.find((bucket) => bucket.id === 'gemini-5h');
  assert.equal(fiveHour?.window, '5h');
  assert.equal(fiveHour?.normalized_window, 'five_hour');
  assert.equal(fiveHour?.remaining_fraction, 0.9433193802833557);
  assert.equal(fiveHour?.reset_time, '2026-10-17T16:59:43Z');
  assert.equal(fiveHour?.limit_reached, false);
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
  const exhaustedPayload = JSON.stringify({
    event: 'command_result',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Exhausted Group',
            description: 'Custom',
            buckets: [
              {
                id: 'exhausted-5h',
                window: '5h',
                remaining_fraction: 0,
                reset_time: '2026-10-17T17:00:00Z',
              },
            ],
          },
        ],
      },
    },
  });
  const usage = parseAgyUsage(exhaustedPayload);
  const exhausted = usage.groups[0]?.buckets[0];

  assert.equal(exhausted?.remaining_fraction, 0);
  assert.equal(exhausted?.limit_reached, true);
});

void test('resolveAgyFamilies distinguishes group models from explanatory prose', () => {
  // Description mentions Argon in explanatory prose, but the group and models are Gemini
  const geminiFamilies = resolveAgyFamilies(
    'Gemini Models',
    'Models within this group: Gemini Flash, Gemini Pro. Argon quota is separate.',
  );
  assert.deepEqual(geminiFamilies, ['gemini']);

  // Explanatory prose mentioning Argon without "Models within this group:"
  const geminiProseFamilies = resolveAgyFamilies(
    'Gemini Models',
    'Argon quota is separate.',
  );
  assert.deepEqual(geminiProseFamilies, ['gemini']);

  // Description mentions Gemini in explanatory prose, but the group is Argon
  const argonFamilies = resolveAgyFamilies(
    'Gemini 4 Argon',
    'For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.',
  );
  assert.deepEqual(argonFamilies, ['argon']);
});

void test('parseAgyUsage correctly resolves families when descriptions contain explanatory prose mentioning other families', () => {
  const payload = JSON.stringify({
    event: 'command_result',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            description:
              'Models within this group: Gemini Flash, Gemini Pro. Argon quota is separate.',
            buckets: [
              {
                id: 'gemini-weekly',
                window: 'weekly',
                remaining_fraction: 0.9,
                reset_time: '2026-10-24T00:00:00Z',
              },
              {
                id: 'gemini-5h',
                window: '5h',
                remaining_fraction: 0.8,
                reset_time: '2026-10-17T17:00:00Z',
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
                window: 'weekly',
                remaining_fraction: 1.0,
                reset_time: '2026-10-24T12:00:00Z',
              },
            ],
          },
        ],
      },
    },
  });

  const usage = parseAgyUsage(payload);
  assert.deepEqual(usage.groups[0]?.families, ['gemini']);
  assert.deepEqual(usage.groups[0]?.models, ['Gemini Flash', 'Gemini Pro']);
  assert.equal(usage.families.gemini?.group_name, 'Gemini Models');
  assert.equal(usage.families.gemini?.five_hour?.id, 'gemini-5h');
  assert.equal(usage.families.gemini?.seven_day?.id, 'gemini-weekly');

  assert.deepEqual(usage.groups[1]?.families, ['argon']);
  assert.equal(usage.families.argon?.group_name, 'Gemini 4 Argon');
  assert.equal(usage.families.argon?.five_hour, null);
  assert.equal(usage.families.argon?.seven_day?.id, 'gemini-argon-wtu-weekly');
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
