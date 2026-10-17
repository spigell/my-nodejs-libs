import { agyFamilyGroups, resolveAgyFamilies, type AgyModelFamily, type AgyUsage, type AgyUsageBucket, type AgyUsageGroup } from './agy-usage.js';
import type { ClaudeUsage, ClaudeUsageLimit, ClaudeUsageWindow } from './claude-usage.js';
import type { CodexUsage } from './codex-usage.js';
import { getModelSlugEntry } from './model-slugs.js';
import type { AgentUsageKind } from './usage-proxy.js';

export type AgentWeeklyPolicy = { maxPercent: number; pacing: 'off' | 'daily' };
export type AgentRunnerPolicy = {
  fiveHourMaxPercent: number;
  sevenDay?: AgentWeeklyPolicy;
  /** Exact reported group override, when explicitly stored in registry policy. */
  agyGroup?: string;
};
export type AgentUsageReasonCode =
  | 'available' | 'usage_unavailable' | 'provider_blocked' | 'quota_limit'
  | 'five_hour_reserve' | 'weekly_pace' | 'missing_window'
  | 'family_unknown' | 'family_ambiguous' | 'family_unobserved';
export type AgentUsageVerdict = {
  available: boolean;
  reasonCode: AgentUsageReasonCode;
  reasonDetail: string;
  quotaFamily: string | null;
  fiveHourUsedPercent: number | null;
  fiveHourMaxPercent: number;
  sevenDayUsedPercent: number | null;
  sevenDayMaxPercent: number | null;
  sevenDayAllowedPercent: number | null;
  familySevenDayUsedPercent: number | null;
  fiveHourResetAt: string | null;
  sevenDayResetAt: string | null;
  familySevenDayResetAt: string | null;
};

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const claudeWindow = (value: unknown): boolean => {
  if (value === null) return true;
  const window = object(value);
  return !!window && finite(window.utilization) && nullableString(window.resets_at);
};
const claudeLimit = (value: unknown): boolean => {
  const limit = object(value);
  if (!limit || typeof limit.kind !== 'string' || !limit.kind || !finite(limit.percent) ||
      typeof limit.is_active !== 'boolean' || !nullableString(limit.group) || !nullableString(limit.resets_at)) return false;
  if (limit.scope === null) return true;
  const scope = object(limit.scope);
  if (!scope) return false;
  if (scope.model === null) return true;
  const model = object(scope.model);
  return !!model && nullableString(model.id) && typeof model.display_name === 'string';
};
const claudePayload = (root: Record<string, unknown>): boolean => {
  const extra = root.extra_usage === null ? null : object(root.extra_usage);
  return ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'].every((key) => claudeWindow(root[key])) &&
    Array.isArray(root.limits) && root.limits.every(claudeLimit) &&
    (root.extra_usage === null || (!!extra && typeof extra.is_enabled === 'boolean' &&
      ['monthly_limit', 'used_credits', 'utilization'].every((key) => extra[key] === null || finite(extra[key])) &&
      nullableString(extra.currency)));
};
const agyBucket = (value: unknown): boolean => {
  const bucket = object(value);
  return !!bucket && typeof bucket.id === 'string' && !!bucket.id.trim() &&
    typeof bucket.name === 'string' && typeof bucket.window === 'string' && !!bucket.window.trim() &&
    typeof bucket.normalized_window === 'string' && finite(bucket.remaining_fraction) &&
    bucket.remaining_fraction >= 0 && bucket.remaining_fraction <= 1 &&
    typeof bucket.reset_time === 'string' && !!bucket.reset_time.trim() && typeof bucket.limit_reached === 'boolean';
};
const agyFamily = (value: unknown): boolean => {
  if (value === null) return true;
  const family = object(value);
  return !!family && ['gemini', 'argon', 'claude', 'gpt'].includes(family.family as string) &&
    typeof family.group_name === 'string' && Array.isArray(family.models) &&
    family.models.every((model: unknown) => typeof model === 'string') &&
    (family.five_hour === null || agyBucket(family.five_hour)) &&
    (family.seven_day === null || agyBucket(family.seven_day));
};
const agyPayload = (root: Record<string, unknown>): boolean => {
  const families = object(root.families);
  return Array.isArray(root.groups) && root.groups.every((value: unknown) => {
    const group = object(value);
    return !!group && typeof group.name === 'string' && !!group.name.trim() &&
      Array.isArray(group.families) && group.families.every((family: unknown) =>
        ['gemini', 'argon', 'claude', 'gpt'].includes(family as string)) &&
      Array.isArray(group.models) && group.models.every((model: unknown) => typeof model === 'string') &&
      Array.isArray(group.buckets) && group.buckets.every(agyBucket) &&
      (group.five_hour === null || agyBucket(group.five_hour)) &&
      (group.seven_day === null || agyBucket(group.seven_day));
  }) && !!families && ['gemini', 'argon', 'claude', 'gpt'].every((key) => agyFamily(families[key]));
};
const validDate = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const isoAfter = (now: number, seconds: unknown): string | null => {
  if (!finite(seconds)) return null;
  const date = new Date(now + seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const detail = (value: string): string => value.slice(0, 240);

/** The runner's cumulative weekly budget, including its inclusive equality boundary. */
export function weeklyPace(
  usedPercent: number | undefined,
  resetTime: string | undefined,
  policy: AgentWeeklyPolicy,
  lastKnownReset: string | undefined,
  now: number,
): { allowed: number; over: boolean } {
  if (policy.pacing === 'off') return { allowed: policy.maxPercent, over: usedPercent === undefined || !finite(usedPercent) || usedPercent >= policy.maxPercent };
  let next = resetTime ? Date.parse(resetTime) : NaN;
  if (!Number.isFinite(next)) {
    const known = lastKnownReset ? Date.parse(lastKnownReset) : NaN;
    if (!Number.isFinite(known) || now - known >= WEEK || known - now > WEEK) return { allowed: 0, over: true };
    next = known + Math.max(0, Math.floor((now - known) / WEEK) + 1) * WEEK;
  }
  const index = Math.max(0, Math.min(6, Math.floor((now - (next - WEEK)) / DAY)));
  const allowed = Math.min(policy.maxPercent, (index + 1) * policy.maxPercent / 7);
  return { allowed, over: usedPercent === undefined || !finite(usedPercent) || usedPercent >= allowed };
}

/** Evaluates one normalized sidecar response for one registry agent and runner policy. */
export function evaluateAgentUsage(
  adapter: AgentUsageKind,
  payload: unknown,
  defaultModel: string | null | undefined,
  runnerPolicy: AgentRunnerPolicy,
  lastKnownReset: string | null | undefined,
  now: number,
): AgentUsageVerdict {
  const verdict: AgentUsageVerdict = {
    available: false, reasonCode: 'usage_unavailable', reasonDetail: 'Invalid usage payload',
    quotaFamily: null, fiveHourUsedPercent: null, fiveHourMaxPercent: runnerPolicy.fiveHourMaxPercent,
    sevenDayUsedPercent: null, sevenDayMaxPercent: runnerPolicy.sevenDay?.maxPercent ?? null,
    sevenDayAllowedPercent: null, familySevenDayUsedPercent: null,
    fiveHourResetAt: null, sevenDayResetAt: null, familySevenDayResetAt: null,
  };
  const close = (code: AgentUsageReasonCode, message: string): AgentUsageVerdict => {
    verdict.reasonCode = code;
    verdict.reasonDetail = detail(message);
    return verdict;
  };
  const root = object(payload);
  if (!Number.isFinite(now) || !finite(runnerPolicy.fiveHourMaxPercent) ||
      (runnerPolicy.sevenDay && (!finite(runnerPolicy.sevenDay.maxPercent) || !['off', 'daily'].includes(runnerPolicy.sevenDay.pacing))) ||
      !root || root.agent !== adapter) return verdict;
  const reserve = 100 - runnerPolicy.fiveHourMaxPercent;
  let weeklyUsed: number | undefined;
  let weeklyReset: string | null = null;
  let blocked: { code: AgentUsageReasonCode; message: string } | null = null;
  const block = (code: AgentUsageReasonCode, message: string) => { blocked ??= { code, message }; };

  if (adapter === 'codex') {
    const rate = object(root.rate_limit);
    const primary = object(rate?.primary_window);
    const secondary = object(rate?.secondary_window);
    if (typeof root.plan_type !== 'string' || !rate || !primary || !secondary ||
        typeof rate.allowed !== 'boolean' || typeof rate.limit_reached !== 'boolean' ||
        !finite(primary.used_percent) || !finite(secondary.used_percent) ||
        !finite(primary.limit_window_seconds) || !finite(secondary.limit_window_seconds) ||
        typeof primary.limit_reached !== 'boolean' || typeof secondary.limit_reached !== 'boolean' ||
        !finite(primary.reset_after_seconds) || !finite(secondary.reset_after_seconds)) return verdict;
    const usage = payload as CodexUsage;
    verdict.fiveHourUsedPercent = usage.rate_limit.primary_window.used_percent;
    verdict.sevenDayUsedPercent = usage.rate_limit.secondary_window.used_percent;
    verdict.fiveHourResetAt = isoAfter(now, primary.reset_after_seconds);
    weeklyReset = isoAfter(now, secondary.reset_after_seconds);
    verdict.sevenDayResetAt = weeklyReset;
    weeklyUsed = verdict.sevenDayUsedPercent;
    if (!rate.allowed) block('provider_blocked', 'Provider disallows requests');
    if (primary.limit_reached) block('quota_limit', 'Primary window limit reached');
    if (reserve > 0 && verdict.fiveHourUsedPercent + reserve >= 100) block('five_hour_reserve', 'Primary window reserve reached');
    if (secondary.limit_reached) block('quota_limit', 'Secondary window limit reached');
    if (rate.limit_reached) block('quota_limit', 'Overall account limit reached');
  } else if (adapter === 'claude') {
    if (!claudePayload(root)) return verdict;
    const usage = payload as ClaudeUsage;
    const model = defaultModel?.trim().toLowerCase();
    const slugEntry = model ? getModelSlugEntry(model) : undefined;
    const family = (slugEntry && slugEntry.family !== undefined ? slugEntry.family : null) ?? (model?.includes('opus') ? 'opus' : model?.includes('sonnet') ? 'sonnet' : null);
    verdict.quotaFamily = family;
    const selected: Array<[string, ClaudeUsageWindow | null]> = [
      ['5h', usage.five_hour], ['7d', usage.seven_day],
      ...(family === 'opus' ? [['7d opus', usage.seven_day_opus] as [string, ClaudeUsageWindow | null]] : []),
      ...(family === 'sonnet' ? [['7d sonnet', usage.seven_day_sonnet] as [string, ClaudeUsageWindow | null]] : []),
    ];
    for (const [label, window] of selected) {
      if (window == null) continue;
      if (!object(window) || !finite(window.utilization)) return verdict;
      if (label === '5h') {
        verdict.fiveHourUsedPercent = window.utilization;
        verdict.fiveHourResetAt = validDate(window.resets_at);
      } else if (label === '7d') {
        verdict.sevenDayUsedPercent = window.utilization;
        verdict.sevenDayResetAt = validDate(window.resets_at);
        weeklyUsed = window.utilization;
        weeklyReset = verdict.sevenDayResetAt;
      } else {
        verdict.familySevenDayUsedPercent = window.utilization;
        verdict.familySevenDayResetAt = validDate(window.resets_at);
      }
      if (window.utilization >= 100) block('quota_limit', `${label} limit exhausted`);
      if (label === '5h' && reserve > 0 && window.utilization + reserve >= 100) block('five_hour_reserve', '5h reserve reached');
    }
    if (selected.every(([, window]) => !window)) block('missing_window', 'No rate-limit windows');
    for (const item of usage.limits) {
      const limit = object(item);
      if (!limit || typeof limit.is_active !== 'boolean' || !finite(limit.percent)) return close('usage_unavailable', 'Invalid Claude limit');
      const typed: ClaudeUsageLimit = item;
      if (!typed.is_active || typed.percent < 100) continue;
      const scoped = typed.scope?.model;
      const applies = !scoped || !model || [scoped.id, scoped.display_name]
        .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
        .some((name) => {
          const candidate = name.trim().toLowerCase();
          if (candidate === model || model.includes(candidate) || candidate.includes(model)) return true;
          if (slugEntry) {
            return slugEntry.usageNames.some((u) => {
              const uLower = u.toLowerCase();
              return candidate === uLower || candidate.includes(uLower) || uLower.includes(candidate);
            });
          }
          return false;
        });
      if (applies) block('quota_limit', `${typed.kind} limit exhausted`);
    }
  } else if (adapter === 'agy') {
    if (!agyPayload(root)) return verdict;
    if ((root.groups as unknown[]).length === 0) return close('missing_window', 'No Agy quota groups');
    const usage = payload as AgyUsage;
    const groups = usage.groups;
    if (groups.some((group) => !object(group) || typeof group.name !== 'string' || !Array.isArray(group.buckets) ||
        (group.families != null && (!Array.isArray(group.families) || group.families.some((family) => typeof family !== 'string'))) ||
        (group.models != null && (!Array.isArray(group.models) || group.models.some((model) => typeof model !== 'string'))) ||
        group.buckets.some((bucket) => !object(bucket) || typeof bucket.id !== 'string' ||
          typeof bucket.name !== 'string' || typeof bucket.window !== 'string' ||
          !finite(bucket.remaining_fraction) || typeof bucket.limit_reached !== 'boolean'))) return verdict;
    let fiveHour: AgyUsageBucket | null;
    let sevenDay: AgyUsageBucket | null;
    let weeklyOnly: boolean;
    const groupName = runnerPolicy.agyGroup?.trim();
    const familiesOf = (group: AgyUsageGroup): AgyModelFamily[] => group.families?.length
      ? group.families : resolveAgyFamilies(group.name, undefined, group.buckets, group.models);
    const windowOf = (group: AgyUsageGroup, kind: 'five_hour' | 'seven_day'): AgyUsageBucket | null =>
      group[kind] ?? group.buckets?.find((bucket) => bucket.normalized_window === kind ||
        (kind === 'five_hour' ? ['5h', '18000'] : ['weekly', '7d', '604800']).includes(bucket.window)) ?? null;
    if (groupName) {
      const group = groups.find((candidate) => candidate.name.trim().toLowerCase() === groupName.toLowerCase());
      if (!group) return close('family_unobserved', 'Configured Agy group not observed');
      verdict.quotaFamily = group.name;
      weeklyOnly = familiesOf(group).length > 0 && familiesOf(group).every((family) => family === 'argon');
      fiveHour = windowOf(group, 'five_hour');
      sevenDay = windowOf(group, 'seven_day');
    } else {
      const families = resolveAgyFamilies(defaultModel ?? 'Gemini 3.8 Flash (High)');
      if (families.length === 0) return close('family_unknown', 'Default model has no quota family');
      if (families.length > 1) return close('family_ambiguous', 'Default model has multiple quota families');
      const family = families[0]!;
      verdict.quotaFamily = family;
      weeklyOnly = family === 'argon';
      const observed = usage.families?.[family];
      if (observed) {
        fiveHour = observed.five_hour;
        sevenDay = observed.seven_day;
      } else {
        const owner = agyFamilyGroups(groups.map((group) => ({ ...group, families: familiesOf(group) }))).get(family);
        if (!owner) return close('family_unobserved', 'Default model family not observed');
        fiveHour = windowOf(owner, 'five_hour');
        sevenDay = windowOf(owner, 'seven_day');
      }
    }
    for (const bucket of [fiveHour, sevenDay]) {
      if (bucket && (!object(bucket) || !finite(bucket.remaining_fraction) || typeof bucket.limit_reached !== 'boolean')) return verdict;
    }
    if (fiveHour) {
      verdict.fiveHourUsedPercent = (1 - fiveHour.remaining_fraction) * 100;
      verdict.fiveHourResetAt = validDate(fiveHour.reset_time);
    }
    if (sevenDay) {
      verdict.sevenDayUsedPercent = (1 - sevenDay.remaining_fraction) * 100;
      verdict.familySevenDayUsedPercent = verdict.sevenDayUsedPercent;
      weeklyUsed = verdict.sevenDayUsedPercent;
      weeklyReset = validDate(sevenDay.reset_time);
      verdict.sevenDayResetAt = weeklyReset;
      verdict.familySevenDayResetAt = weeklyReset;
    }
    if (!sevenDay) block('missing_window', 'Weekly family window missing');
    if (!weeklyOnly && !fiveHour) block('missing_window', 'Five-hour family window missing');
    for (const bucket of [fiveHour, sevenDay]) {
      if (!bucket) continue;
      if (bucket.limit_reached || bucket.remaining_fraction <= 0) block('quota_limit', `${bucket.window} family limit exhausted`);
      else if (reserve > 0 && bucket === fiveHour && bucket.remaining_fraction <= reserve / 100) block('five_hour_reserve', 'Five-hour family reserve reached');
    }
  } else return verdict;

  if (runnerPolicy.sevenDay) {
    const pace = weeklyPace(weeklyUsed, weeklyReset ?? undefined, runnerPolicy.sevenDay, lastKnownReset ?? undefined, now);
    verdict.sevenDayAllowedPercent = pace.allowed;
    if (pace.over) block('weekly_pace', `Weekly pace reached: ${weeklyUsed === undefined ? 'unknown' : weeklyUsed.toFixed(2)}% used, ${pace.allowed.toFixed(2)}% allowed`);
  }
  if (blocked) {
    const result: { code: AgentUsageReasonCode; message: string } = blocked;
    return close(result.code, result.message);
  }
  verdict.available = true;
  return close('available', 'Usage available');
}
