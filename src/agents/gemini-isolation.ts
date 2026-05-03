import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type SkillSource,
  syncIsolatedSkills,
} from './isolated-skills.js';

const DEFAULT_SHARED_GEMINI_HOME =
  process.env.GEMINI_SHARED_HOME || path.join(os.homedir(), '.gemini');
const DEFAULT_ISOLATED_HOME_ROOT =
  process.env.GEMINI_ISOLATED_HOME_ROOT ||
  path.join(os.homedir(), '.agents-home');
const DEFAULT_SHARED_STATE_FILES = (
  process.env.GEMINI_SHARED_STATE_FILES ||
  'oauth_creds.json,mcp-oauth-tokens-v2.json,mcp-oauth-tokens.json,google_accounts.json,installation_id'
)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

export type GeminiIsolationContext = {
  env: NodeJS.ProcessEnv;
  isolatedHome: string;
  geminiDir: string;
  systemPromptPath: string;
  settingsPath: string;
  oauthCredsPath: string;
  tokenOverridePath: string;
  cleanup: () => Promise<void>;
};

export async function createGeminiIsolation(args: {
  toolName: string;
  promptPath?: string | undefined;
  settings?: unknown;
  extraEnv?: NodeJS.ProcessEnv | undefined;
  skillSources?: readonly SkillSource[] | undefined;
}): Promise<GeminiIsolationContext> {
  const agentName = (process.env.AGENT_NAME || 'gemini').trim() || 'gemini';
  const toolName = args.toolName.trim() || 'tool';
  const isolatedHome = path.join(
    DEFAULT_ISOLATED_HOME_ROOT,
    agentName,
    toolName,
  );
  const geminiDir = path.join(isolatedHome, '.gemini');
  const skillsDir = path.join(geminiDir, 'skills');
  const systemPromptPath = path.join(geminiDir, 'system.md');
  const settingsPath = path.join(geminiDir, 'settings.json');
  await fs.mkdir(geminiDir, { recursive: true });
  await syncIsolatedSkills(
    skillsDir,
    args.skillSources ?? [],
  );

  if (args.promptPath) {
    await fs.copyFile(args.promptPath, systemPromptPath);
  }
  if (args.settings !== undefined) {
    await fs.writeFile(
      settingsPath,
      `${JSON.stringify(args.settings, null, 2)}\n`,
      'utf8',
    );
  }

  await Promise.all(
    DEFAULT_SHARED_STATE_FILES.map(async (fileName) => {
      const sourcePath = path.join(DEFAULT_SHARED_GEMINI_HOME, fileName);
      const targetPath = path.join(geminiDir, fileName);
      try {
        await fs.lstat(sourcePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          if (fileName === 'oauth_creds.json') {
            throw new Error(
              `Missing required Gemini shared state file "${fileName}" at ${sourcePath}. ` +
                'Gemini shared state could not be linked into the isolated home.',
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

  return {
    env: {
      GEMINI_CLI_HOME: isolatedHome,
      ...(args.promptPath ? { GEMINI_SYSTEM_MD: systemPromptPath } : {}),
      ...(args.extraEnv || {}),
    },
    isolatedHome,
    geminiDir,
    systemPromptPath,
    settingsPath,
    oauthCredsPath: path.join(geminiDir, 'oauth_creds.json'),
    tokenOverridePath: process.env.GEMINI_TOKEN_FILE || '/tmp/gemini-token.txt',
    cleanup: async () => undefined,
  };
}
