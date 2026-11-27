import fs from 'node:fs/promises';

/**
 * Links a shared state file into an isolated agent home: the target becomes a
 * symlink to `sourcePath`, unless it already is one. Resolves to the `ENOENT`
 * error when the source does not exist (the target is left untouched), and to
 * `undefined` once the link is in place. Any other error is rethrown.
 */
export async function linkSharedStateFile(
  sourcePath: string,
  targetPath: string,
): Promise<NodeJS.ErrnoException | undefined> {
  try {
    await fs.lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return error as NodeJS.ErrnoException;
    }
    throw error;
  }

  try {
    const existing = await fs.lstat(targetPath);
    if (
      existing.isSymbolicLink() &&
      (await fs.readlink(targetPath)) === sourcePath
    ) {
      return undefined;
    }
    await fs.rm(targetPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.symlink(sourcePath, targetPath);
  return undefined;
}
