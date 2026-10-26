import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAgentUsage, resolveAgyFamilies, weeklyPace, type AgentRunnerPolicy, type AgentUsageReasonCode } from '../index.js';

const now = Date.parse('2026-10-17T12:00:00Z');
const policy: AgentRunnerPolicy = { fiveHourMaxPercent: 80 };
const week = { maxPercent: 70, pacing: 'daily' as const };
const codex = () => ({ agent: 'codex', plan_type: 'pro', rate_limit: {
  allowed: true, limit_reached: false,
  primary_window: { used_percent: 79, limit_window_seconds: 18000, reset_after_seconds: 3600, limit_reached: false },
  secondary_window: { used_percent: 4, limit_window_seconds: 604800, reset_after_seconds: 6 * 86400, limit_reached: false },
} });
const claude = () => ({ agent: 'claude', five_hour: { utilization: 79, resets_at: '2026-10-17T17:00:00Z' },
  seven_day: { utilization: 4, resets_at: '2026-10-23T12:00:00Z' },
  seven_day_opus: { utilization: 20, resets_at: '2026-10-23T12:00:00Z' },
  seven_day_sonnet: { utilization: 10, resets_at: '2026-10-23T12:00:00Z' },
  limits: [] as Array<{ kind: string; percent: number; is_active: boolean; resets_at: null; group: null; scope: { model: { id: string | null; display_name: string } } | null }>, extra_usage: null });
const bucket = (window: string, remaining_fraction: number) => ({ id: `gemini-${window}`, name: window,
  window, normalized_window: window === '5h' ? 'five_hour' : 'seven_day', remaining_fraction,
  reset_time: '2026-10-23T12:00:00Z', limit_reached: false });
