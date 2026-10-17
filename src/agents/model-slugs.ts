export type ModelSlugEntry = {
  slug: string;
  family: string | null;
  /** Names that usage payloads use (group models in agy, scoped limit display names/ids in claude, etc.). */
  usageNames: readonly string[];
  /** Alias for usageNames for compatibility. */
  displayNames: readonly string[];
};

export const MODEL_SLUG_MAP: Readonly<Record<string, ModelSlugEntry>> =
  Object.freeze({
    // Agy Gemini Flash
    'gemini-3.8-flash-high': {
      slug: 'gemini-3.8-flash-high',
      family: 'gemini',
      usageNames: ['Gemini Flash', 'Gemini 3.8 Flash (High)'],
      displayNames: ['Gemini Flash', 'Gemini 3.8 Flash (High)'],
    },
    'gemini-3.8-flash-medium': {
      slug: 'gemini-3.8-flash-medium',
      family: 'gemini',
      usageNames: ['Gemini Flash', 'Gemini 3.8 Flash (Medium)'],
      displayNames: ['Gemini Flash', 'Gemini 3.8 Flash (Medium)'],
    },
    'gemini-3.8-flash-low': {
      slug: 'gemini-3.8-flash-low',
      family: 'gemini',
      usageNames: ['Gemini Flash', 'Gemini 3.8 Flash (Low)'],
      displayNames: ['Gemini Flash', 'Gemini 3.8 Flash (Low)'],
    },
    'gemini-3.7-flash-high': {
      slug: 'gemini-3.7-flash-high',
      family: 'gemini',
      usageNames: ['Gemini Flash', 'Gemini 3.7 Flash (High)'],
      displayNames: ['Gemini Flash', 'Gemini 3.7 Flash (High)'],
    },
    'gemini-3.7-flash-medium': {
      slug: 'gemini-3.7-flash-medium',
      family: 'gemini',
      usageNames: ['Gemini Flash', 'Gemini 3.7 Flash (Medium)'],
      displayNames: ['Gemini Flash', 'Gemini 3.7 Flash (Medium)'],
    },
    'gemini-3.7-flash-low': {
      slug: 'gemini-3.7-flash-low',
      family: 'gemini',
      usageNames: ['Gemini Flash', 'Gemini 3.7 Flash (Low)'],
      displayNames: ['Gemini Flash', 'Gemini 3.7 Flash (Low)'],
    },
    'gemini-3.6-flash-high': {
      slug: 'gemini-3.6-flash-high',
      family: 'gemini',
      usageNames: ['Gemini Flash', 'Gemini 3.6 Flash (High)'],
      displayNames: ['Gemini Flash', 'Gemini 3.6 Flash (High)'],
    },
    'gemini-3.6-flash-medium': {
      slug: 'gemini-3.6-flash-medium',
      family: 'gemini',
      usageNames: ['Gemini Flash', 'Gemini 3.6 Flash (Medium)'],
      displayNames: ['Gemini Flash', 'Gemini 3.6 Flash (Medium)'],
    },
    'gemini-3.6-flash-low': {
      slug: 'gemini-3.6-flash-low',
      family: 'gemini',
      usageNames: ['Gemini Flash', 'Gemini 3.6 Flash (Low)'],
      displayNames: ['Gemini Flash', 'Gemini 3.6 Flash (Low)'],
    },
    // Agy Gemini Pro
    'gemini-3.1-pro-high': {
      slug: 'gemini-3.1-pro-high',
      family: 'gemini',
      usageNames: ['Gemini Pro', 'Gemini 3.1 Pro (High)'],
      displayNames: ['Gemini Pro', 'Gemini 3.1 Pro (High)'],
    },
    'gemini-3.1-pro-low': {
      slug: 'gemini-3.1-pro-low',
      family: 'gemini',
      usageNames: ['Gemini Pro', 'Gemini 3.1 Pro (Low)'],
      displayNames: ['Gemini Pro', 'Gemini 3.1 Pro (Low)'],
    },
    // Agy Gemini Argon
    'gemini-4-argon-high': {
      slug: 'gemini-4-argon-high',
      family: 'argon',
      usageNames: ['Gemini 4 Argon', 'Gemini 4 Argon (High)'],
      displayNames: ['Gemini 4 Argon', 'Gemini 4 Argon (High)'],
    },
    'gemini-4-argon-medium': {
      slug: 'gemini-4-argon-medium',
      family: 'argon',
      usageNames: ['Gemini 4 Argon', 'Gemini 4 Argon (Medium)'],
      displayNames: ['Gemini 4 Argon', 'Gemini 4 Argon (Medium)'],
    },
    'gemini-4-argon-low': {
      slug: 'gemini-4-argon-low',
      family: 'argon',
      usageNames: ['Gemini 4 Argon', 'Gemini 4 Argon (Low)'],
      displayNames: ['Gemini 4 Argon', 'Gemini 4 Argon (Low)'],
    },
    // Agy Claude Opus
    'claude-opus-5-5-high': {
      slug: 'claude-opus-5-5-high',
      family: 'claude',
      usageNames: ['Claude Opus', 'Claude Opus 5.5 (High)'],
      displayNames: ['Claude Opus', 'Claude Opus 5.5 (High)'],
    },
    'claude-opus-5-5-medium': {
      slug: 'claude-opus-5-5-medium',
      family: 'claude',
      usageNames: ['Claude Opus', 'Claude Opus 5.5 (Medium)'],
      displayNames: ['Claude Opus', 'Claude Opus 5.5 (Medium)'],
    },
    'claude-opus-5-5-low': {
      slug: 'claude-opus-5-5-low',
      family: 'claude',
      usageNames: ['Claude Opus', 'Claude Opus 5.5 (Low)'],
      displayNames: ['Claude Opus', 'Claude Opus 5.5 (Low)'],
    },
    // Agy Claude Sonnet
    'claude-sonnet-5-5-high': {
      slug: 'claude-sonnet-5-5-high',
      family: 'claude',
      usageNames: ['Claude Sonnet', 'Claude Sonnet 5.5 (High)'],
      displayNames: ['Claude Sonnet', 'Claude Sonnet 5.5 (High)'],
    },
    'claude-sonnet-5-5-medium': {
      slug: 'claude-sonnet-5-5-medium',
      family: 'claude',
      usageNames: ['Claude Sonnet', 'Claude Sonnet 5.5 (Medium)'],
      displayNames: ['Claude Sonnet', 'Claude Sonnet 5.5 (Medium)'],
    },
    'claude-sonnet-5-5-low': {
      slug: 'claude-sonnet-5-5-low',
      family: 'claude',
      usageNames: ['Claude Sonnet', 'Claude Sonnet 5.5 (Low)'],
      displayNames: ['Claude Sonnet', 'Claude Sonnet 5.5 (Low)'],
    },
    // Agy GPT-OSS
    'gpt-oss-120b-medium': {
      slug: 'gpt-oss-120b-medium',
      family: 'gpt',
      usageNames: ['GPT-OSS', 'GPT-OSS 120B (Medium)'],
      displayNames: ['GPT-OSS', 'GPT-OSS 120B (Medium)'],
    },
    // Claude Code models
    'claude-opus-5-5': {
      slug: 'claude-opus-5-5',
      family: 'opus',
      usageNames: ['Claude Opus 5.5', 'Claude Opus', 'Opus', 'claude-opus-5-5'],
      displayNames: [
        'Claude Opus 5.5',
        'Claude Opus',
        'Opus',
        'claude-opus-5-5',
      ],
    },
    'claude-sonnet-5-5': {
      slug: 'claude-sonnet-5-5',
      family: 'sonnet',
      usageNames: [
        'Claude Sonnet 5.5',
        'Claude Sonnet',
        'Sonnet',
        'claude-sonnet-5-5',
      ],
      displayNames: [
        'Claude Sonnet 5.5',
        'Claude Sonnet',
        'Sonnet',
        'claude-sonnet-5-5',
      ],
    },
    'claude-haiku-4-5': {
      slug: 'claude-haiku-4-5',
      family: null,
      usageNames: [
        'Claude Haiku 4.5',
        'Claude Haiku',
        'Haiku',
        'claude-haiku-4-5',
      ],
      displayNames: [
        'Claude Haiku 4.5',
        'Claude Haiku',
        'Haiku',
        'claude-haiku-4-5',
      ],
    },
    'claude-fable-5-1': {
      slug: 'claude-fable-5-1',
      family: null,
      usageNames: [
        'Claude Fable 5.1',
        'Claude Fable',
        'Fable',
        'claude-fable-5-1',
      ],
      displayNames: [
        'Claude Fable 5.1',
        'Claude Fable',
        'Fable',
        'claude-fable-5-1',
      ],
    },
    'claude-fable-5': {
      slug: 'claude-fable-5',
      family: null,
      usageNames: ['Claude Fable 5', 'Claude Fable', 'Fable', 'claude-fable-5'],
      displayNames: [
        'Claude Fable 5',
        'Claude Fable',
        'Fable',
        'claude-fable-5',
      ],
    },
    'claude-opus-5': {
      slug: 'claude-opus-5',
      family: 'opus',
      usageNames: ['Claude Opus 5', 'Claude Opus', 'Opus', 'claude-opus-5'],
      displayNames: ['Claude Opus 5', 'Claude Opus', 'Opus', 'claude-opus-5'],
    },
    'claude-sonnet-5': {
      slug: 'claude-sonnet-5',
      family: 'sonnet',
      usageNames: [
        'Claude Sonnet 5',
        'Claude Sonnet',
        'Sonnet',
        'claude-sonnet-5',
      ],
      displayNames: [
        'Claude Sonnet 5',
        'Claude Sonnet',
        'Sonnet',
        'claude-sonnet-5',
      ],
    },
    'claude-haiku-4-5-20251001': {
      slug: 'claude-haiku-4-5-20251001',
      family: null,
      usageNames: [
        'Claude Haiku 4.5',
        'Claude Haiku',
        'Haiku',
        'claude-haiku-4-5-20251001',
      ],
      displayNames: [
        'Claude Haiku 4.5',
        'Claude Haiku',
        'Haiku',
        'claude-haiku-4-5-20251001',
      ],
    },
    'claude-opus-4-8': {
      slug: 'claude-opus-4-8',
      family: 'opus',
      usageNames: ['Claude Opus 4.8', 'Claude Opus', 'Opus', 'claude-opus-4-8'],
      displayNames: [
        'Claude Opus 4.8',
        'Claude Opus',
        'Opus',
        'claude-opus-4-8',
      ],
    },
    'claude-opus-4-7': {
      slug: 'claude-opus-4-7',
      family: 'opus',
      usageNames: ['Claude Opus 4.7', 'Claude Opus', 'Opus', 'claude-opus-4-7'],
      displayNames: [
        'Claude Opus 4.7',
        'Claude Opus',
        'Opus',
        'claude-opus-4-7',
      ],
    },
    'claude-opus-4-6': {
      slug: 'claude-opus-4-6',
      family: 'opus',
      usageNames: ['Claude Opus 4.6', 'Claude Opus', 'Opus', 'claude-opus-4-6'],
      displayNames: [
        'Claude Opus 4.6',
        'Claude Opus',
        'Opus',
        'claude-opus-4-6',
      ],
    },
    'claude-opus-4-5': {
      slug: 'claude-opus-4-5',
      family: 'opus',
      usageNames: ['Claude Opus 4.5', 'Claude Opus', 'Opus', 'claude-opus-4-5'],
      displayNames: [
        'Claude Opus 4.5',
        'Claude Opus',
        'Opus',
        'claude-opus-4-5',
      ],
    },
    'claude-sonnet-4-6': {
      slug: 'claude-sonnet-4-6',
      family: 'sonnet',
      usageNames: [
        'Claude Sonnet 4.6',
        'Claude Sonnet',
        'Sonnet',
        'claude-sonnet-4-6',
      ],
      displayNames: [
        'Claude Sonnet 4.6',
        'Claude Sonnet',
        'Sonnet',
        'claude-sonnet-4-6',
      ],
    },
    'claude-sonnet-4-5': {
      slug: 'claude-sonnet-4-5',
      family: 'sonnet',
      usageNames: [
        'Claude Sonnet 4.5',
        'Claude Sonnet',
        'Sonnet',
        'claude-sonnet-4-5',
      ],
      displayNames: [
        'Claude Sonnet 4.5',
        'Claude Sonnet',
        'Sonnet',
        'claude-sonnet-4-5',
      ],
    },
    'claude-sonnet-4': {
      slug: 'claude-sonnet-4',
      family: 'sonnet',
      usageNames: ['Claude Sonnet 4', 'Sonnet 4', 'claude-sonnet-4'],
      displayNames: ['Claude Sonnet 4', 'Sonnet 4', 'claude-sonnet-4'],
    },
    'claude-opus-4': {
      slug: 'claude-opus-4',
      family: 'opus',
      usageNames: ['Claude Opus 4', 'Opus 4', 'claude-opus-4'],
      displayNames: ['Claude Opus 4', 'Opus 4', 'claude-opus-4'],
    },
    fable: {
      slug: 'fable',
      family: null,
      usageNames: ['Claude Fable', 'Fable', 'fable'],
      displayNames: ['Claude Fable', 'Fable', 'fable'],
    },
    opus: {
      slug: 'opus',
      family: 'opus',
      usageNames: ['Claude Opus', 'Opus', 'opus'],
      displayNames: ['Claude Opus', 'Opus', 'opus'],
    },
    sonnet: {
      slug: 'sonnet',
      family: 'sonnet',
      usageNames: ['Claude Sonnet', 'Sonnet', 'sonnet'],
      displayNames: ['Claude Sonnet', 'Sonnet', 'sonnet'],
    },
    haiku: {
      slug: 'haiku',
      family: null,
      usageNames: ['Claude Haiku', 'Haiku', 'haiku'],
      displayNames: ['Claude Haiku', 'Haiku', 'haiku'],
    },
    opusplan: {
      slug: 'opusplan',
      family: 'opus',
      usageNames: ['Opus Plan', 'Claude Opus', 'Opus', 'opusplan'],
      displayNames: ['Opus Plan', 'Claude Opus', 'Opus', 'opusplan'],
    },
    // Codex models
    'gpt-6-astra': {
      slug: 'gpt-6-astra',
      family: null,
      usageNames: ['GPT-6 Astra', 'gpt-6-astra'],
      displayNames: ['GPT-6 Astra', 'gpt-6-astra'],
    },
    'gpt-6-sol': {
      slug: 'gpt-6-sol',
      family: null,
      usageNames: ['GPT-6 Sol', 'gpt-6-sol'],
      displayNames: ['GPT-6 Sol', 'gpt-6-sol'],
    },
    'gpt-6-luna': {
      slug: 'gpt-6-luna',
      family: null,
      usageNames: ['GPT-6 Luna', 'gpt-6-luna'],
      displayNames: ['GPT-6 Luna', 'gpt-6-luna'],
    },
    'gpt-reserve': {
      slug: 'gpt-reserve',
      family: null,
      usageNames: ['GPT Reserve', 'gpt-reserve'],
      displayNames: ['GPT Reserve', 'gpt-reserve'],
    },
    'gpt-5.6-sol': {
      slug: 'gpt-5.6-sol',
      family: null,
      usageNames: ['GPT-5.6 Sol', 'gpt-5.6-sol'],
      displayNames: ['GPT-5.6 Sol', 'gpt-5.6-sol'],
    },
    'gpt-5.6-terra': {
      slug: 'gpt-5.6-terra',
      family: null,
      usageNames: ['GPT-5.6 Terra', 'gpt-5.6-terra'],
      displayNames: ['GPT-5.6 Terra', 'gpt-5.6-terra'],
    },
    'gpt-5.6-luna': {
      slug: 'gpt-5.6-luna',
      family: null,
      usageNames: ['GPT-5.6 Luna', 'gpt-5.6-luna'],
      displayNames: ['GPT-5.6 Luna', 'gpt-5.6-luna'],
    },
    'gpt-5.5': {
      slug: 'gpt-5.5',
      family: null,
      usageNames: ['GPT-5.5', 'gpt-5.5'],
      displayNames: ['GPT-5.5', 'gpt-5.5'],
    },
    'codex-auto-review': {
      slug: 'codex-auto-review',
      family: null,
      usageNames: ['Codex Auto Review', 'codex-auto-review'],
      displayNames: ['Codex Auto Review', 'codex-auto-review'],
    },
  });

export const MODEL_SLUGS = MODEL_SLUG_MAP;
export const modelSlugMap = MODEL_SLUG_MAP;

export function getModelSlugEntry(
  slugOrName: string,
): ModelSlugEntry | undefined {
  if (!slugOrName || typeof slugOrName !== 'string') return undefined;
  const key = slugOrName.trim().toLowerCase();
  const direct = MODEL_SLUG_MAP[key];
  if (direct) return direct;
  return Object.values(MODEL_SLUG_MAP).find((entry) =>
    entry.usageNames.some((u) => u.toLowerCase() === key),
  );
}

export function resolveModelSlug(slugOrName: string): string | undefined {
  return getModelSlugEntry(slugOrName)?.slug;
}

export function resolveModelFamily(slugOrName: string): string | null {
  return getModelSlugEntry(slugOrName)?.family ?? null;
}
