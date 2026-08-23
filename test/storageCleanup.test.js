import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import test from 'node:test';

import {
  cleanupBackupSnapshots,
  removeDirectoryTreeBounded,
  resolveStorageCleanupPolicy,
} from '../src/services/storageCleanup.js';

test('resolveStorageCleanupPolicy accelerates until disk is below the cleanup target', () => {
  const cleanupConfig = {
    pressureAdaptiveEnabled: true,
    pressureTargetPercent: 85,
    pressureMaxDeletePerRun: 5000,
    pressureIntervalMs: 300000,
    pressureStartupDelayMs: 10000,
    maxDeletePerRun: 1000,
    intervalMs: 1800000,
    startupDelayMs: 300000,
  };

  assert.deepEqual(
    resolveStorageCleanupPolicy({ usedPercent: 92, warning: true, pressured: false }, cleanupConfig),
    {
      mode: 'accelerated',
      accelerated: true,
      usedPercent: 92,
      targetPercent: 85,
      maxDeletePerRun: 5000,
      nextIntervalMs: 300000,
      startupDelayMs: 10000,
    }
  );
  assert.equal(
    resolveStorageCleanupPolicy({ usedPercent: 84, warning: false, pressured: false }, cleanupConfig).mode,
    'normal'
  );
  assert.equal(
    resolveStorageCleanupPolicy({ usedPercent: 96, warning: true, pressured: true }, cleanupConfig).mode,
    'pressure'
  );
});

test('cleanupBackupSnapshots only deletes old allowlisted directories', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'metabiz-backup-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const oldSnapshot = path.join(root, 'reset-zero-old');
  const youngSnapshot = path.join(root, 'reset-zero-young');
  const protectedSqliteBackups = path.join(root, 'sessions-db');
  const unmatchedDirectory = path.join(root, 'manual-snapshot');
  const ordinaryFile = path.join(root, 'reset-zero-file');
  const symlinkPath = path.join(root, 'reset-zero-link');

  await Promise.all([
    fs.mkdir(oldSnapshot),
    fs.mkdir(youngSnapshot),
    fs.mkdir(protectedSqliteBackups),
    fs.mkdir(unmatchedDirectory),
    fs.writeFile(ordinaryFile, 'keep'),
  ]);
  await fs.symlink(oldSnapshot, symlinkPath);

  const now = Date.now();
  const oldTime = new Date(now - 10 * 24 * 60 * 60 * 1000);
  await fs.utimes(oldSnapshot, oldTime, oldTime);

  const result = await cleanupBackupSnapshots({
    backupRoot: root,
    now,
    enabled: true,
    minAgeMs: 7 * 24 * 60 * 60 * 1000,
    maxDelete: 10,
    allowedPrefixes: ['reset-zero-'],
    protectedDirectoryNames: ['sessions-db'],
  });

  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 0);
  await assert.rejects(fs.stat(oldSnapshot), { code: 'ENOENT' });
  await Promise.all([
    fs.stat(youngSnapshot),
    fs.stat(protectedSqliteBackups),
    fs.stat(unmatchedDirectory),
    fs.stat(ordinaryFile),
    fs.lstat(symlinkPath),
  ]);
});

test('cleanupBackupSnapshots is harmless when backup root is missing or disabled', async () => {
  const missing = await cleanupBackupSnapshots({
    backupRoot: path.join(os.tmpdir(), `metabiz-missing-${Date.now()}`),
    enabled: true,
  });
  const disabled = await cleanupBackupSnapshots({
    backupRoot: '/not-used',
    enabled: false,
  });

  assert.equal(missing.deleted, 0);
  assert.equal(missing.failed, 0);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.deleted, 0);
});

test('cleanupBackupSnapshots refuses a filesystem root', async () => {
  const root = path.parse(process.cwd()).root;
  const result = await cleanupBackupSnapshots({
    backupRoot: root,
    enabled: true,
    allowedPrefixes: ['reset-zero-'],
  });

  assert.equal(result.deleted, 0);
  assert.equal(result.skippedUnsafe, 1);
});

test('removeDirectoryTreeBounded deletes nested content without following symlinks', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'metabiz-bounded-delete-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));

  const target = path.join(parent, 'target');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(path.join(target, 'nested', 'deeper'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(target, 'nested', 'deeper', 'payload.bin'), 'payload');
  await fs.writeFile(path.join(outside, 'preserved.txt'), 'preserved');
  await fs.symlink(outside, path.join(target, 'outside-link'));

  await removeDirectoryTreeBounded(target);

  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(outside, 'preserved.txt'), 'utf8'), 'preserved');
});