const agy = () => {
  const five_hour = bucket('5h', .21);
  const seven_day = bucket('weekly', .96);
  const group = { name: 'Gemini Models', families: ['gemini'], models: ['Gemini Flash'], buckets: [five_hour, seven_day], five_hour, seven_day };
  return { agent: 'agy', groups: [group], families: { gemini: { family: 'gemini', group_name: group.name, models: group.models, five_hour, seven_day }, argon: null, claude: null, gpt: null } };
};
const without = (payload: unknown, ...path: string[]): unknown => {
  const copy = structuredClone(payload) as Record<string, unknown>;
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  delete parent[path.at(-1)!];
  return copy;
};
type Fixture = { name: string; adapter: 'codex' | 'claude' | 'agy'; payload: unknown; model?: string; taskRunModel?: string; policy?: AgentRunnerPolicy; reason: AgentUsageReasonCode };
const fixtures: Fixture[] = [
  { name: 'Codex available', adapter: 'codex', payload: codex(), reason: 'available' },
  { name: 'Codex provider denied', adapter: 'codex', payload: { ...codex(), rate_limit: { ...codex().rate_limit, allowed: false } }, reason: 'provider_blocked' },
  ...(['primary_window', 'secondary_window'] as const).map((key): Fixture => ({ name: `Codex ${key} flag`, adapter: 'codex', payload: { ...codex(), rate_limit: { ...codex().rate_limit, [key]: { ...codex().rate_limit[key], limit_reached: true } } }, reason: 'quota_limit' })),
  { name: 'Codex overall flag', adapter: 'codex', payload: { ...codex(), rate_limit: { ...codex().rate_limit, limit_reached: true } }, reason: 'quota_limit' },
  { name: 'Codex reserve equality', adapter: 'codex', payload: { ...codex(), rate_limit: { ...codex().rate_limit, primary_window: { ...codex().rate_limit.primary_window, used_percent: 80 } } }, reason: 'five_hour_reserve' },
  { name: 'Claude partial account window', adapter: 'claude', payload: { ...claude(), seven_day: null }, model: 'claude-sonnet-4', reason: 'available' },
  { name: 'Claude missing all windows', adapter: 'claude', payload: { ...claude(), five_hour: null, seven_day: null, seven_day_sonnet: null, seven_day_opus: null }, reason: 'missing_window' },
  { name: 'Claude Sonnet scoped week', adapter: 'claude', payload: { ...claude(), seven_day_sonnet: { utilization: 100, resets_at: null } }, model: 'claude-sonnet-4', reason: 'quota_limit' },
  { name: 'Claude ignores other family', adapter: 'claude', payload: { ...claude(), seven_day_sonnet: { utilization: 100, resets_at: null } }, model: 'claude-opus-4', reason: 'available' },
  ...(['id', 'display_name'] as const).map((field): Fixture => { const p = claude(); p.limits = [{ kind: 'model', percent: 100, is_active: true, group: null, resets_at: null, scope: { model: { id: field === 'id' ? 'claude-sonnet-4' : null, display_name: field === 'display_name' ? 'Sonnet 4' : 'Other' } } }]; return { name: `Claude scoped ${field}`, adapter: 'claude', payload: p, model: field === 'id' ? 'claude-sonnet-4' : 'Sonnet 4', reason: 'quota_limit' }; }),
  { name: 'Claude inactive limit', adapter: 'claude', payload: { ...claude(), limits: [{ kind: 'account', percent: 100, is_active: false, group: null, resets_at: null, scope: null }] }, reason: 'available' },
  { name: 'Claude reserve equality', adapter: 'claude', payload: { ...claude(), five_hour: { utilization: 80, resets_at: null } }, reason: 'five_hour_reserve' },
  { name: 'Claude missing account week closes daily pace', adapter: 'claude', payload: { ...claude(), seven_day: null }, policy: { ...policy, sevenDay: week }, reason: 'weekly_pace' },
  { name: 'Agy registry Gemini despite task override to Argon', adapter: 'agy', payload: agy(), model: 'Gemini 3.8 Flash (High)', taskRunModel: 'Gemini 4 Argon', reason: 'available' },
  { name: 'Agy missing weekly', adapter: 'agy', payload: { ...agy(), families: { ...agy().families, gemini: { ...agy().families.gemini, seven_day: null } } }, reason: 'missing_window' },
  { name: 'Agy missing 5h', adapter: 'agy', payload: { ...agy(), families: { ...agy().families, gemini: { ...agy().families.gemini, five_hour: null } } }, reason: 'missing_window' },
  { name: 'Agy reserve equality', adapter: 'agy', payload: { ...agy(), families: { ...agy().families, gemini: { ...agy().families.gemini, five_hour: bucket('5h', .2) } } }, reason: 'five_hour_reserve' },
  { name: 'Agy remaining zero', adapter: 'agy', payload: { ...agy(), families: { ...agy().families, gemini: { ...agy().families.gemini, seven_day: bucket('weekly', 0) } } }, reason: 'quota_limit' },
  { name: 'Agy family unobserved', adapter: 'agy', payload: agy(), model: 'Claude Opus', reason: 'family_unobserved' },
  { name: 'Agy unknown model', adapter: 'agy', payload: agy(), model: 'mystery', reason: 'family_unknown' },
  { name: 'Agy empty groups', adapter: 'agy', payload: { ...agy(), groups: [] }, reason: 'missing_window' },
  { name: 'Malformed Codex', adapter: 'codex', payload: { agent: 'codex', rate_limit: {} }, reason: 'usage_unavailable' },
  { name: 'Codex missing plan type', adapter: 'codex', payload: without(codex(), 'plan_type'), reason: 'usage_unavailable' },
  ...(['primary_window', 'secondary_window'] as const).map((window): Fixture => ({
    name: `Codex ${window} missing window length`, adapter: 'codex',
    payload: without(codex(), 'rate_limit', window, 'limit_window_seconds'), reason: 'usage_unavailable',
  })),
  { name: 'Malformed Claude', adapter: 'claude', payload: { agent: 'claude', limits: 'bad' }, reason: 'usage_unavailable' },
  { name: 'Claude selected window missing reset', adapter: 'claude', payload: without(claude(), 'five_hour', 'resets_at'), reason: 'usage_unavailable' },
  { name: 'Claude unselected window missing reset', adapter: 'claude', payload: without(claude(), 'seven_day_opus', 'resets_at'), model: 'claude-sonnet-4', reason: 'usage_unavailable' },
  { name: 'Claude missing extra usage', adapter: 'claude', payload: without(claude(), 'extra_usage'), reason: 'usage_unavailable' },
  { name: 'Malformed Agy', adapter: 'agy', payload: { agent: 'agy', groups: [{ name: 'Gemini', buckets: 'bad' }] }, reason: 'missing_window' },
  { name: 'Malformed Agy bucket', adapter: 'agy', payload: { agent: 'agy', groups: [{ name: 'Gemini', buckets: [{ id: 3 }] }] }, reason: 'missing_window' },
  { name: 'Agy bucket missing reset', adapter: 'agy', payload: without(agy(), 'groups', '0', 'buckets', '0', 'reset_time'), reason: 'usage_unavailable' },
];
for (const fixture of fixtures) void test(fixture.name, () => {
  const result = evaluateAgentUsage(fixture.adapter, fixture.payload, fixture.model, fixture.policy ?? policy, null, now);
  assert.equal(result.reasonCode, fixture.reason);
  assert.equal(result.available, fixture.reason === 'available');
  assert.ok(result.reasonDetail.length <= 240);
  if (fixture.taskRunModel) {
    assert.deepEqual(resolveAgyFamilies(fixture.taskRunModel), ['argon']);
    assert.equal(result.quotaFamily, 'gemini');
  }
});

