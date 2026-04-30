import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import {
  getSkillSourcesForSet,
  syncIsolatedSkills,
} from '../agents/isolated-skills.js';

const originalKubernetesSkillsRoot = process.env.KUBERNETES_SKILLS_ROOT;
const originalAgentKubernetesSkillsRoot =
  process.env.AGENT_KUBERNETES_SKILLS_ROOT;

afterEach(() => {
  process.env.KUBERNETES_SKILLS_ROOT = originalKubernetesSkillsRoot;
  process.env.AGENT_KUBERNETES_SKILLS_ROOT = originalAgentKubernetesSkillsRoot;
});

async function createSkillDir(
  rootDir: string,
  skillName: string,
  fileName = 'SKILL.md',
): Promise<void> {
  const dirPath = path.join(rootDir, skillName);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(path.join(dirPath, fileName), `# ${skillName}\n`, 'utf8');
}

void test('syncIsolatedSkills merges configured source directories into one destination', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-skills-'));
  const sourceA = path.join(tempRoot, 'common-skills');
  const sourceB = path.join(tempRoot, 'k8s-skills');
  const destination = path.join(tempRoot, 'dest', 'skills');

  await createSkillDir(sourceA, 'shared-infra-guider');
  await createSkillDir(sourceB, 'k8s-troubleshoot');

  await syncIsolatedSkills(destination, [
    { rootDir: sourceA, dirNames: ['shared-infra-guider'] },
    { rootDir: sourceB, dirNames: ['k8s-troubleshoot'] },
  ]);

  await assert.doesNotReject(
    fs.access(path.join(destination, 'shared-infra-guider', 'SKILL.md')),
  );
  await assert.doesNotReject(
    fs.access(path.join(destination, 'k8s-troubleshoot', 'SKILL.md')),
  );
});

void test('syncIsolatedSkills removes stale destination contents before copy', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-skills-'));
  const source = path.join(tempRoot, 'common-skills');
  const destination = path.join(tempRoot, 'dest', 'skills');

  await createSkillDir(source, 'research-orchestrator');
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'stale.txt'), 'old\n', 'utf8');

  await syncIsolatedSkills(destination, [
    { rootDir: source, dirNames: ['research-orchestrator'] },
  ]);

  await assert.rejects(fs.access(path.join(destination, 'stale.txt')));
  await assert.doesNotReject(
    fs.access(path.join(destination, 'research-orchestrator', 'SKILL.md')),
  );
});

void test('syncIsolatedSkills fails on source collisions', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-skills-'));
  const sourceA = path.join(tempRoot, 'common-skills');
  const sourceB = path.join(tempRoot, 'k8s-skills');
  const destination = path.join(tempRoot, 'dest', 'skills');

  await createSkillDir(sourceA, 'duplicate-skill');
  await createSkillDir(sourceB, 'duplicate-skill');

  await assert.rejects(
    syncIsolatedSkills(destination, [
      { rootDir: sourceA, dirNames: ['duplicate-skill'] },
      { rootDir: sourceB, dirNames: ['duplicate-skill'] },
    ]),
    /Skill destination collision/,
  );
});

void test('syncIsolatedSkills fails when a configured source directory is missing', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-skills-'));
  const source = path.join(tempRoot, 'common-skills');
  const destination = path.join(tempRoot, 'dest', 'skills');

  await fs.mkdir(source, { recursive: true });

  await assert.rejects(
    syncIsolatedSkills(destination, [
      { rootDir: source, dirNames: ['missing-skill'] },
    ]),
    /Configured skill directory is missing/,
  );
});

void test('getSkillSourcesForSet returns no sources by default', () => {
  assert.deepEqual(getSkillSourcesForSet([]), []);
  assert.deepEqual(getSkillSourcesForSet(['none']), []);
});

void test('getSkillSourcesForSet requires an explicit Kubernetes skills root', () => {
  delete process.env.KUBERNETES_SKILLS_ROOT;
  delete process.env.AGENT_KUBERNETES_SKILLS_ROOT;

  assert.throws(
    () => getSkillSourcesForSet(['kubernetes']),
    /requires kubernetesSkillsRoot/,
  );
  assert.equal(
    getSkillSourcesForSet(['kubernetes'], {
      kubernetesSkillsRoot: '/skills',
    })[0]?.rootDir,
    '/skills',
  );
});
