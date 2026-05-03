import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type SkillSource,
  syncIsolatedSkills,
} from './isolated-skills.js';

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type CodexColorMode = 'never' | 'auto' | 'always';
export type CodexSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

export type CodexIsolationConfig = {
  model?: string | undefined;
  reasoning_effort?: CodexReasoningEffort | undefined;
  approval_policy?: string | undefined;
  sandbox_mode?: CodexSandboxMode | undefined;
  color?: CodexColorMode | undefined;
  config?: CodexTomlObject | undefined;
  roleConfigs?: Readonly<Record<string, string>> | undefined;
};

export type CodexIsolationContext = {
  env: NodeJS.ProcessEnv;
  isolatedHome: string;
  configPath: string;
  configContent: string;
  skillsDir: string;
  authPath: string;
  credentialsPath: string;
  cleanup: () => Promise<void>;
};

type ResolvedCodexConfig = {
  model: string;
  reasoningEffort: CodexReasoningEffort;
  approvalPolicy: string;
  sandboxMode: CodexSandboxMode;
  trustedProjects: string[];
  config: CodexTomlObject;
};

export type CodexTomlPrimitive = string | number | boolean;
export type CodexTomlValue =
  | CodexTomlPrimitive
  | readonly CodexTomlPrimitive[]
  | CodexTomlObject;
export type CodexTomlObject = {
  readonly [key: string]: CodexTomlValue;
};

const resolveIsolatedHomeRoot = () =>
  process.env.CODEX_ISOLATED_HOME_ROOT ||
  path.join(os.homedir(), '.agents-home');

const resolveSharedCodexHome = () =>
  process.env.CODEX_SHARED_HOME ||
  process.env.CODEX_HOME ||
  path.join(os.homedir(), '.codex');

const DEFAULT_SHARED_CODEX_STATE_FILES = (
  process.env.CODEX_SHARED_STATE_FILES ||
  'auth.json,.credentials.json,installation_id'
)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const quoteTomlString = (value: string) => JSON.stringify(value);

const renderTomlStringArray = (values: readonly string[]) =>
  `[${values.map((value) => quoteTomlString(value)).join(', ')}]`;

function quoteTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : quoteTomlString(key);
}