void test('Argon has only a weekly window and its own family', () => {
  const weekly = bucket('weekly', .5);
  const group = { name: 'Gemini 4 Argon', families: ['argon'], models: ['Gemini 4 Argon'], buckets: [weekly], five_hour: null, seven_day: weekly };
  const result = evaluateAgentUsage('agy', { agent: 'agy', groups: [group], families: { gemini: null, argon: { family: 'argon', group_name: group.name, models: group.models, five_hour: null, seven_day: weekly }, claude: null, gpt: null } }, 'Gemini 4 Argon', policy, null, now);
  assert.equal(result.reasonCode, 'available');
  assert.equal(result.quotaFamily, 'argon');
  assert.equal(result.fiveHourUsedPercent, null);
});

void test('weekly pace is inclusive at every day and weekly limit boundary', () => {
  const reset = '2026-10-24T12:00:00Z';
  for (let day = 0; day < 7; day++) {
    const at = now + day * 86400_000;
    const allowed = (day + 1) * 10;
    assert.deepEqual(weeklyPace(allowed, reset, week, undefined, at), { allowed, over: true });
    assert.equal(weeklyPace(allowed - .01, reset, week, undefined, at).over, false);
  }
  assert.deepEqual(weeklyPace(70, undefined, { maxPercent: 70, pacing: 'off' }, undefined, now), { allowed: 70, over: true });
  assert.equal(weeklyPace(undefined, reset, week, undefined, now).over, true);
});

void test('weekly reset fallback expires at one week and does not borrow phase', () => {
  const previous = '2026-10-16T12:00:00Z';
  assert.deepEqual(weeklyPace(1, undefined, week, previous, now), { allowed: 20, over: false });
  assert.deepEqual(weeklyPace(1, undefined, week, undefined, now), { allowed: 0, over: true });
  assert.deepEqual(weeklyPace(1, undefined, week, '2026-10-10T12:00:00Z', now), { allowed: 0, over: true });
  assert.equal(weeklyPace(1, undefined, week, '2026-10-24T12:00:00Z', now).over, false);
  assert.equal(weeklyPace(1, undefined, week, '2026-10-24T12:00:01Z', now).over, true);
});

void test('runner closes absent Agy family window even with account headroom', () => {
  // Both runner and capacity close a missing Agy family window (capacity.ts:123-126, 166-168).
  const payload = { ...agy(), families: { ...agy().families, gemini: { ...agy().families.gemini, five_hour: null } } };
  assert.equal(evaluateAgentUsage('agy', payload, undefined, policy, null, now).reasonCode, 'missing_window');
});

