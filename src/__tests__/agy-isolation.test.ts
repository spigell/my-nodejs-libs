import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { createAgyIsolation } from '../agents/agy-isolation.js';

const originalAgyIsolatedHomeRoot = process.env.AGY_ISOLATED_HOME_ROOT;
const originalGeminiSharedHome = process.env.GEMINI_SHARED_HOME;
const originalAgySharedHome = process.env.AGY_SHARED_HOME;
const originalAgentName = process.env.AGENT_NAME;
const tempDirs: string[] = [];

afterEach(async () => {
  process.env.AGY_ISOLATED_HOME_ROOT = originalAgyIsolatedHomeRoot;
  process.env.GEMINI_SHARED_HOME = originalGeminiSharedHome;
  process.env.AGY_SHARED_HOME = originalAgySharedHome;
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
  process.env.AGY_ISOLATED_HOME_ROOT = tempRoot;
  process.env.AGENT_NAME = 'agy';

  const sharedGeminiHome = path.join(tempRoot, 'shared-gemini-home');
  const sharedAgyHome = path.join(sharedGeminiHome, 'antigravity-cli');
  await fs.mkdir(sharedAgyHome, { recursive: true });
  await fs.writeFile(
    path.join(sharedAgyHome, 'antigravity-oauth-token'),
    'token\n',
    'utf8',
  );
  process.env.AGY_SHARED_HOME = sharedGeminiHome;

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
    settings: {
      model: 'Claude Opus 4.6 (Thinking)',
      enableTelemetry: false,
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

  assert.equal(result.env.HOME, path.join(tempRoot, 'agy', 'task-runner'));
  assert.equal(result.env.SSH_CONNECTION, '127.0.0.1 50000 127.0.0.1 22');
  assert.equal(result.env.SSH_CLIENT, '127.0.0.1 50000 22');
  assert.equal(
    await fs.readFile(result.promptPath, 'utf8'),
    await fs.readFile(promptSourcePath, 'utf8'),
  );
  assert.match(await fs.readFile(result.settingsPath, 'utf8'), /"model":/);
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
  process.env.AGY_ISOLATED_HOME_ROOT = tempRoot;
  process.env.AGY_SHARED_HOME = path.join(tempRoot, 'missing-shared-home');

  const result = await createAgyIsolation({
    toolName: 'no-token',
  });

  await assert.rejects(fs.lstat(result.oauthTokenPath), /ENOENT/);
});
