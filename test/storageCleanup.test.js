import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import test from 'node:test';

import {
  cleanupBackupSnapshots,
  cleanupStaleSqliteTempFiles,
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

test('cleanupStaleSqliteTempFiles deletes only stale exact-pattern files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'metabiz-sqlite-temp-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const dbPath = path.join(root, 'sessions.db');
  const staleTemp = `${dbPath}.123-1700000000000-abcdefgh.tmp`;
  const youngTemp = `${dbPath}.456-1700000000001-ijklmnop.tmp`;
  const unrelatedTemp = path.join(root, 'sessions.db.manual.tmp');
  const otherDbTemp = path.join(root, 'other.db.123-1700000000000-abcdefgh.tmp');
  await Promise.all([
    fs.writeFile(dbPath, 'database'),
    fs.writeFile(staleTemp, 'stale-data'),
    fs.writeFile(youngTemp, 'young-data'),
    fs.writeFile(unrelatedTemp, 'keep'),
    fs.writeFile(otherDbTemp, 'keep'),
  ]);

  const now = Date.now();
  const oldTime = new Date(now - 2 * 60 * 60 * 1000);
  await fs.utimes(staleTemp, oldTime, oldTime);

  const result = await cleanupStaleSqliteTempFiles({
    dbPath,
    now,
    minAgeMs: 60 * 60 * 1000,
  });

  assert.equal(result.matched, 2);
  assert.equal(result.stale, 1);
  assert.equal(result.deleted, 1);
  assert.equal(result.deletedBytes, Buffer.byteLength('stale-data'));
  assert.equal(result.skippedYoung, 1);
  await assert.rejects(fs.stat(staleTemp), { code: 'ENOENT' });
  await Promise.all([
    fs.stat(dbPath),
    fs.stat(youngTemp),
    fs.stat(unrelatedTemp),
    fs.stat(otherDbTemp),
  ]);
});

test('cleanupStaleSqliteTempFiles protects active files and refuses symlinks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'metabiz-sqlite-temp-protected-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const dbPath = path.join(root, 'sessions.db');
  const protectedTemp = `${dbPath}.123-1700000000000-abcdefgh.tmp`;
  const symlinkTemp = `${dbPath}.456-1700000000001-ijklmnop.tmp`;
  const outside = path.join(root, 'outside');
  await fs.writeFile(protectedTemp, 'active');
  await fs.writeFile(outside, 'outside');
  await fs.symlink(outside, symlinkTemp);
  const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(protectedTemp, oldTime, oldTime);

  const result = await cleanupStaleSqliteTempFiles({
    dbPath,
    protectedPaths: [protectedTemp],
  });

  assert.equal(result.deleted, 0);
  assert.equal(result.skippedProtected, 1);
  assert.equal(result.skippedNonFile, 1);
  await Promise.all([fs.stat(protectedTemp), fs.lstat(symlinkTemp), fs.stat(outside)]);
});
