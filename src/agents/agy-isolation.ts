import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type SkillSource,
  syncIsolatedSkills,
} from './isolated-skills.js';

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

  if (args.promptPath) {
    await fs.copyFile(args.promptPath, promptPath);
  }
  if (args.settings !== undefined) {
    await fs.writeFile(
      settingsPath,
      `${JSON.stringify(args.settings, null, 2)}\n`,
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

  const sharedOauthTokenPath = path.join(
    resolveSharedGeminiHome(),
    'antigravity-cli',
    'antigravity-oauth-token',
  );
  await syncOptionalSharedStateLink(sharedOauthTokenPath, oauthTokenPath);

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

function resolveSharedGeminiHome(): string {
  return (
    process.env.AGY_SHARED_HOME ||
    process.env.GEMINI_SHARED_HOME ||
    path.join(os.homedir(), '.gemini')
  );
}

function resolveIsolatedHomeRoot(): string {
  return (
    process.env.AGY_ISOLATED_HOME_ROOT ||
    process.env.GEMINI_ISOLATED_HOME_ROOT ||
    path.join(os.homedir(), '.agents-home')
  );
}
