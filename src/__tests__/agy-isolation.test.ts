import assert from 'node:assert/strict';
import type { PathLike } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import {
  createAgyIsolation,
  DEFAULT_AGY_MODEL,
} from '../agents/agy-isolation.js';

const originalHome = process.env.HOME;
const originalAgentName = process.env.AGENT_NAME;
const tempDirs: string[] = [];
const realLstat = fs.lstat;
const realReadlink = fs.readlink;
const realSymlink = fs.symlink;

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.AGENT_NAME = originalAgentName;
  fs.lstat = realLstat;
  fs.readlink = realReadlink;
  fs.symlink = realSymlink;
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

void test('createAgyIsolation writes prompt, config, env, and requested skills', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-isolation-'));
  tempDirs.push(tempRoot);
  const userHome = path.join(tempRoot, 'home');
  process.env.HOME = userHome;
  process.env.AGENT_NAME = 'agy';
  const sharedOauthTokenPath =
    '/home/ubuntu/.gemini/antigravity-cli/antigravity-oauth-token';
  const symlinkCalls: Array<{ target: string; path: string }> = [];
  fs.lstat = (async (targetPath: PathLike) => {
    if (String(targetPath) === sharedOauthTokenPath) {
      return {
        isSymbolicLink: () => false,
      } as Awaited<ReturnType<typeof realLstat>>;
    }
    return realLstat(targetPath);
  }) as typeof fs.lstat;
  fs.symlink = (async (target: PathLike, pathArg: PathLike) => {
    symlinkCalls.push({
      target: String(target),
      path: String(pathArg),
    });
    return realSymlink(target, pathArg);
  }) as typeof fs.symlink;

  const promptSourcePath = path.join(tempRoot, 'prompt.md');
  await fs.writeFile(promptSourcePath, '# Prompt\n', 'utf8');

  const skillRoot = path.join(tempRoot, 'source-skills');
  await fs.mkdir(path.join(skillRoot, 'k8s-cli'), { recursive: true });
  await fs.writeFile(
    path.join(skillRoot, 'k8s-cli', 'SKILL.md'),
    '# k8s-cli\n',
    'utf8',
  );

  const result = await createAgyIsolation({
    toolName: 'task-runner',
    promptPath: promptSourcePath,
    cwd: '/spigell-reforge-ai/my-shared-infra/my-nodejs-libs',
    settings: {
      model: 'Claude Opus 4.6 (Thinking)',
      enableTelemetry: false,
      trustedWorkspaces: ['/spigell-reforge-ai'],
    },
    mcpConfig: {
      mcpServers: {
        'git-mcp': {
          serverURL: 'http://mcp-git-gemini:8080/mcp/',
          trust: true,
        },
      },
    },
    skillSources: [{ rootDir: skillRoot, dirNames: ['k8s-cli'] }],
  });

  assert.equal(
    result.env.HOME,
    path.join(userHome, '.agents-home', 'agy', 'task-runner'),
  );
  assert.equal(result.env.SSH_CONNECTION, '127.0.0.1 50000 127.0.0.1 22');
  assert.equal(result.env.SSH_CLIENT, '127.0.0.1 50000 22');
  assert.equal(
    await fs.readFile(result.promptPath, 'utf8'),
    await fs.readFile(promptSourcePath, 'utf8'),
  );
  const settingsJson = JSON.parse(await fs.readFile(result.settingsPath, 'utf8')) as {
    model?: string;
    trustedWorkspaces?: string[];
  };
  assert.equal(settingsJson.model, 'Claude Opus 4.6 (Thinking)');
  assert.deepEqual(settingsJson.trustedWorkspaces, [
    '/spigell-reforge-ai',
    '/spigell-reforge-ai/my-shared-infra/my-nodejs-libs',
  ]);
  assert.match(await fs.readFile(result.mcpConfigPath, 'utf8'), /"git-mcp":/);
  await assert.doesNotReject(
    fs.access(path.join(result.skillsDir, 'k8s-cli', 'SKILL.md')),
  );
  assert.deepEqual(symlinkCalls, [
    {
      target: sharedOauthTokenPath,
      path: result.oauthTokenPath,
    },
  ]);
  assert.equal(
    await fs.readlink(result.oauthTokenPath),
    sharedOauthTokenPath,
  );
});

void test('createAgyIsolation does not require a shared oauth token', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-isolation-'));
  tempDirs.push(tempRoot);
  process.env.HOME = path.join(tempRoot, 'home');

  const result = await createAgyIsolation({
    toolName: 'no-token',
  });

  await assert.rejects(fs.lstat(result.oauthTokenPath), /ENOENT/);
});

void test('createAgyIsolation writes the default model when settings omit it', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-isolation-'));
  tempDirs.push(tempRoot);
  process.env.HOME = path.join(tempRoot, 'home');

  const result = await createAgyIsolation({
    toolName: 'default-model',
    cwd: '/spigell-reforge-ai',
    settings: {
      enableTelemetry: false,
    },
  });

  const settingsJson = JSON.parse(await fs.readFile(result.settingsPath, 'utf8')) as {
    model?: string;
    trustedWorkspaces?: string[];
  };

  assert.equal(settingsJson.model, DEFAULT_AGY_MODEL);
  assert.deepEqual(settingsJson.trustedWorkspaces, ['/spigell-reforge-ai']);
});
