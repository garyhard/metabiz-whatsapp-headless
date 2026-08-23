import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { sessionStore } from './sessionStore.js';
import { getAllSessionIds } from './sessionManager.js';
import { getDiskPressureStatus } from './systemHealth.js';
import { cleanupBackupSnapshots, resolveStorageCleanupPolicy } from './storageCleanup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_ROOT = path.resolve(__dirname, '../../profiles');
const DEBUG_ROOT = path.join(PROFILE_ROOT, 'debug');
const BACKUP_ROOT = path.resolve(
  config.profileCleanup.backupRoot || path.join(PROFILE_ROOT, '../../shared/backups')
);
const SESSION_DIR_PREFIX = 'session-';

const cleanupState = {
  enabled: config.profileCleanup.enabled,
  running: false,
  timer: null,
  lastRunAt: null,
  lastFinishedAt: null,
  lastDurationMs: null,
  lastReason: null,
  lastResult: null,
  lastError: null,
  nextRunAt: null,
  generation: 0,
};

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function sessionIdFromProfileName(name) {
  if (!name || !name.startsWith(SESSION_DIR_PREFIX)) return null;
  return name.slice(SESSION_DIR_PREFIX.length).trim() || null;
}

function parseActiveSessionIdsFromProcessList() {
  const active = new Set();
  try {
    const output = execFileSync('ps', ['-eo', 'args'], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 1024 * 1024 * 4,
    });
    const pattern = /--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/g;
    let match;
    while ((match = pattern.exec(output)) !== null) {
      const userDataDir = match[1] || match[2] || match[3] || '';
      const basename = path.basename(userDataDir);
      const sessionId = sessionIdFromProfileName(basename);
      if (sessionId) active.add(sessionId);
    }
  } catch (error) {
    console.warn('[ProfileCleanup] Unable to inspect active browser processes:', error?.message || error);
  }
  return active;
}

async function removePath(targetPath) {
  if (!isInside(PROFILE_ROOT, targetPath)) {
    throw new Error(`Refusing to remove path outside profile root: ${targetPath}`);
  }
  await fs.rm(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 2,
    retryDelay: 100,
  });
}

