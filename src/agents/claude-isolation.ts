import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type SkillSource,
  syncIsolatedSkills,
} from './isolated-skills.js';

export type ClaudeIsolationContext = {
  env: NodeJS.ProcessEnv;
  persistent: boolean;
  isolatedHome: string;
  promptPath: string;
  settingsPath: string;
  mcpConfigPath: string;
  skillsDir: string;
  agentsDir: string;
  credentialsPath: string;
  cleanup: () => Promise<void>;
};

export type ClaudeAgentSource = {
  rootDir: string;
  names: readonly string[];
};

const resolveIsolatedHomeRoot = () =>
  process.env.CLAUDE_ISOLATED_HOME_ROOT ||
  path.join(os.homedir(), '.agents-home');

const resolveSharedClaudeHome = () =>
  process.env.CLAUDE_SHARED_HOME || path.join(os.homedir(), '.claude');

export async function createClaudeIsolation(args: {
  toolName: string;
  promptPath?: string | undefined;
  settings?: unknown;
  mcpConfig?: unknown;
  extraEnv?: NodeJS.ProcessEnv | undefined;
  skillSources?: readonly SkillSource[] | undefined;
  agentSource?: ClaudeAgentSource | undefined;
  sharedClaudeHome?: string | undefined;
  persistent?: boolean | undefined;
}): Promise<ClaudeIsolationContext> {
  const toolName = normalizeSafeName(args.toolName, 'toolName');
  const persistent = args.persistent ?? false;
  const claudeIsolationRoot = path.join(
    resolveIsolatedHomeRoot(),
    'claude',
  );
  const agentNames = normalizeAgentNames(args.agentSource);

  await fs.mkdir(claudeIsolationRoot, { recursive: true });
  const isolatedHome = persistent
    ? path.join(claudeIsolationRoot, toolName)
    : await fs.mkdtemp(path.join(claudeIsolationRoot, `${toolName}-`));
  const promptPath = path.join(isolatedHome, 'CLAUDE.md');
  const settingsPath = path.join(isolatedHome, 'settings.json');
  const mcpConfigPath = path.join(isolatedHome, 'mcp.json');
  const skillsDir = path.join(isolatedHome, 'skills');
  const agentsDir = path.join(isolatedHome, 'agents');
  const credentialsPath = path.join(isolatedHome, '.credentials.json');

  try {
    await fs.mkdir(isolatedHome, { recursive: true });
    await syncIsolatedSkills(skillsDir, args.skillSources ?? []);
    await syncClaudeAgents(agentsDir, args.agentSource, agentNames);

    if (args.promptPath) {
      await fs.copyFile(args.promptPath, promptPath);
    } else {
      await fs.rm(promptPath, { force: true });
    }
    await writeJson(settingsPath, args.settings ?? {});
    await writeJson(mcpConfigPath, args.mcpConfig ?? { mcpServers: {} });
    await linkSharedCredentials(
      path.join(
        args.sharedClaudeHome ?? resolveSharedClaudeHome(),
        '.credentials.json',
      ),
      credentialsPath,
    );
  } catch (error) {
    if (!persistent) {
      await fs.rm(isolatedHome, { recursive: true, force: true });
    }
    throw error;
  }

  return {
    env: {
      ...(args.extraEnv || {}),
      CLAUDE_CONFIG_DIR: isolatedHome,
    },
    persistent,
    isolatedHome,
    promptPath,
    settingsPath,
    mcpConfigPath,
    skillsDir,
    agentsDir,
    credentialsPath,
    cleanup: persistent
      ? () => Promise.resolve()
      : () => fs.rm(isolatedHome, { recursive: true, force: true }),
  };
}

async function syncClaudeAgents(
  agentsDir: string,
  source: ClaudeAgentSource | undefined,
  agentNames: readonly string[],
): Promise<void> {
  await fs.rm(agentsDir, { recursive: true, force: true });
  await fs.mkdir(agentsDir, { recursive: true });
  if (!source) {
    return;
  }

  for (const agentName of agentNames) {
    const sourcePath = path.join(source.rootDir, `${agentName}.md`);
    const targetPath = path.join(agentsDir, `${agentName}.md`);
    try {
      await fs.copyFile(sourcePath, targetPath);
    } catch (error) {
      throw new Error(
        `Unable to copy Claude subagent ${agentName} from ${sourcePath} to ${targetPath}`,
        { cause: error },
      );
    }
  }
}

function normalizeSafeName(value: string, fieldName: string): string {
  const normalized = value.trim() || 'tool';
  if (
    normalized === '.' ||
    normalized === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)
  ) {
    throw new Error(
      `${fieldName} must be a single name containing only letters, numbers, dots, underscores, or hyphens`,
    );
  }

  return normalized;
}

function normalizeAgentNames(
  source: ClaudeAgentSource | undefined,
): string[] {
  if (!source) {
    return [];
  }

  return Array.from(
    new Set(
      source.names.map((name) => normalizeSafeName(name, 'agent name')),
    ),
  );
}

async function writeJson(targetPath: string, value: unknown): Promise<void> {
  await fs.writeFile(
    targetPath,
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

async function linkSharedCredentials(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  try {
    await fs.lstat(sourcePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `Missing required Claude shared credentials at ${sourcePath}. ` +
          'Claude authentication could not be linked into the isolated config directory.',
        { cause: error },
      );
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
