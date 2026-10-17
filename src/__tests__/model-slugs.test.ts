import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateAgentUsage,
  getModelSlugEntry,
  MODEL_SLUG_MAP,
  resolveAgyFamilies,
  type AgentRunnerPolicy,
  type AgyModelFamily,
} from '../index.js';

const now = Date.parse('2026-10-17T12:00:00Z');
const policy: AgentRunnerPolicy = { fiveHourMaxPercent: 80 };

const claudeBase = () => ({
  agent: 'claude' as const,
  five_hour: { utilization: 20, resets_at: '2026-10-17T17:00:00Z' },
  seven_day: { utilization: 20, resets_at: '2026-10-23T12:00:00Z' },
  seven_day_opus: { utilization: 20, resets_at: '2026-10-23T12:00:00Z' },
  seven_day_sonnet: { utilization: 20, resets_at: '2026-10-23T12:00:00Z' },
  limits: [] as Array<{
    kind: string;
    percent: number;
    is_active: boolean;
    resets_at: null;
    group: null;
    scope: { model: { id: string | null; display_name: string } } | null;
  }>,
  extra_usage: null,
});

const bucket = (window: string, remaining_fraction: number) => ({
  id: `bucket-${window}`,
  name: window,
  window,
  normalized_window: window === '5h' ? 'five_hour' : 'seven_day',
  remaining_fraction,
  reset_time: '2026-10-23T12:00:00Z',
  limit_reached: false,
});

const agyComprehensivePayload = () => {
  const gemini5h = bucket('5h', 0.8);
  const geminiWeekly = bucket('weekly', 0.8);
  const geminiGroup = {
    name: 'Gemini Models',
    families: ['gemini' as AgyModelFamily],
    models: ['Gemini Flash', 'Gemini Pro'],
    buckets: [gemini5h, geminiWeekly],
    five_hour: gemini5h,
    seven_day: geminiWeekly,
  };

  const argonWeekly = bucket('weekly', 0.8);
  const argonGroup = {
    name: 'Gemini 4 Argon',
    families: ['argon' as AgyModelFamily],
    models: ['Gemini 4 Argon'],
    buckets: [argonWeekly],
    five_hour: null,
    seven_day: argonWeekly,
  };

  const thirdParty5h = bucket('5h', 0.8);
  const thirdPartyWeekly = bucket('weekly', 0.8);
  const thirdPartyGroup = {
    name: 'Claude and GPT models',
    families: ['claude' as AgyModelFamily, 'gpt' as AgyModelFamily],
    models: ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'],
    buckets: [thirdParty5h, thirdPartyWeekly],
    five_hour: thirdParty5h,
    seven_day: thirdPartyWeekly,
  };

  return {
    agent: 'agy' as const,
    groups: [geminiGroup, argonGroup, thirdPartyGroup],
    families: {
      gemini: {
        family: 'gemini' as const,
        group_name: geminiGroup.name,
        models: geminiGroup.models,
        five_hour: gemini5h,
        seven_day: geminiWeekly,
      },
      argon: {
        family: 'argon' as const,
        group_name: argonGroup.name,
        models: argonGroup.models,
        five_hour: null,
        seven_day: argonWeekly,
      },
      claude: {
        family: 'claude' as const,
        group_name: thirdPartyGroup.name,
        models: thirdPartyGroup.models,
        five_hour: thirdParty5h,
        seven_day: thirdPartyWeekly,
      },
      gpt: {
        family: 'gpt' as const,
        group_name: thirdPartyGroup.name,
        models: thirdPartyGroup.models,
        five_hour: thirdParty5h,
        seven_day: thirdPartyWeekly,
      },
    },
  };
};

const codexBase = () => ({
  agent: 'codex' as const,
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 20,
      limit_window_seconds: 18000,
      reset_after_seconds: 3600,
      limit_reached: false,
    },
    secondary_window: {
      used_percent: 20,
      limit_window_seconds: 604800,
      reset_after_seconds: 86400 * 6,
      limit_reached: false,
    },
  },
});