async function cleanupOrphanProfiles(now, { maxDelete: maxDeleteOverride = null } = {}) {
  const knownSessionIds = new Set(sessionStore.listStoredSessionIds());
  const processSessionIds = parseActiveSessionIdsFromProcessList();
  const loadedSessionIds = new Set(getAllSessionIds());
  const protectedSessionIds = new Set([...processSessionIds, ...loadedSessionIds]);
  const orphanMinAgeMs = Math.max(1000, Number(config.profileCleanup.orphanMinAgeMs) || 24 * 60 * 60 * 1000);
  const knownInactiveEnabled = config.profileCleanup.knownInactiveEnabled === true;
  const knownInactiveMinAgeMs = Math.max(
    1000,
    Number(config.profileCleanup.knownInactiveMinAgeMs) || 60 * 60 * 1000
  );
  const maxDelete = Math.max(
    1,
    Number(maxDeleteOverride) || Number(config.profileCleanup.maxDeletePerRun) || 500
  );
  const orphanCutoff = now - orphanMinAgeMs;
  const knownInactiveCutoff = now - knownInactiveMinAgeMs;
  const result = {
    checked: 0,
    deleted: 0,
    deletedOrphan: 0,
    deletedKnownInactive: 0,
    skippedKnown: 0,
    skippedActive: 0,
    skippedYoung: 0,
    skippedUnsafe: 0,
    skippedNonDirectory: 0,
    failed: 0,
    failures: [],
    knownSessions: knownSessionIds.size,
    activeBrowsers: processSessionIds.size,
    loadedSessions: loadedSessionIds.size,
    protectedSessions: protectedSessionIds.size,
    profileDirectories: 0,
    remainingProfileDirectories: 0,
    maxDelete,
    orphanMinAgeMs,
    knownInactiveEnabled,
    knownInactiveMinAgeMs,
  };

  let entries = [];
  try {
    entries = await fs.readdir(PROFILE_ROOT, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }
  result.profileDirectories = entries.filter(
    (entry) => entry.isDirectory() && entry.name.startsWith(SESSION_DIR_PREFIX)
  ).length;

  for (const entry of entries) {
    if (result.deleted >= maxDelete) break;
    if (!entry.name.startsWith(SESSION_DIR_PREFIX)) continue;

    result.checked += 1;
    const sessionId = sessionIdFromProfileName(entry.name);
    const fullPath = path.join(PROFILE_ROOT, entry.name);

    if (!entry.isDirectory() || !sessionId) {
      result.skippedNonDirectory += 1;
      continue;
    }
    if (!isInside(PROFILE_ROOT, fullPath)) {
      result.skippedUnsafe += 1;
      continue;
    }
    if (protectedSessionIds.has(sessionId)) {
      result.skippedActive += 1;
      continue;
    }

    try {
      const stat = await fs.lstat(fullPath);
      if (!stat.isDirectory()) {
        result.skippedNonDirectory += 1;
        continue;
      }
      const isKnownSession = knownSessionIds.has(sessionId);
      if (isKnownSession && !knownInactiveEnabled) {
        result.skippedKnown += 1;
        continue;
      }
      const cutoff = isKnownSession ? knownInactiveCutoff : orphanCutoff;
      if (Number(stat.mtimeMs || 0) > cutoff) {
        result.skippedYoung += 1;
        continue;
      }
      await removePath(fullPath);
      result.deleted += 1;
      if (isKnownSession) {
        result.deletedKnownInactive += 1;
      } else {
        result.deletedOrphan += 1;
      }
    } catch (error) {
      result.failed += 1;
      if (result.failures.length < 10) {
        result.failures.push({
          path: fullPath,
          error: error?.message || String(error),
        });
      }
    }
  }

  result.remainingProfileDirectories = Math.max(0, result.profileDirectories - result.deleted);

  return result;
}

async function cleanupDebugFiles(now) {
  const debugMaxAgeMs = Math.max(1000, Number(config.profileCleanup.debugMaxAgeMs) || 3 * 24 * 60 * 60 * 1000);
  const maxDelete = Math.max(1, Number(config.profileCleanup.debugMaxDeletePerRun) || 5000);
  const cutoff = now - debugMaxAgeMs;
  const result = {
    checked: 0,
    deleted: 0,
    skippedYoung: 0,
    skippedDirectory: 0,
    failed: 0,
    failures: [],
    maxDelete,
    debugMaxAgeMs,
  };

  let entries = [];
  try {
    entries = await fs.readdir(DEBUG_ROOT, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }

  for (const entry of entries) {
    if (result.deleted >= maxDelete) break;
    result.checked += 1;
    const fullPath = path.join(DEBUG_ROOT, entry.name);

    try {
      const stat = await fs.lstat(fullPath);
      if (stat.isDirectory()) {
        result.skippedDirectory += 1;
        continue;
      }
      if (Number(stat.mtimeMs || 0) > cutoff) {
        result.skippedYoung += 1;
        continue;
      }
      await removePath(fullPath);
      result.deleted += 1;
    } catch (error) {
      result.failed += 1;
      if (result.failures.length < 10) {
        result.failures.push({
          path: fullPath,
          error: error?.message || String(error),
        });
      }
    }
  }

  return result;
}

function scheduleNext(delayMs) {
  if (!cleanupState.enabled) return;
  const safeDelay = Math.max(1000, Number(delayMs) || config.profileCleanup.intervalMs || 60 * 60 * 1000);
  if (cleanupState.timer) {
    clearTimeout(cleanupState.timer);
  }
  cleanupState.nextRunAt = Date.now() + safeDelay;
  cleanupState.timer = setTimeout(() => {
    cleanupState.timer = null;
    runProfileCleanup({ reason: 'scheduled' }).catch((error) => {
      console.error('[ProfileCleanup] Scheduled cleanup failed:', error);
    });
  }, safeDelay);
  cleanupState.timer.unref?.();
}

export async function runProfileCleanup({ reason = 'manual' } = {}) {
  if (!cleanupState.enabled) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  if (cleanupState.running) {
    return { ok: true, skipped: true, reason: 'already_running' };
  }

  const startedAt = Date.now();
  cleanupState.running = true;
  cleanupState.lastRunAt = startedAt;
  cleanupState.lastReason = reason;
  cleanupState.lastError = null;
  let nextIntervalMs = config.profileCleanup.intervalMs;

  try {
    const diskBefore = await getDiskPressureStatus();
    const policyBefore = resolveStorageCleanupPolicy(diskBefore, config.profileCleanup);
    const backupSnapshots = await cleanupBackupSnapshots({
      backupRoot: BACKUP_ROOT,
      now: startedAt,
      enabled: config.profileCleanup.backupCleanupEnabled,
      minAgeMs: config.profileCleanup.backupMinAgeMs,
      maxDelete: config.profileCleanup.backupMaxDeletePerRun,
      allowedPrefixes: config.profileCleanup.backupAllowedPrefixes,
      protectedDirectoryNames: ['sessions-db'],
    });
    const orphanProfiles = await cleanupOrphanProfiles(startedAt, {
      maxDelete: policyBefore.maxDeletePerRun,
    });
    const debugFiles = await cleanupDebugFiles(startedAt);
    const diskAfter = await getDiskPressureStatus();
    const policyAfter = resolveStorageCleanupPolicy(diskAfter, config.profileCleanup);
    nextIntervalMs = policyAfter.nextIntervalMs;
    const finishedAt = Date.now();
    const result = {
      ok: backupSnapshots.failed === 0 && orphanProfiles.failed === 0 && debugFiles.failed === 0,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      reason,
      profileRoot: PROFILE_ROOT,
      backupRoot: BACKUP_ROOT,
      policyBefore,
      policyAfter,
      diskBefore,
      diskAfter,
      estimatedReclaimedBytes: Math.max(
        0,
        Number(diskAfter.availableBytes || 0) - Number(diskBefore.availableBytes || 0)
      ),
      backupSnapshots,
      orphanProfiles,
      debugFiles,
    };

    cleanupState.lastFinishedAt = finishedAt;
    cleanupState.lastDurationMs = result.durationMs;
    cleanupState.lastResult = result;
    console.log(
      `[ProfileCleanup] ${reason} cleanup finished in ${result.durationMs}ms ` +
      `(mode=${policyBefore.mode}->${policyAfter.mode}; ` +
      `backupSnapshots deleted=${backupSnapshots.deleted}, failed=${backupSnapshots.failed}; ` +
      `orphanProfiles deleted=${orphanProfiles.deleted}, failed=${orphanProfiles.failed}; ` +
      `debugFiles deleted=${debugFiles.deleted}, failed=${debugFiles.failed})`
    );
    return result;
  } catch (error) {
    const finishedAt = Date.now();
    cleanupState.lastFinishedAt = finishedAt;
    cleanupState.lastDurationMs = finishedAt - startedAt;
    cleanupState.lastError = error?.message || String(error);
    cleanupState.lastResult = {
      ok: false,
      startedAt,
      finishedAt,
      durationMs: cleanupState.lastDurationMs,
      reason,
      error: cleanupState.lastError,
    };
    console.error('[ProfileCleanup] Cleanup failed:', error);
    return cleanupState.lastResult;
  } finally {
    cleanupState.running = false;
    scheduleNext(nextIntervalMs);
  }
}

export async function startProfileCleanupWorker() {
  cleanupState.enabled = config.profileCleanup.enabled;
  const generation = ++cleanupState.generation;
  if (!cleanupState.enabled) {
    console.log('[ProfileCleanup] Periodic cleanup disabled');
    return;
  }

  const disk = await getDiskPressureStatus();
  if (!cleanupState.enabled || cleanupState.generation !== generation) return;
  const startupPolicy = resolveStorageCleanupPolicy(disk, config.profileCleanup);
  scheduleNext(startupPolicy.startupDelayMs);
  console.log(
    `[ProfileCleanup] Periodic cleanup enabled ` +
    `(mode=${startupPolicy.mode}, startupDelayMs=${startupPolicy.startupDelayMs}, ` +
    `intervalMs=${startupPolicy.nextIntervalMs})`
  );
}

export function stopProfileCleanupWorker() {
  cleanupState.enabled = false;
  cleanupState.generation += 1;
  if (cleanupState.timer) {
    clearTimeout(cleanupState.timer);
    cleanupState.timer = null;
  }
  cleanupState.nextRunAt = null;
}

export function getProfileCleanupStatus(now = Date.now()) {
  return {
    enabled: cleanupState.enabled,
    running: cleanupState.running,
    profileRoot: PROFILE_ROOT,
    backupRoot: BACKUP_ROOT,
    nextRunAt: cleanupState.nextRunAt,
    nextRunInMs: cleanupState.nextRunAt ? Math.max(0, cleanupState.nextRunAt - now) : null,
    lastRunAt: cleanupState.lastRunAt,
    lastFinishedAt: cleanupState.lastFinishedAt,
    lastDurationMs: cleanupState.lastDurationMs,
    lastReason: cleanupState.lastReason,
    lastError: cleanupState.lastError,
    lastResult: cleanupState.lastResult,
    config: {
      intervalMs: config.profileCleanup.intervalMs,
      startupDelayMs: config.profileCleanup.startupDelayMs,
      pressureAdaptiveEnabled: config.profileCleanup.pressureAdaptiveEnabled,
      pressureTargetPercent: config.profileCleanup.pressureTargetPercent,
      pressureIntervalMs: config.profileCleanup.pressureIntervalMs,
      pressureStartupDelayMs: config.profileCleanup.pressureStartupDelayMs,
      pressureMaxDeletePerRun: config.profileCleanup.pressureMaxDeletePerRun,
      orphanMinAgeMs: config.profileCleanup.orphanMinAgeMs,
      maxDeletePerRun: config.profileCleanup.maxDeletePerRun,
      knownInactiveEnabled: config.profileCleanup.knownInactiveEnabled,
      knownInactiveMinAgeMs: config.profileCleanup.knownInactiveMinAgeMs,
      debugMaxAgeMs: config.profileCleanup.debugMaxAgeMs,
      debugMaxDeletePerRun: config.profileCleanup.debugMaxDeletePerRun,
      backupCleanupEnabled: config.profileCleanup.backupCleanupEnabled,
      backupMinAgeMs: config.profileCleanup.backupMinAgeMs,
      backupMaxDeletePerRun: config.profileCleanup.backupMaxDeletePerRun,
      backupAllowedPrefixes: config.profileCleanup.backupAllowedPrefixes,
    },
  };
}
