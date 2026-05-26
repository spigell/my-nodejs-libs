import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type SkillSource,
  syncIsolatedSkills,
} from './isolated-skills.js';

export const DEFAULT_AGY_MODEL = 'Gemini 3.5 Flash (Medium)';
const AGY_SHARED_OAUTH_TOKEN_PATH =
  '/home/ubuntu/.gemini/antigravity-cli/antigravity-oauth-token';

export type AgyIsolationContext = {
  env: NodeJS.ProcessEnv;
  isolatedHome: string;
  geminiDir: string;
  antigravityCliDir: string;
  configDir: string;
  promptPath: string;
  settingsPath: string;
  mcpConfigPath: string;
  skillsDir: string;
  oauthTokenPath: string;
  cleanup: () => Promise<void>;
};

export async function createAgyIsolation(args: {
  toolName: string;
  promptPath?: string | undefined;
  settings?: unknown;
  mcpConfig?: unknown;
  cwd?: string | undefined;
  extraEnv?: NodeJS.ProcessEnv | undefined;
  skillSources?: readonly SkillSource[] | undefined;
}): Promise<AgyIsolationContext> {
  const agentName = (process.env.AGENT_NAME || 'agy').trim() || 'agy';
  const toolName = args.toolName.trim() || 'tool';
  const isolatedHome = path.join(
    resolveIsolatedHomeRoot(),
    agentName,
    toolName,
  );
  const geminiDir = path.join(isolatedHome, '.gemini');
  const antigravityCliDir = path.join(geminiDir, 'antigravity-cli');
  const configDir = path.join(geminiDir, 'config');
  const skillsDir = path.join(configDir, 'skills');
  const promptPath = path.join(geminiDir, 'GEMINI.md');
  const settingsPath = path.join(antigravityCliDir, 'settings.json');
  const mcpConfigPath = path.join(configDir, 'mcp_config.json');
  const oauthTokenPath = path.join(
    antigravityCliDir,
    'antigravity-oauth-token',
  );

  await fs.mkdir(antigravityCliDir, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  await syncIsolatedSkills(skillsDir, args.skillSources ?? []);

  const isolatedSkillsLink = path.join(antigravityCliDir, 'skills');
  try {
    const existing = await fs.lstat(isolatedSkillsLink);
    if (existing.isSymbolicLink()) {
      const currentTarget = await fs.readlink(isolatedSkillsLink);
      if (currentTarget !== '../config/skills') {
        await fs.rm(isolatedSkillsLink, { recursive: true, force: true });
        await fs.symlink('../config/skills', isolatedSkillsLink);
      }
    } else {
      await fs.rm(isolatedSkillsLink, { recursive: true, force: true });
      await fs.symlink('../config/skills', isolatedSkillsLink);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      await fs.symlink('../config/skills', isolatedSkillsLink);
    } else {
      throw error;
    }
  }

  if (args.promptPath) {
    await fs.copyFile(args.promptPath, promptPath);
  }
  if (args.settings !== undefined) {
    await fs.writeFile(
      settingsPath,
      `${JSON.stringify(buildAgySettings(args.settings, args.cwd), null, 2)}\n`,
      'utf8',
    );
  }
  if (args.mcpConfig !== undefined) {
    await fs.writeFile(
      mcpConfigPath,
      `${JSON.stringify(args.mcpConfig, null, 2)}\n`,
      'utf8',
    );
  }

  await syncOptionalSharedStateLink(AGY_SHARED_OAUTH_TOKEN_PATH, oauthTokenPath);

  return {
    env: {
      HOME: isolatedHome,
      SSH_CONNECTION: '127.0.0.1 50000 127.0.0.1 22',
      SSH_CLIENT: '127.0.0.1 50000 22',
      ...(args.extraEnv || {}),
    },
    isolatedHome,
    geminiDir,
    antigravityCliDir,
    configDir,
    promptPath,
    settingsPath,
    mcpConfigPath,
    skillsDir,
    oauthTokenPath,
    cleanup: () => Promise.resolve(),
  };
}

async function syncOptionalSharedStateLink(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  try {
    await fs.lstat(sourcePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
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
}

function resolveIsolatedHomeRoot(): string {
  return path.join(resolveUserHome(), '.agents-home');
}

function resolveUserHome(): string {
  const home = process.env.HOME?.trim();
  return home || os.homedir();
}

function buildAgySettings(settings: unknown, cwd?: string): unknown {
  const base =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? { ...(settings as Record<string, unknown>) }
      : {};

  if (typeof base.model !== 'string' || !base.model.trim()) {
    base.model = DEFAULT_AGY_MODEL;
  }

  const normalizedCwd = cwd?.trim();
  if (normalizedCwd) {
    const existingTrustedWorkspaces = Array.isArray(base.trustedWorkspaces)
      ? base.trustedWorkspaces.filter(
          (value): value is string =>
            typeof value === 'string' && value.trim() !== '',
        )
      : [];

    base.trustedWorkspaces = Array.from(
      new Set([...existingTrustedWorkspaces, normalizedCwd]),
    );
  }

  return base;
}