type AgySlugSpec = {
  slug: string;
  expectedFamily: AgyModelFamily;
  pairedDisplayName: string;
};

const AGY_SLUGS: readonly AgySlugSpec[] = [
  // Gemini 3.8 Flash
  {
    slug: 'gemini-3.8-flash-high',
    expectedFamily: 'gemini',
    pairedDisplayName: 'Gemini 3.8 Flash (High)',
  },
  {
    slug: 'gemini-3.8-flash-medium',
    expectedFamily: 'gemini',
    pairedDisplayName: 'Gemini 3.8 Flash (Medium)',
  },
  {
    slug: 'gemini-3.8-flash-low',
    expectedFamily: 'gemini',
    pairedDisplayName: 'Gemini 3.8 Flash (Low)',
  },
  // Gemini 3.7 Flash
  {
    slug: 'gemini-3.7-flash-high',
    expectedFamily: 'gemini',
    pairedDisplayName: 'Gemini 3.7 Flash (High)',
  },
  {
    slug: 'gemini-3.7-flash-medium',
    expectedFamily: 'gemini',
    pairedDisplayName: 'Gemini 3.7 Flash (Medium)',
  },
  {
    slug: 'gemini-3.7-flash-low',
    expectedFamily: 'gemini',
    pairedDisplayName: 'Gemini 3.7 Flash (Low)',
  },
  // Gemini 3.6 Flash
  {
    slug: 'gemini-3.6-flash-high',
    expectedFamily: 'gemini',
    pairedDisplayName: 'Gemini 3.6 Flash (High)',
  },
  {
    slug: 'gemini-3.6-flash-medium',
    expectedFamily: 'gemini',
    pairedDisplayName: 'Gemini 3.6 Flash (Medium)',
  },
  {
    slug: 'gemini-3.6-flash-low',
    expectedFamily: 'gemini',
    pairedDisplayName: 'Gemini 3.6 Flash (Low)',
  },
  // Gemini 3.1 Pro
  {
    slug: 'gemini-3.1-pro-high',
    expectedFamily: 'gemini',
    pairedDisplayName: 'Gemini 3.1 Pro (High)',
  },
  {
    slug: 'gemini-3.1-pro-low',
    expectedFamily: 'gemini',
    pairedDisplayName: 'Gemini 3.1 Pro (Low)',
  },
  // Gemini 4 Argon
  {
    slug: 'gemini-4-argon-high',
    expectedFamily: 'argon',
    pairedDisplayName: 'Gemini 4 Argon (High)',
  },
  {
    slug: 'gemini-4-argon-medium',
    expectedFamily: 'argon',
    pairedDisplayName: 'Gemini 4 Argon (Medium)',
  },
  {
    slug: 'gemini-4-argon-low',
    expectedFamily: 'argon',
    pairedDisplayName: 'Gemini 4 Argon (Low)',
  },
  // Claude Opus in Agy
  {
    slug: 'claude-opus-5-5-high',
    expectedFamily: 'claude',
    pairedDisplayName: 'Claude Opus 5.5 (High)',
  },
  {
    slug: 'claude-opus-5-5-medium',
    expectedFamily: 'claude',
    pairedDisplayName: 'Claude Opus 5.5 (Medium)',
  },
  {
    slug: 'claude-opus-5-5-low',
    expectedFamily: 'claude',
    pairedDisplayName: 'Claude Opus 5.5 (Low)',
  },
  // Claude Sonnet in Agy
  {
    slug: 'claude-sonnet-5-5-high',
    expectedFamily: 'claude',
    pairedDisplayName: 'Claude Sonnet 5.5 (High)',
  },
  {
    slug: 'claude-sonnet-5-5-medium',
    expectedFamily: 'claude',
    pairedDisplayName: 'Claude Sonnet 5.5 (Medium)',
  },
  {
    slug: 'claude-sonnet-5-5-low',
    expectedFamily: 'claude',
    pairedDisplayName: 'Claude Sonnet 5.5 (Low)',
  },
  // GPT-OSS in Agy
  {
    slug: 'gpt-oss-120b-medium',
    expectedFamily: 'gpt',
    pairedDisplayName: 'GPT-OSS 120B (Medium)',
  },
];

