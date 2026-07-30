import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';

import { createClaudeIsolation } from '../agents/claude-isolation.js';

const originalHome = process.env.HOME;
const originalIsolatedHomeRoot = process.env.CLAUDE_ISOLATED_HOME_ROOT;
const tempDirs: string[] = [];

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.CLAUDE_ISOLATED_HOME_ROOT = originalIsolatedHomeRoot;
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

void test('createClaudeIsolation separates classifier and investigator configuration', async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'claude-isolation-'),
  );
  tempDirs.push(tempRoot);
  process.env.HOME = path.join(tempRoot, 'home');
  process.env.CLAUDE_ISOLATED_HOME_ROOT = path.join(tempRoot, 'isolated');

  const sharedClaudeHome = path.join(tempRoot, 'shared-claude');
  await fs.mkdir(sharedClaudeHome, { recursive: true });
  await fs.writeFile(
    path.join(sharedClaudeHome, '.credentials.json'),
    '{"claudeAiOauth":{"accessToken":"shared-token"}}\n',
    'utf8',
  );

  const classifierPrompt = path.join(tempRoot, 'classifier.md');
  const investigatorPrompt = path.join(tempRoot, 'investigator.md');
  await fs.writeFile(classifierPrompt, '# Classifier\n', 'utf8');
  await fs.writeFile(investigatorPrompt, '# Investigator\n', 'utf8');

  const skillRoot = path.join(tempRoot, 'source-skills');
  await fs.mkdir(path.join(skillRoot, 'repo-reader'), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(skillRoot, 'repo-reader', 'SKILL.md'),
    '# Repo reader\n',
    'utf8',
  );
  const agentsRootDir = path.join(tempRoot, 'claude-agents');
  await fs.mkdir(agentsRootDir, { recursive: true });
  await fs.writeFile(
    path.join(agentsRootDir, 'researcher.md'),
    '---\nname: researcher\n---\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(agentsRootDir, 'repo-operator.md'),
    '---\nname: repo-operator\n---\n',
    'utf8',
  );

  const classifier = await createClaudeIsolation({
    toolName: 'classifier',
    promptPath: classifierPrompt,
    settings: { model: 'claude-haiku-4-5' },
    mcpConfig: { mcpServers: {} },
    extraEnv: {
      CLAUDE_CONFIG_DIR: '/attempted/isolation/override',
      CLASSIFIER_MODE: 'untrusted',
    },
    sharedClaudeHome,
  });
  const investigator = await createClaudeIsolation({
    toolName: 'investigator',
    persistent: true,
    promptPath: investigatorPrompt,
    settings: { model: 'claude-opus-4-8' },
    mcpConfig: {
      mcpServers: {
        'github-mcp': {
          type: 'http',
          url: 'http://github-mcp:8080/mcp',
        },
      },
    },
    agentSource: {
      rootDir: agentsRootDir,
      names: ['researcher'],
    },
    sharedClaudeHome,
    skillSources: [{ rootDir: skillRoot, dirNames: ['repo-reader'] }],
  });

  assert.notEqual(classifier.isolatedHome, investigator.isolatedHome);
  assert.equal(classifier.env.CLAUDE_CONFIG_DIR, classifier.isolatedHome);
  assert.equal(classifier.env.CLAUDE_SYSTEM_PROMPT_FILE, classifier.promptPath);
  assert.equal(classifier.env.CLASSIFIER_MODE, 'untrusted');
  assert.equal(classifier.persistent, false);
  assert.equal(investigator.persistent, true);
  assert.equal(investigator.env.CLAUDE_CONFIG_DIR, investigator.isolatedHome);
  assert.equal(
    investigator.env.CLAUDE_SYSTEM_PROMPT_FILE,
    investigator.promptPath,
  );
  assert.equal(path.basename(classifier.promptPath), 'system-prompt.md');
  assert.equal(
    await fs.readFile(classifier.promptPath, 'utf8'),
    '# Classifier\n',
  );
  assert.equal(
    await fs.readFile(investigator.promptPath, 'utf8'),
    '# Investigator\n',
  );
  await assert.rejects(
    fs.access(path.join(classifier.isolatedHome, 'CLAUDE.md')),
    /ENOENT/,
  );
  await assert.rejects(
    fs.access(path.join(investigator.isolatedHome, 'CLAUDE.md')),
    /ENOENT/,
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(classifier.settingsPath, 'utf8')),
    { model: 'claude-haiku-4-5' },
  );
  assert.match(
    await fs.readFile(classifier.mcpConfigPath, 'utf8'),
    /"mcpServers": \{\}/,
  );
  assert.match(
    await fs.readFile(investigator.mcpConfigPath, 'utf8'),
    /"github-mcp"/,
  );
  assert.deepEqual(await fs.readdir(classifier.skillsDir), []);
  assert.deepEqual(await fs.readdir(classifier.agentsDir), []);
  await assert.doesNotReject(
    fs.access(path.join(investigator.skillsDir, 'repo-reader', 'SKILL.md')),
  );
  await assert.doesNotReject(
    fs.access(path.join(investigator.agentsDir, 'researcher.md')),
  );
  await assert.rejects(
    fs.access(path.join(investigator.agentsDir, 'repo-operator.md')),
    /ENOENT/,
  );
  assert.equal(
    await fs.readlink(classifier.credentialsPath),
    path.join(sharedClaudeHome, '.credentials.json'),
  );
  assert.equal(
    await fs.readlink(investigator.credentialsPath),
    path.join(sharedClaudeHome, '.credentials.json'),
  );

  await classifier.cleanup();
  await classifier.cleanup();
  await investigator.cleanup();
  await assert.rejects(fs.access(classifier.isolatedHome), /ENOENT/);
  await assert.doesNotReject(fs.access(investigator.isolatedHome));
});

