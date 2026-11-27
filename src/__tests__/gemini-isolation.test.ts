import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { createGeminiIsolation } from '../agents/gemini-isolation.js';

const originalSharedHome = process.env.GEMINI_SHARED_HOME;
const originalIsolatedRoot = process.env.GEMINI_ISOLATED_HOME_ROOT;
const originalAgentName = process.env.AGENT_NAME;
const originalSharedStateFiles = process.env.GEMINI_SHARED_STATE_FILES;
const tempDirs: string[] = [];

afterEach(async () => {
  process.env.GEMINI_SHARED_HOME = originalSharedHome;
  process.env.GEMINI_ISOLATED_HOME_ROOT = originalIsolatedRoot;
  process.env.AGENT_NAME = originalAgentName;
  if (originalSharedStateFiles === undefined) {
    delete process.env.GEMINI_SHARED_STATE_FILES;
  } else {
    process.env.GEMINI_SHARED_STATE_FILES = originalSharedStateFiles;
  }
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

void test('createGeminiIsolation reads shared state files at call time', async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'gemini-isolation-'),
  );
  tempDirs.push(tempRoot);
  const sharedHome = path.join(tempRoot, 'shared-gemini');
  process.env.GEMINI_SHARED_HOME = sharedHome;
  process.env.GEMINI_ISOLATED_HOME_ROOT = path.join(tempRoot, 'isolated');
  process.env.GEMINI_SHARED_STATE_FILES = ' oauth_creds.json, custom-state.json ';
  await fs.mkdir(sharedHome);
  await fs.writeFile(path.join(sharedHome, 'oauth_creds.json'), '{}');
  const sharedFile = path.join(sharedHome, 'custom-state.json');
  await fs.writeFile(sharedFile, '{}');

  const result = await createGeminiIsolation({ toolName: 'custom-state' });

  assert.equal(
    await fs.readlink(path.join(result.geminiDir, 'custom-state.json')),
    sharedFile,
  );
});

void test('createGeminiIsolation links shared state and writes prompt and settings', async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'gemini-isolation-'),
  );
  tempDirs.push(tempRoot);
  const sharedHome = path.join(tempRoot, 'shared-gemini');
  const isolatedRoot = path.join(tempRoot, 'isolated');
  process.env.GEMINI_SHARED_HOME = sharedHome;
  process.env.GEMINI_ISOLATED_HOME_ROOT = isolatedRoot;
  process.env.AGENT_NAME = 'gemini';
  await fs.mkdir(sharedHome);
  for (const fileName of ['oauth_creds.json', 'installation_id']) {
    await fs.writeFile(path.join(sharedHome, fileName), fileName);
  }
  const promptPath = path.join(tempRoot, 'prompt.md');
  await fs.writeFile(promptPath, '# System prompt\n');
  const settings = { theme: 'dark' };

  const result = await createGeminiIsolation({
    toolName: 'task-runner',
    promptPath,
    settings,
  });

  assert.equal(
    result.isolatedHome,
    path.join(isolatedRoot, 'gemini', 'task-runner'),
  );
  assert.equal(result.env.GEMINI_CLI_HOME, result.isolatedHome);
  assert.equal(result.env.GEMINI_SYSTEM_MD, result.systemPromptPath);
  assert.equal(
    await fs.readFile(result.systemPromptPath, 'utf8'),
    '# System prompt\n',
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(result.settingsPath, 'utf8')),
    settings,
  );
  for (const fileName of ['oauth_creds.json', 'installation_id']) {
    const targetPath = path.join(result.geminiDir, fileName);
    assert.ok((await fs.lstat(targetPath)).isSymbolicLink());
    assert.equal(
      await fs.readlink(targetPath),
      path.join(sharedHome, fileName),
    );
  }
});

void test('createGeminiIsolation requires shared oauth_creds.json', async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'gemini-isolation-'),
  );
  tempDirs.push(tempRoot);
  const sharedHome = path.join(tempRoot, 'shared-gemini');
  process.env.GEMINI_SHARED_HOME = sharedHome;
  process.env.GEMINI_ISOLATED_HOME_ROOT = path.join(tempRoot, 'isolated');
  process.env.AGENT_NAME = 'gemini';
  await fs.mkdir(sharedHome);

  await assert.rejects(
    createGeminiIsolation({ toolName: 'missing-auth' }),
    /Missing required Gemini shared state file "oauth_creds\.json"/,
  );
});
