import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { createCodexIsolation } from '../agents/codex-isolation.js';

const originalCodexRoot = process.env.CODEX_ISOLATED_HOME_ROOT;
const tempDirs: string[] = [];

afterEach(async () => {
  process.env.CODEX_ISOLATED_HOME_ROOT = originalCodexRoot;
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

void test('createCodexIsolation writes config, roles, env, and requested skills', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-isolation-'));
  tempDirs.push(tempRoot);
  process.env.CODEX_ISOLATED_HOME_ROOT = tempRoot;

  const sharedCodexHome = path.join(tempRoot, 'shared-codex-home');
  await fs.mkdir(sharedCodexHome, { recursive: true });
  await fs.writeFile(
    path.join(sharedCodexHome, 'auth.json'),
    '{"tokens":{}}\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(sharedCodexHome, '.credentials.json'),
    '{"account_id":"test"}\n',
    'utf8',
  );

  const skillRoot = path.join(tempRoot, 'source-skills');
  const skillNames = [
    'k8s-autoscaling',
    'k8s-backup',
    'k8s-browser',
    'k8s-capi',
    'k8s-certs',
    'k8s-cilium',
    'k8s-cli',
    'k8s-core',
    'k8s-cost',
    'k8s-deploy',
    'k8s-diagnostics',
    'k8s-gitops',
    'k8s-helm',
    'k8s-incident',
    'k8s-kind',
    'k8s-kubevirt',
    'k8s-multicluster',
    'k8s-networking',
    'k8s-operations',
    'k8s-policy',
    'k8s-rollouts',
    'k8s-security',
    'k8s-service-mesh',
    'k8s-storage',
    'k8s-troubleshoot',
    'k8s-vind',
  ];
  await Promise.all(
    skillNames.map(async (skillName) => {
      await fs.mkdir(path.join(skillRoot, skillName), { recursive: true });
      await fs.writeFile(
        path.join(skillRoot, skillName, 'SKILL.md'),
        `# ${skillName}\n`,
        'utf8',
      );
    }),
  );

  const result = await createCodexIsolation({
    toolName: 'task-runner',
    codexConfig: {
      model: 'gpt-5.4',
      reasoning_effort: 'high',
      approval_policy: 'on-request',
      sandbox_mode: 'workspace-write',
      color: 'never',
      config: {
        mcp_servers: {
          'github-mcp': {
            url: 'http://mcp-github-codex:8080/mcp/',
            enabled_tools: ['pull_request_read'],
          },
        },
        features: {
          shell_tool: true,
          multi_agent: true,
        },
        skills: {
          bundled: {
            enabled: false,
          },
        },
      },
      roleConfigs: {
        default: 'model = "gpt-5.4"\n',
      },
    },
    targetWorkspace: '/project',
    additionalWorkspaces: ['/project/reforge/runner', '/project'],
    skillSources: [{ rootDir: skillRoot, dirNames: skillNames }],
    sharedCodexHome,
  });

  assert.equal(
    result.env.CODEX_HOME,
    path.join(tempRoot, 'codex', 'task-runner'),
  );
  assert.equal(result.env.NO_COLOR, '1');
  assert.equal(
    result.configPath,
    path.join(result.isolatedHome, 'config.toml'),
  );

  const config = await fs.readFile(result.configPath, 'utf8');
  assert.equal(config, result.configContent);
  assert.match(config, /model = "gpt-5.4"/);
  assert.match(config, /model_reasoning_effort = "high"/);
  assert.match(config, /\[mcp_servers\.github-mcp\]/);
  assert.match(config, /\[features\]/);
  assert.match(config, /multi_agent = true/);
  assert.doesNotMatch(config, /\[mcp_servers\.reforge-tasks-mcp\]/);
  assert.match(config, /"\/project" = \{ trust_level = "trusted" \}/);
  assert.match(
    config,
    /"\/project\/reforge\/runner" = \{ trust_level = "trusted" \}/,
  );

  await assert.doesNotReject(
    fs.access(path.join(result.isolatedHome, 'roles', 'default.toml')),
  );
  await assert.doesNotReject(
    fs.access(path.join(result.skillsDir, 'k8s-autoscaling', 'SKILL.md')),
  );
  assert.equal(result.authPath, path.join(result.isolatedHome, 'auth.json'));
  assert.equal(
    await fs.readlink(result.authPath),
    path.join(sharedCodexHome, 'auth.json'),
  );
  assert.equal(
    await fs.readlink(result.credentialsPath),
    path.join(sharedCodexHome, '.credentials.json'),
  );
});

void test('createCodexIsolation requires shared auth.json', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-isolation-'));
  tempDirs.push(tempRoot);
  process.env.CODEX_ISOLATED_HOME_ROOT = tempRoot;

  const sharedCodexHome = path.join(tempRoot, 'shared-codex-home');
  await fs.mkdir(sharedCodexHome, { recursive: true });

  await assert.rejects(
    createCodexIsolation({
      toolName: 'missing-auth',
      sharedCodexHome,
    }),
    /Missing required Codex shared state file "auth\.json"/,
  );
});
