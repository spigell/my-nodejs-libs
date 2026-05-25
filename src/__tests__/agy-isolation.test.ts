import assert from 'node:assert/strict';
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

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.AGENT_NAME = originalAgentName;
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

  const sharedGeminiHome = path.join(userHome, '.gemini');
  const sharedAgyHome = path.join(sharedGeminiHome, 'antigravity-cli');
  await fs.mkdir(sharedAgyHome, { recursive: true });
  await fs.writeFile(
    path.join(sharedAgyHome, 'antigravity-oauth-token'),
    'token\n',
    'utf8',
  );

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
  assert.equal(
    await fs.readlink(result.oauthTokenPath),
    path.join(sharedAgyHome, 'antigravity-oauth-token'),
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