void test('createClaudeIsolation removes stale copied subagents', async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'claude-isolation-'),
  );
  tempDirs.push(tempRoot);
  process.env.CLAUDE_ISOLATED_HOME_ROOT = path.join(tempRoot, 'isolated');

  const sharedClaudeHome = path.join(tempRoot, 'shared-claude');
  await fs.mkdir(sharedClaudeHome, { recursive: true });
  await fs.writeFile(
    path.join(sharedClaudeHome, '.credentials.json'),
    '{}\n',
    'utf8',
  );
  const agentsRootDir = path.join(tempRoot, 'claude-agents');
  await fs.mkdir(agentsRootDir, { recursive: true });
  await fs.writeFile(
    path.join(agentsRootDir, 'old-role.md'),
    '# Old role\n',
    'utf8',
  );

  const first = await createClaudeIsolation({
    toolName: 'classifier',
    persistent: true,
    agentSource: {
      rootDir: agentsRootDir,
      names: ['old-role'],
    },
    sharedClaudeHome,
  });
  await fs.rm(path.join(agentsRootDir, 'old-role.md'));
  await fs.writeFile(
    path.join(agentsRootDir, 'new-role.md'),
    '# New role\n',
    'utf8',
  );

  const second = await createClaudeIsolation({
    toolName: 'classifier',
    persistent: true,
    agentSource: {
      rootDir: agentsRootDir,
      names: ['new-role'],
    },
    sharedClaudeHome,
  });

  assert.equal(first.agentsDir, second.agentsDir);
  await assert.rejects(
    fs.access(path.join(second.agentsDir, 'old-role.md')),
    /ENOENT/,
  );
  await assert.doesNotReject(
    fs.access(path.join(second.agentsDir, 'new-role.md')),
  );
});

void test('createClaudeIsolation rejects path traversal before filesystem changes', async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'claude-isolation-'),
  );
  tempDirs.push(tempRoot);
  const isolationRoot = path.join(tempRoot, 'isolated');
  process.env.CLAUDE_ISOLATED_HOME_ROOT = isolationRoot;
  const protectedPath = path.join(tempRoot, 'protected');
  await fs.mkdir(protectedPath);
  await fs.writeFile(path.join(protectedPath, 'marker'), 'keep\n', 'utf8');

  await assert.rejects(
    createClaudeIsolation({
      toolName: '../../protected',
      sharedClaudeHome: path.join(tempRoot, 'unused'),
    }),
    /toolName must be a single name/,
  );

  assert.equal(
    await fs.readFile(path.join(protectedPath, 'marker'), 'utf8'),
    'keep\n',
  );
  await assert.rejects(fs.access(isolationRoot), /ENOENT/);
});

void test('createClaudeIsolation rejects path traversal in subagent names', async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'claude-isolation-'),
  );
  tempDirs.push(tempRoot);
  const isolationRoot = path.join(tempRoot, 'isolated');
  process.env.CLAUDE_ISOLATED_HOME_ROOT = isolationRoot;

  await assert.rejects(
    createClaudeIsolation({
      toolName: 'investigator',
      agentSource: {
        rootDir: path.join(tempRoot, 'agents'),
        names: ['../../repo-operator'],
      },
      sharedClaudeHome: path.join(tempRoot, 'unused'),
    }),
    /agent name must be a single name/,
  );

  await assert.rejects(fs.access(isolationRoot), /ENOENT/);
});

void test('createClaudeIsolation requires shared Claude credentials', async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'claude-isolation-'),
  );
  tempDirs.push(tempRoot);
  process.env.CLAUDE_ISOLATED_HOME_ROOT = path.join(tempRoot, 'isolated');

  await assert.rejects(
    createClaudeIsolation({
      toolName: 'classifier',
      sharedClaudeHome: path.join(tempRoot, 'missing-shared-home'),
    }),
    /Missing required Claude shared credentials/,
  );
});
