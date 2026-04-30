import fs from 'node:fs/promises';
import path from 'node:path';

export type SkillSource = {
  rootDir: string;
  dirNames: readonly string[];
};

export type IsolatedSkillSet = 'none' | 'kubernetes';

export type SkillSourceOptions = {
  kubernetesSkillsRoot?: string;
};

const KUBERNETES_SKILL_DIRS = [
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
] as const;

function resolveKubernetesSkillsRoot(
  options?: SkillSourceOptions,
): string | null {
  return (
    options?.kubernetesSkillsRoot ??
    process.env.KUBERNETES_SKILLS_ROOT ??
    process.env.AGENT_KUBERNETES_SKILLS_ROOT ??
    null
  );
}

export function getSkillSourcesForSet(
  skillSets: readonly IsolatedSkillSet[],
  options?: SkillSourceOptions,
): SkillSource[] {
  const resolved: SkillSource[] = [];

  for (const skillSet of skillSets) {
    if (skillSet === 'none') {
      continue;
    }
    if (skillSet === 'kubernetes') {
      const rootDir = resolveKubernetesSkillsRoot(options);
      if (!rootDir) {
        throw new Error(
          'The "kubernetes" isolated skill set requires kubernetesSkillsRoot or KUBERNETES_SKILLS_ROOT.',
        );
      }
      resolved.push({ rootDir, dirNames: KUBERNETES_SKILL_DIRS });
      continue;
    }
  }

  return resolved;
}

async function assertDirectoryExists(dirPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(dirPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Configured skill directory is missing: ${dirPath}. ${message}`,
      {
        cause: error,
      },
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`Configured skill path is not a directory: ${dirPath}`);
  }
}

export async function syncIsolatedSkills(
  destinationDir: string,
  skillSources: readonly SkillSource[] = [],
): Promise<void> {
  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(destinationDir, { recursive: true });

  const seenDestinationNames = new Map<string, string>();

  for (const source of skillSources) {
    await assertDirectoryExists(source.rootDir);

    for (const dirName of source.dirNames) {
      const sourceDir = path.join(source.rootDir, dirName);
      const destinationPath = path.join(destinationDir, dirName);

      await assertDirectoryExists(sourceDir);

      const existingSource = seenDestinationNames.get(dirName);
      if (existingSource) {
        throw new Error(
          `Skill destination collision for "${dirName}" while merging ${existingSource} and ${sourceDir}`,
        );
      }

      await fs.cp(sourceDir, destinationPath, { recursive: true });
      seenDestinationNames.set(dirName, sourceDir);
    }
  }
}