function renderTomlValue(
  value: CodexTomlPrimitive | readonly CodexTomlPrimitive[],
): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => renderTomlValue(entry)).join(', ')}]`;
  }
  if (typeof value === 'string') {
    return quoteTomlString(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

function isTomlObject(value: CodexTomlValue): value is CodexTomlObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderTomlObject(
  object: CodexTomlObject,
  tablePath: readonly string[] = [],
): string[] {
  const valueLines: string[] = [];
  const tableLines: string[] = [];

  for (const [key, value] of Object.entries(object)) {
    if (isTomlObject(value)) {
      const nextPath = [...tablePath, key];
      tableLines.push(
        '',
        `[${nextPath.map((part) => quoteTomlKey(part)).join('.')}]`,
        ...renderTomlObject(value, nextPath),
      );
      continue;
    }

    valueLines.push(`${quoteTomlKey(key)} = ${renderTomlValue(value)}`);
  }

  return [...valueLines, ...tableLines];
}

const buildTrustedProjectsBlock = (trustedProjects: readonly string[]) =>
  `[projects]\n${trustedProjects
    .map(
      (projectPath) =>
        `${quoteTomlString(projectPath)} = { trust_level = "trusted" }`,
    )
    .join('\n')}\n`;

function buildCodexConfig(options: ResolvedCodexConfig): string {
  return [
    `model = ${quoteTomlString(options.model)}`,
    `model_reasoning_effort = ${quoteTomlString(options.reasoningEffort)}`,
    `approval_policy = ${quoteTomlString(options.approvalPolicy)}`,
    `sandbox_mode = ${quoteTomlString(options.sandboxMode)}`,
    `project_doc_fallback_filenames = ${renderTomlStringArray(['AGENTS.md', 'GEMINI.md'])}`,
    'web_search = "disabled"',
    '',
    ...renderTomlObject(options.config),
    '',
    buildTrustedProjectsBlock(options.trustedProjects).trimEnd(),
    '',
  ].join('\n');
}

async function writeRoleConfigs(
  rolesDir: string,
  roleConfigs: Readonly<Record<string, string>>,
): Promise<void> {
  const entries = Object.entries(roleConfigs);
  if (entries.length === 0) {
    return;
  }

  await fs.rm(rolesDir, { recursive: true, force: true });
  await fs.mkdir(rolesDir, { recursive: true });
  await Promise.all(
    entries.map(([roleName, content]) =>
      fs.writeFile(path.join(rolesDir, `${roleName}.toml`), content, 'utf8'),
    ),
  );
}

async function linkSharedStateFiles(
  sharedHome: string,
  isolatedHome: string,
  fileNames: readonly string[],
): Promise<void> {
  await Promise.all(
    fileNames.map(async (fileName) => {
      const sourcePath = path.join(sharedHome, fileName);
      const targetPath = path.join(isolatedHome, fileName);

      try {
        await fs.lstat(sourcePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          if (fileName === 'auth.json') {
            throw new Error(
              `Missing required Codex shared state file "${fileName}" at ${sourcePath}. ` +
                'Codex authentication could not be linked into the isolated home.',
              { cause: error },
            );
          }
          return;
        }
        throw error;
      }

      try {
        const existing = await fs.lstat(targetPath);
        if (existing.isSymbolicLink()) {
          const currentTarget = await fs.readlink(targetPath);
          if (currentTarget === sourcePath) {
            return;
          }
        }
        await fs.rm(targetPath, { recursive: true, force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw error;
        }
      }

      await fs.symlink(sourcePath, targetPath);
    }),
  );
}

export async function createCodexIsolation(args: {
  toolName: string;
  codexConfig?: CodexIsolationConfig | undefined;
  skillSources?: readonly SkillSource[] | undefined;
  targetWorkspace?: string | undefined;
  additionalWorkspaces?: readonly string[] | undefined;
  extraEnv?: NodeJS.ProcessEnv | undefined;
  sharedCodexHome?: string | undefined;
  sharedStateFiles?: readonly string[] | undefined;
}): Promise<CodexIsolationContext> {
  const toolName = args.toolName.trim() || 'tool';
  const isolatedHome = path.join(resolveIsolatedHomeRoot(), 'codex', toolName);
  const skillsDir = path.join(isolatedHome, 'skills');
  const configPath = path.join(isolatedHome, 'config.toml');
  const trustedProjects = Array.from(
    new Set(
      [args.targetWorkspace, ...(args.additionalWorkspaces ?? [])].filter(
        (entry): entry is string => Boolean(entry),
      ),
    ),
  );

  await fs.mkdir(isolatedHome, { recursive: true });
  await linkSharedStateFiles(
    args.sharedCodexHome ?? resolveSharedCodexHome(),
    isolatedHome,
    args.sharedStateFiles ?? DEFAULT_SHARED_CODEX_STATE_FILES,
  );
  await writeRoleConfigs(
    path.join(isolatedHome, 'roles'),
    args.codexConfig?.roleConfigs ?? {},
  );
  await syncIsolatedSkills(
    skillsDir,
    args.skillSources ?? [],
  );

  const configContent = buildCodexConfig({
    model: args.codexConfig?.model ?? 'gpt-5.5',
    reasoningEffort: args.codexConfig?.reasoning_effort ?? 'medium',
    approvalPolicy: args.codexConfig?.approval_policy ?? 'never',
    sandboxMode: args.codexConfig?.sandbox_mode ?? 'danger-full-access',
    trustedProjects,
    config: args.codexConfig?.config ?? {},
  });

  await fs.writeFile(configPath, configContent, 'utf8');

  return {
    env: {
      CODEX_HOME: isolatedHome,
      ...(args.codexConfig?.color === 'never' ||
      args.codexConfig?.color === undefined
        ? { NO_COLOR: '1' }
        : {}),
      ...(args.extraEnv || {}),
    },
    isolatedHome,
    configPath,
    configContent,
    skillsDir,
    authPath: path.join(isolatedHome, 'auth.json'),
    credentialsPath: path.join(isolatedHome, '.credentials.json'),
    cleanup: async () => undefined,
  };
}
