import fs from 'fs/promises';
import path from 'path';

const DEFAULT_NORMAL_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_ACCELERATED_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_NORMAL_MAX_DELETE = 1000;
const DEFAULT_ACCELERATED_MAX_DELETE = 5000;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function ignoreMissing(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function removeDirectoryTreeBounded(targetPath, fsApi = fs) {
  let directory;
  try {
    directory = await fsApi.opendir(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  for await (const entry of directory) {
    const childPath = path.join(targetPath, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await removeDirectoryTreeBounded(childPath, fsApi);
    } else {
      await ignoreMissing(() => fsApi.unlink(childPath));
    }
  }

  await ignoreMissing(() => fsApi.rmdir(targetPath));
}

export function resolveStorageCleanupPolicy(disk, cleanupConfig = {}) {
  const usedPercent = Number(disk?.usedPercent);
  const targetPercent = positiveNumber(cleanupConfig.pressureTargetPercent, 85);
  const adaptiveEnabled = cleanupConfig.pressureAdaptiveEnabled !== false;
  const accelerated = adaptiveEnabled && (
    disk?.pressured === true ||
    disk?.warning === true ||
    (Number.isFinite(usedPercent) && usedPercent >= targetPercent)
  );

  return {
    mode: disk?.pressured === true ? 'pressure' : (accelerated ? 'accelerated' : 'normal'),
    accelerated,
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
    targetPercent,
    maxDeletePerRun: Math.max(1, Math.trunc(positiveNumber(
      accelerated ? cleanupConfig.pressureMaxDeletePerRun : cleanupConfig.maxDeletePerRun,
      accelerated ? DEFAULT_ACCELERATED_MAX_DELETE : DEFAULT_NORMAL_MAX_DELETE
    ))),
    nextIntervalMs: Math.max(1000, Math.trunc(positiveNumber(
      accelerated ? cleanupConfig.pressureIntervalMs : cleanupConfig.intervalMs,
      accelerated ? DEFAULT_ACCELERATED_INTERVAL_MS : DEFAULT_NORMAL_INTERVAL_MS
    ))),
    startupDelayMs: Math.max(1000, Math.trunc(positiveNumber(
      accelerated ? cleanupConfig.pressureStartupDelayMs : cleanupConfig.startupDelayMs,
      accelerated ? 10000 : 5 * 60 * 1000
    ))),
  };
}

export async function cleanupBackupSnapshots({
  backupRoot,
  now = Date.now(),
  enabled = true,
  minAgeMs = 7 * 24 * 60 * 60 * 1000,
  maxDelete = 10,
  allowedPrefixes = ['reset-zero-'],
  protectedDirectoryNames = ['sessions-db'],
  fsApi = fs,
} = {}) {
  const root = path.resolve(String(backupRoot || ''));
  const prefixes = Array(allowedPrefixes).map((value) => String(value || '').trim()).filter(Boolean);
  const protectedNames = new Set(
    Array(protectedDirectoryNames).map((value) => String(value || '').trim()).filter(Boolean)
  );
  const safeMinAgeMs = Math.max(1000, positiveNumber(minAgeMs, 7 * 24 * 60 * 60 * 1000));
  const safeMaxDelete = Math.max(1, Math.trunc(positiveNumber(maxDelete, 10)));
  const cutoff = now - safeMinAgeMs;
  const result = {
    enabled: enabled === true,
    root,
    checked: 0,
    deleted: 0,
    skippedProtected: 0,
    skippedPrefix: 0,
    skippedYoung: 0,
    skippedNonDirectory: 0,
    skippedUnsafe: 0,
    failed: 0,
    failures: [],
    maxDelete: safeMaxDelete,
    minAgeMs: safeMinAgeMs,
    allowedPrefixes: prefixes,
    protectedDirectoryNames: [...protectedNames],
  };

  if (!result.enabled || !backupRoot || prefixes.length === 0) return result;
  if (root === path.parse(root).root) {
    result.skippedUnsafe += 1;
    return result;
  }

  let entries;
  try {
    entries = await fsApi.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }

  for (const entry of entries) {
    if (result.deleted >= safeMaxDelete) break;
    result.checked += 1;

    if (protectedNames.has(entry.name)) {
      result.skippedProtected += 1;
      continue;
    }
    if (!entry.isDirectory()) {
      result.skippedNonDirectory += 1;
      continue;
    }
    if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) {
      result.skippedPrefix += 1;
      continue;
    }

    const targetPath = path.join(root, entry.name);
    if (!isInside(root, targetPath)) {
      result.skippedUnsafe += 1;
      continue;
    }

    try {
      const stat = await fsApi.lstat(targetPath);
      if (!stat.isDirectory()) {
        result.skippedNonDirectory += 1;
        continue;
      }
      if (Number(stat.mtimeMs || 0) > cutoff) {
        result.skippedYoung += 1;
        continue;
      }
      await removeDirectoryTreeBounded(targetPath, fsApi);
      result.deleted += 1;
    } catch (error) {
      result.failed += 1;
      if (result.failures.length < 10) {
        result.failures.push({
          path: targetPath,
          error: error?.message || String(error),
        });
      }
    }
  }

  return result;
}
