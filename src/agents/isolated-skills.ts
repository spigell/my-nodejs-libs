import fs from 'node:fs/promises';
import path from 'node:path';

export type SkillSource = {
  rootDir: string;
  dirNames: readonly string[];
};

export type SkillSetDefinition = {
  rootDir: string;
  dirNames: readonly string[];
};

export type SkillRegistry = Record<string, SkillSetDefinition>;

export function resolveSkillSources(
  registry: SkillRegistry,
  skillSets: readonly string[],
): SkillSource[] {
  const resolved: SkillSource[] = [];

  for (const skillSetName of skillSets) {
    if (skillSetName === 'none') {
      continue;
    }
    const definition = registry[skillSetName];
    if (!definition) {
      throw new Error(`Unknown skill set requested: ${skillSetName}`);
    }
    resolved.push({
      rootDir: definition.rootDir,
      dirNames: definition.dirNames,
    });
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