type ClaudeSlugSpec = {
  slug: string;
  expectedFamily: string | null;
  pairedDisplayName: string;
  matchingScopes: readonly { id: string | null; display_name: string }[];
  nonMatchingScopes: readonly { id: string | null; display_name: string }[];
};

const CLAUDE_SLUGS: readonly ClaudeSlugSpec[] = [
  {
    slug: 'claude-opus-5-5',
    expectedFamily: 'opus',
    pairedDisplayName: 'Claude Opus 5.5',
    matchingScopes: [
      { id: null, display_name: 'Claude Opus 5.5' },
      { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
      { id: null, display_name: 'Claude Opus' },
      { id: null, display_name: 'Opus' },
    ],
    nonMatchingScopes: [
      { id: null, display_name: 'Claude Opus 4.5' },
      { id: null, display_name: 'Claude Opus 5' },
      { id: 'claude-opus-4-5', display_name: 'Claude Opus' },
      { id: null, display_name: 'Claude Sonnet 5.5' },
      { id: null, display_name: 'Claude Haiku 4.5' },
      { id: null, display_name: 'Fable' },
    ],
  },
  {
    slug: 'claude-sonnet-5-5',
    expectedFamily: 'sonnet',
    pairedDisplayName: 'Claude Sonnet 5.5',
    matchingScopes: [
      { id: null, display_name: 'Claude Sonnet 5.5' },
      { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' },
      { id: null, display_name: 'Claude Sonnet' },
      { id: null, display_name: 'Sonnet' },
    ],
    nonMatchingScopes: [
      { id: null, display_name: 'Claude Sonnet 4.5' },
      { id: null, display_name: 'Claude Sonnet 5' },
      { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet' },
      { id: null, display_name: 'Claude Opus 5.5' },
      { id: null, display_name: 'Claude Haiku 4.5' },
      { id: null, display_name: 'Fable' },
    ],
  },
  {
    slug: 'claude-haiku-4-5',
    expectedFamily: null,
    pairedDisplayName: 'Claude Haiku 4.5',
    matchingScopes: [
      { id: null, display_name: 'Claude Haiku 4.5' },
      { id: 'claude-haiku-4-5', display_name: 'Haiku 4.5' },
      { id: null, display_name: 'Claude Haiku' },
      { id: null, display_name: 'Haiku' },
    ],
    nonMatchingScopes: [
      { id: null, display_name: 'Claude Opus 5.5' },
      { id: null, display_name: 'Claude Sonnet 5.5' },
      { id: null, display_name: 'Fable' },
    ],
  },
  {
    slug: 'claude-fable-5-1',
    expectedFamily: null,
    pairedDisplayName: 'Claude Fable 5.1',
    matchingScopes: [
      { id: null, display_name: 'Claude Fable 5.1' },
      { id: 'claude-fable-5-1', display_name: 'Fable 5.1' },
      { id: null, display_name: 'Claude Fable' },
      { id: null, display_name: 'Fable' },
    ],
    nonMatchingScopes: [
      { id: null, display_name: 'Claude Opus 5.5' },
      { id: null, display_name: 'Claude Sonnet 5.5' },
      { id: null, display_name: 'Claude Haiku 4.5' },
    ],
  },
];

const CODEX_SLUGS: readonly string[] = [
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-reserve',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'codex-auto-review',
];

// --- 1. Map asserts every Agy slug has family and usageNames ---
for (const spec of AGY_SLUGS) {
  void test(`MODEL_SLUG_MAP defines ${spec.slug} with family ${spec.expectedFamily}`, () => {
    const entry = MODEL_SLUG_MAP[spec.slug];
    assert.ok(entry, `Entry for ${spec.slug} must exist in MODEL_SLUG_MAP`);
    assert.equal(entry.slug, spec.slug);
    assert.equal(entry.family, spec.expectedFamily);
    assert.ok(entry.usageNames.length > 0);
    assert.ok(entry.displayNames.length > 0);

    // resolveAgyFamilies maps the slug to its family
    const resolved = resolveAgyFamilies(spec.slug);
    assert.deepEqual(resolved, [spec.expectedFamily]);
  });
}

// --- 2. Equivalence between every Agy slug and its paired display name ---
for (const spec of AGY_SLUGS) {
  void test(`evaluateAgentUsage verdict parity for agy: ${spec.slug} vs ${spec.pairedDisplayName}`, () => {
    const payload = agyComprehensivePayload();

    // Available
    const resSlug = evaluateAgentUsage(
      'agy',
      payload,
      spec.slug,
      policy,
      null,
      now,
    );
    const resName = evaluateAgentUsage(
      'agy',
      payload,
      spec.pairedDisplayName,
      policy,
      null,
      now,
    );
    assert.equal(resSlug.available, true);
    assert.equal(resSlug.reasonCode, 'available');
    assert.equal(resSlug.quotaFamily, spec.expectedFamily);
    assert.equal(resSlug.available, resName.available);
    assert.equal(resSlug.reasonCode, resName.reasonCode);
    assert.equal(resSlug.quotaFamily, resName.quotaFamily);

    // Quota exhausted on the relevant family bucket
    const exhaustedPayload = agyComprehensivePayload();
    const familyUsage = exhaustedPayload.families[spec.expectedFamily];
    if (familyUsage?.seven_day) {
      familyUsage.seven_day.remaining_fraction = 0;
      familyUsage.seven_day.limit_reached = true;
    }
    const resSlugExhausted = evaluateAgentUsage(
      'agy',
      exhaustedPayload,
      spec.slug,
      policy,
      null,
      now,
    );
    const resNameExhausted = evaluateAgentUsage(
      'agy',
      exhaustedPayload,
      spec.pairedDisplayName,
      policy,
      null,
      now,
    );
    assert.equal(resSlugExhausted.available, false);
    assert.equal(resSlugExhausted.reasonCode, 'quota_limit');
    assert.equal(resSlugExhausted.reasonCode, resNameExhausted.reasonCode);
    assert.equal(resSlugExhausted.available, resNameExhausted.available);

    // 5h Reserve exhausted (for families with 5h window: gemini, claude, gpt)
    if (spec.expectedFamily !== 'argon') {
      const reservePayload = agyComprehensivePayload();
      const family5h = reservePayload.families[spec.expectedFamily]?.five_hour;
      if (family5h) {
        family5h.remaining_fraction = 0.2; // 20% remaining fraction = 80% used = hits 80% maxPercent limit
      }
      const resSlugReserve = evaluateAgentUsage(
        'agy',
        reservePayload,
        spec.slug,
        policy,
        null,
        now,
      );
      const resNameReserve = evaluateAgentUsage(
        'agy',
        reservePayload,
        spec.pairedDisplayName,
        policy,
        null,
        now,
      );
      assert.equal(resSlugReserve.available, false);
      assert.equal(resSlugReserve.reasonCode, 'five_hour_reserve');
      assert.equal(resSlugReserve.reasonCode, resNameReserve.reasonCode);
      assert.equal(resSlugReserve.available, resNameReserve.available);
    }
  });
}

// --- 3. Claude Code slugs: family and matching scoped limits ---
for (const spec of CLAUDE_SLUGS) {
  void test(`MODEL_SLUG_MAP defines Claude slug ${spec.slug} with family ${spec.expectedFamily}`, () => {
    const entry = MODEL_SLUG_MAP[spec.slug];
    assert.ok(entry, `Entry for ${spec.slug} must exist in MODEL_SLUG_MAP`);
    assert.equal(entry.slug, spec.slug);
    assert.equal(entry.family, spec.expectedFamily);
    assert.ok(entry.usageNames.length > 0);
  });

  void test(`Claude scoped limit matching and verdict parity: ${spec.slug} vs ${spec.pairedDisplayName}`, () => {
    // 1. Available parity
    const base = claudeBase();
    const resSlug = evaluateAgentUsage(
      'claude',
      base,
      spec.slug,
      policy,
      null,
      now,
    );
    const resName = evaluateAgentUsage(
      'claude',
      base,
      spec.pairedDisplayName,
      policy,
      null,
      now,
    );
    assert.equal(resSlug.available, true);
    assert.equal(resSlug.reasonCode, 'available');
    assert.equal(resSlug.quotaFamily, spec.expectedFamily);
    assert.equal(resSlug.available, resName.available);
    assert.equal(resSlug.reasonCode, resName.reasonCode);
    assert.equal(resSlug.quotaFamily, resName.quotaFamily);

    // 2. Matching scoped limits apply to the slug and give identical quota_limit
    for (const scope of spec.matchingScopes) {
      const payload = claudeBase();
      payload.limits.push({
        kind: 'model_limit',
        percent: 100,
        is_active: true,
        group: null,
        resets_at: null,
        scope: { model: scope },
      });
      const verdictSlug = evaluateAgentUsage(
        'claude',
        payload,
        spec.slug,
        policy,
        null,
        now,
      );
      const verdictName = evaluateAgentUsage(
        'claude',
        payload,
        spec.pairedDisplayName,
        policy,
        null,
        now,
      );
      assert.equal(
        verdictSlug.available,
        false,
        `Matching scope ${JSON.stringify(scope)} must block slug ${spec.slug}`,
      );
      assert.equal(verdictSlug.reasonCode, 'quota_limit');
      assert.equal(verdictSlug.available, verdictName.available);
      assert.equal(verdictSlug.reasonCode, verdictName.reasonCode);
    }

    // 3. Non-matching scoped limits do not block the slug
    for (const scope of spec.nonMatchingScopes) {
      const payload = claudeBase();
      payload.limits.push({
        kind: 'model_limit',
        percent: 100,
        is_active: true,
        group: null,
        resets_at: null,
        scope: { model: scope },
      });
      const verdictSlug = evaluateAgentUsage(
        'claude',
        payload,
        spec.slug,
        policy,
        null,
        now,
      );
      assert.equal(
        verdictSlug.available,
        true,
        `Non-matching scope ${JSON.stringify(scope)} must not block slug ${spec.slug}`,
      );
      assert.equal(verdictSlug.reasonCode, 'available');
    }
  });
}

void test('broad Claude display names observe their family weekly windows', () => {
  for (const [name, slug, family] of [
    ['Claude Opus', 'claude-opus-5-5', 'opus'],
    ['Claude Sonnet', 'claude-sonnet-5-5', 'sonnet'],
  ] as const) {
    const payload = claudeBase();
    if (family === 'opus') payload.seven_day_opus.utilization = 100;
    else payload.seven_day_sonnet.utilization = 100;
    const byName = evaluateAgentUsage('claude', payload, name, policy, null, now);
    const bySlug = evaluateAgentUsage('claude', payload, slug, policy, null, now);
    assert.equal(byName.quotaFamily, family);
    assert.equal(byName.reasonCode, 'quota_limit');
    assert.equal(byName.reasonCode, bySlug.reasonCode);
  }
});

void test('Claude scoped ids preserve legacy names without crossing versions', () => {
  for (const [scope, expectedSlug, expectedLegacy] of [
    [{ id: 'claude-opus-5-5', display_name: 'Claude Opus' }, 'quota_limit', 'quota_limit'],
    [{ id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus' }, 'available', 'quota_limit'],
  ] as const) {
    const payload = claudeBase();
    payload.limits.push({
      kind: 'model_limit', percent: 100, is_active: true, group: null,
      resets_at: null, scope: { model: scope },
    });
    assert.equal(evaluateAgentUsage('claude', payload, 'claude-opus-5-5', policy, null, now).reasonCode, expectedSlug);
    assert.equal(evaluateAgentUsage('claude', payload, 'Claude Opus', policy, null, now).reasonCode, expectedLegacy);
  }
});

// --- 4. Codex slugs: present in map and evaluateAgentUsage works identically ---
for (const slug of CODEX_SLUGS) {
  void test(`MODEL_SLUG_MAP defines Codex slug ${slug}`, () => {
    const entry = MODEL_SLUG_MAP[slug];
    assert.ok(entry, `Entry for ${slug} must exist in MODEL_SLUG_MAP`);
    assert.equal(entry.slug, slug);
    assert.equal(entry.family, null);

    const base = codexBase();
    const resSlug = evaluateAgentUsage('codex', base, slug, policy, null, now);
    const resName = evaluateAgentUsage(
      'codex',
      base,
      entry.displayNames[0],
      policy,
      null,
      now,
    );
    assert.equal(resSlug.available, true);
    assert.equal(resSlug.reasonCode, 'available');
    assert.equal(resSlug.available, resName.available);
    assert.equal(resSlug.reasonCode, resName.reasonCode);
    assert.equal(resSlug.quotaFamily, resName.quotaFamily);
  });
}

// --- 5. Helper function getModelSlugEntry tests ---
void test('getModelSlugEntry resolves by slug and display name', () => {
  const bySlug = getModelSlugEntry('gemini-4-argon-high');
  assert.equal(bySlug?.slug, 'gemini-4-argon-high');
  assert.equal(bySlug?.family, 'argon');

  const byDisplay = getModelSlugEntry('Gemini 4 Argon (High)');
  assert.equal(byDisplay?.slug, 'gemini-4-argon-high');
  assert.equal(byDisplay?.family, 'argon');

  const claudeBySlug = getModelSlugEntry('claude-opus-5-5');
  assert.equal(claudeBySlug?.slug, 'claude-opus-5-5');
  assert.equal(claudeBySlug?.family, 'opus');

  const claudeByDisplay = getModelSlugEntry('Claude Opus 5.5');
  assert.equal(claudeByDisplay?.slug, 'claude-opus-5-5');
  assert.equal(claudeByDisplay?.family, 'opus');

  assert.equal(getModelSlugEntry('nonexistent-model'), undefined);
});

// --- 6. v0.8.3 resolveAgyFamilies behavior verification ---
void test('v0.8.3 resolveAgyFamilies logic maps every agy slug to its correct family', () => {
  // In v0.8.3, resolveAgyFamilies performs substring matching on name.toLowerCase():
  // 1) lowerName.includes('argon') -> adds 'argon'
  // 2) lowerName.includes('gemini') && !families.includes('argon') -> adds 'gemini'
  // 3) lowerName.includes('claude') -> adds 'claude'
  // 4) lowerName.includes('gpt') -> adds 'gpt'
  const v083Resolve = (name: string): AgyModelFamily[] => {
    const families: AgyModelFamily[] = [];
    const lowerName = name.toLowerCase();
    if (lowerName.includes('argon')) {
      families.push('argon');
    } else if (lowerName.includes('gemini') && !families.includes('argon')) {
      families.push('gemini');
    }
    if (lowerName.includes('claude')) {
      families.push('claude');
    }
    if (lowerName.includes('gpt')) {
      families.push('gpt');
    }
    return families;
  };

  for (const spec of AGY_SLUGS) {
    const v083Result = v083Resolve(spec.slug);
    assert.deepEqual(
      v083Result,
      [spec.expectedFamily],
      `v0.8.3 resolveAgyFamilies must map ${spec.slug} to ${spec.expectedFamily}`,
    );
  }
});
