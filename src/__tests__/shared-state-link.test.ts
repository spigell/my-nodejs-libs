import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { linkSharedStateFile } from '../agents/shared-state-link.js';

async function setup(): Promise<{ sourcePath: string; targetPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-state-link-'));
  const sourcePath = path.join(root, 'shared', 'auth.json');
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, '{}\n', 'utf8');
  await fs.mkdir(path.join(root, 'home'));
  return { sourcePath, targetPath: path.join(root, 'home', 'auth.json') };
}

void test('linkSharedStateFile creates a symlink to the source', async () => {
  const { sourcePath, targetPath } = await setup();

  assert.equal(await linkSharedStateFile(sourcePath, targetPath), undefined);
  assert.equal(await fs.readlink(targetPath), sourcePath);
});

void test('linkSharedStateFile leaves a correct symlink alone', async () => {
  const { sourcePath, targetPath } = await setup();
  await fs.symlink(sourcePath, targetPath);
  const before = await fs.lstat(targetPath);

  assert.equal(await linkSharedStateFile(sourcePath, targetPath), undefined);
  const after = await fs.lstat(targetPath);
  assert.equal(after.ino, before.ino);
  assert.equal(await fs.readlink(targetPath), sourcePath);
});

void test('linkSharedStateFile replaces a symlink to another path', async () => {
  const { sourcePath, targetPath } = await setup();
  await fs.symlink(`${sourcePath}.old`, targetPath);

  assert.equal(await linkSharedStateFile(sourcePath, targetPath), undefined);
  assert.equal(await fs.readlink(targetPath), sourcePath);
});

void test('linkSharedStateFile replaces a regular file', async () => {
  const { sourcePath, targetPath } = await setup();
  await fs.writeFile(targetPath, 'stale\n', 'utf8');

  assert.equal(await linkSharedStateFile(sourcePath, targetPath), undefined);
  assert.equal(await fs.readlink(targetPath), sourcePath);
});

void test('linkSharedStateFile reports a missing source and keeps the target', async () => {
  const { sourcePath, targetPath } = await setup();
  await fs.rm(sourcePath);
  await fs.writeFile(targetPath, 'keep\n', 'utf8');

  const missing = await linkSharedStateFile(sourcePath, targetPath);
  assert.equal(missing?.code, 'ENOENT');
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'keep\n');
});