void test('runner and capacity differ at 100 percent when Codex reserve is zero', () => {
  // Runner codex-usage.ts:36-38 applies reserve only when it is positive;
  // tasks capacity.ts:168-170 independently blocks fiveHour >= max even at max=100.
  const payload = codex();
  payload.rate_limit.primary_window.used_percent = 100;
  const result = evaluateAgentUsage('codex', payload, undefined, { fiveHourMaxPercent: 100 }, null, now);
  assert.equal(result.reasonCode, 'available');
});

void test('Agy exact group override reads the named group', () => {
  const payload = agy();
  const weekly = bucket('weekly', .5);
  const group = { name: 'Gemini 4 Argon', families: ['argon'], models: ['Gemini 4 Argon'], buckets: [weekly], five_hour: null, seven_day: weekly };
  const result = evaluateAgentUsage('agy', { ...payload, groups: [...payload.groups, group] }, 'Gemini 3.8 Flash (High)', { ...policy, agyGroup: 'gemini 4 argon' }, null, now);
  assert.equal(result.quotaFamily, 'Gemini 4 Argon');
  assert.equal(result.reasonCode, 'available');
});

void test('Agy limit flag closes even with remaining fraction', () => {
  const payload = agy();
  payload.families.gemini.seven_day = { ...payload.families.gemini.seven_day, limit_reached: true };
  assert.equal(evaluateAgentUsage('agy', payload, undefined, policy, null, now).reasonCode, 'quota_limit');
});

void test('Agy null reset keeps exhausted family closed and healthy family available', () => {
  const payload = agy();
  const exhausted = { ...bucket('5h', 0), id: '3p-5h', reset_time: null, limit_reached: true };
  const weekly = { ...bucket('weekly', 1), id: '3p-weekly' };
  const group = { name: 'Claude and GPT models', families: ['claude', 'gpt'], models: ['Claude Opus', 'GPT-OSS'],
    buckets: [exhausted, weekly], five_hour: exhausted, seven_day: weekly };
  const families = { ...payload.families, claude: { family: 'claude', group_name: group.name, models: group.models, five_hour: exhausted, seven_day: weekly },
    gpt: { family: 'gpt', group_name: group.name, models: group.models, five_hour: exhausted, seven_day: weekly } };
  const usage = { ...payload, groups: [...payload.groups, group], families };
  assert.equal(evaluateAgentUsage('agy', usage, 'Gemini 3.8 Flash (High)', policy, null, now).reasonCode, 'available');
  const claude = evaluateAgentUsage('agy', usage, 'Claude Opus', policy, null, now);
  assert.equal(claude.reasonCode, 'quota_limit');
  assert.equal(claude.fiveHourResetAt, null);
  assert.equal(claude.fiveHourUsedPercent, 100);
  assert.equal(evaluateAgentUsage('agy', usage, 'GPT-OSS', policy, null, now).reasonCode, 'quota_limit');
  const broken = structuredClone(usage) as Record<string, unknown>;
  (broken.families as Record<string, unknown>).claude = { family: 'claude', five_hour: 'bad' };
  assert.equal(evaluateAgentUsage('agy', broken, 'Gemini 3.8 Flash (High)', policy, null, now).reasonCode, 'available');
  assert.equal(evaluateAgentUsage('agy', broken, 'Claude Opus', policy, null, now).reasonCode, 'usage_unavailable');
});

void test('unknown Claude model applies every active scoped limit', () => {
  const payload = claude();
  payload.limits.push({ kind: 'model', percent: 100, is_active: true, group: null, resets_at: null,
    scope: { model: { id: 'opus-only', display_name: 'Opus' } } });
  assert.equal(evaluateAgentUsage('claude', payload, undefined, policy, null, now).reasonCode, 'quota_limit');
});

void test('evaluator uses only the supplied reset fallback for daily pace', () => {
  const payload = claude();
  payload.seven_day.resets_at = '';
  const dailyPolicy = { ...policy, sevenDay: week };
  assert.equal(evaluateAgentUsage('claude', payload, undefined, dailyPolicy, null, now).reasonCode, 'weekly_pace');
  assert.equal(evaluateAgentUsage('claude', payload, undefined, dailyPolicy, '2026-10-16T12:00:00Z', now).reasonCode, 'available');
});
