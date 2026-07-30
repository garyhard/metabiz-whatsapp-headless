/**
 * SQLite-backed session store (sql.js)
 */

import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DB_PATH = path.join(__dirname, '../../profiles/sessions.db');
const DB_PATH = process.env.SESSIONS_DB_PATH || DEFAULT_DB_PATH;

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const SQL = await initSqlJs({
  locateFile: (file) => {
    return path.join(__dirname, '../../node_modules/sql.js/dist', file);
  },
});

let db;
if (fs.existsSync(DB_PATH)) {
  const data = fs.readFileSync(DB_PATH);
  db = new SQL.Database(data);
} else {
  db = new SQL.Database();
}

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    c_user TEXT NOT NULL,
    cookie_format TEXT NOT NULL,
    cookies TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    proxy TEXT,
    twofa_secret TEXT,
    status TEXT,
    restricted INTEGER NOT NULL DEFAULT 0,
    restriction_details_json TEXT,
    restriction_detected_at INTEGER,
    queue_blocked_until INTEGER,
    queue_block_reason TEXT,
    queue_blocked_at INTEGER,
    last_activity INTEGER,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);
  CREATE TABLE IF NOT EXISTS fingerprints (
    c_user TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS message_jobs (
    id TEXT PRIMARY KEY,
    request_id TEXT UNIQUE,
    meta_blast_message_id TEXT,
    session_id TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    message_type TEXT NOT NULL DEFAULT 'text',
    extension TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    message TEXT NOT NULL,
    media_payload_json TEXT,
    use_reply_flow INTEGER NOT NULL DEFAULT 0,
    include_success_screenshot INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    error_message TEXT,
    result_json TEXT,
    next_retry_at INTEGER NOT NULL DEFAULT 0,
    webhook_notified INTEGER NOT NULL DEFAULT 0,
    webhook_attempts INTEGER NOT NULL DEFAULT 0,
    webhook_next_retry_at INTEGER NOT NULL DEFAULT 0,
    webhook_last_error TEXT,
    webhook_delivered_at INTEGER,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_message_jobs_status_next_retry
    ON message_jobs(status, next_retry_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_message_jobs_session_status_retry_created
    ON message_jobs(session_id, status, next_retry_at, priority, created_at);
  CREATE INDEX IF NOT EXISTS idx_message_jobs_status_session_created
    ON message_jobs(status, session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_message_jobs_webhook_pending
    ON message_jobs(webhook_notified, status, webhook_next_retry_at, updated_at);
  CREATE TABLE IF NOT EXISTS message_job_archives (
    id TEXT PRIMARY KEY,
    request_id TEXT,
    meta_blast_message_id TEXT,
    session_id TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    message_type TEXT NOT NULL DEFAULT 'text',
    extension TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    message TEXT NOT NULL,
    media_payload_json TEXT,
    use_reply_flow INTEGER NOT NULL DEFAULT 0,
    include_success_screenshot INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'archived',
    original_status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    error_message TEXT,
    result_json TEXT,
    next_retry_at INTEGER NOT NULL DEFAULT 0,
    webhook_notified INTEGER NOT NULL DEFAULT 1,
    webhook_attempts INTEGER NOT NULL DEFAULT 0,
    webhook_next_retry_at INTEGER NOT NULL DEFAULT 0,
    webhook_last_error TEXT,
    webhook_delivered_at INTEGER,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER NOT NULL,
    archive_reason TEXT,
    archive_source TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_message_job_archives_status_archived
    ON message_job_archives(status, archived_at);
  CREATE INDEX IF NOT EXISTS idx_message_job_archives_session_archived
    ON message_job_archives(session_id, archived_at);
  CREATE TABLE IF NOT EXISTS session_flow_jobs (
    id TEXT PRIMARY KEY,
    request_id TEXT UNIQUE,
    job_type TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    coalesce_key TEXT,
    target_session_id TEXT,
    c_user TEXT,
    payload_json TEXT,
    webhook_url TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    error_message TEXT,
    error_code TEXT,
    result_json TEXT,
    next_retry_at INTEGER NOT NULL DEFAULT 0,
    webhook_notified INTEGER NOT NULL DEFAULT 0,
    webhook_attempts INTEGER NOT NULL DEFAULT 0,
    webhook_next_retry_at INTEGER NOT NULL DEFAULT 0,
    webhook_last_error TEXT,
    webhook_delivered_at INTEGER,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_session_flow_jobs_status_next_retry
    ON session_flow_jobs(status, next_retry_at, created_at);
  CREATE TABLE IF NOT EXISTS create_operations (
    id TEXT PRIMARY KEY,
    request_id TEXT UNIQUE,
    c_user TEXT,
    payload_json TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    step TEXT,
    message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    error_message TEXT,
    error_code TEXT,
    result_json TEXT,
    debug_json TEXT,
    next_retry_at INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_create_operations_status_next_retry
    ON create_operations(status, next_retry_at, created_at);
`);

try {
  db.exec('ALTER TABLE sessions ADD COLUMN twofa_secret TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE sessions ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE sessions ADD COLUMN restriction_details_json TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE sessions ADD COLUMN restriction_detected_at INTEGER');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE sessions ADD COLUMN queue_blocked_until INTEGER');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE sessions ADD COLUMN queue_block_reason TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE sessions ADD COLUMN queue_blocked_at INTEGER');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE message_jobs ADD COLUMN webhook_notified INTEGER NOT NULL DEFAULT 0');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE message_jobs ADD COLUMN webhook_attempts INTEGER NOT NULL DEFAULT 0');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE message_jobs ADD COLUMN webhook_next_retry_at INTEGER NOT NULL DEFAULT 0');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE message_jobs ADD COLUMN webhook_last_error TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE message_jobs ADD COLUMN webhook_delivered_at INTEGER');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE message_jobs ADD COLUMN meta_blast_message_id TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec("ALTER TABLE message_jobs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
} catch {
  // Column already exists.
}

try {
  db.exec("ALTER TABLE message_jobs ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text'");
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE message_jobs ADD COLUMN media_payload_json TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_jobs_status_retry_priority_created
      ON message_jobs(status, next_retry_at, priority, created_at)
  `);
} catch {
  // Index already exists.
}

try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_jobs_session_status_retry_created
      ON message_jobs(session_id, status, next_retry_at, priority, created_at)
  `);
} catch {
  // Index already exists.
}

try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_jobs_status_session_created
      ON message_jobs(status, session_id, created_at)
  `);
} catch {
  // Index already exists.
}

try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_jobs_webhook_pending
      ON message_jobs(webhook_notified, status, webhook_next_retry_at, updated_at)
  `);
} catch {
  // Index already exists.
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_job_archives (
      id TEXT PRIMARY KEY,
      request_id TEXT,
      meta_blast_message_id TEXT,
      session_id TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      message_type TEXT NOT NULL DEFAULT 'text',
      extension TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      message TEXT NOT NULL,
      media_payload_json TEXT,
      use_reply_flow INTEGER NOT NULL DEFAULT 0,
      include_success_screenshot INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'archived',
      original_status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      error_message TEXT,
      result_json TEXT,
      next_retry_at INTEGER NOT NULL DEFAULT 0,
      webhook_notified INTEGER NOT NULL DEFAULT 1,
      webhook_attempts INTEGER NOT NULL DEFAULT 0,
      webhook_next_retry_at INTEGER NOT NULL DEFAULT 0,
      webhook_last_error TEXT,
      webhook_delivered_at INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER NOT NULL,
      archive_reason TEXT,
      archive_source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_message_job_archives_status_archived
      ON message_job_archives(status, archived_at);
    CREATE INDEX IF NOT EXISTS idx_message_job_archives_session_archived
      ON message_job_archives(session_id, archived_at);
  `);
} catch (error) {
  console.warn('[SessionStore] failed to ensure message_job_archives table:', error?.message || String(error));
}

try {
  db.exec("ALTER TABLE message_job_archives ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text'");
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE message_job_archives ADD COLUMN media_payload_json TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE session_flow_jobs ADD COLUMN error_code TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE session_flow_jobs ADD COLUMN payload_json TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE session_flow_jobs ADD COLUMN webhook_url TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE session_flow_jobs ADD COLUMN webhook_notified INTEGER NOT NULL DEFAULT 0');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE session_flow_jobs ADD COLUMN webhook_attempts INTEGER NOT NULL DEFAULT 0');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE session_flow_jobs ADD COLUMN webhook_next_retry_at INTEGER NOT NULL DEFAULT 0');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE session_flow_jobs ADD COLUMN webhook_last_error TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE session_flow_jobs ADD COLUMN webhook_delivered_at INTEGER');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE session_flow_jobs ADD COLUMN target_session_id TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE session_flow_jobs ADD COLUMN c_user TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec("ALTER TABLE session_flow_jobs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
} catch {
  // Column already exists.
}

try {
  db.exec('ALTER TABLE session_flow_jobs ADD COLUMN coalesce_key TEXT');
} catch {
  // Column already exists.
}

try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_flow_jobs_status_priority_retry
      ON session_flow_jobs(status, priority, next_retry_at, created_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_flow_jobs_coalesce_active
      ON session_flow_jobs(coalesce_key, status, updated_at)
  `);
} catch (error) {
  console.warn('[SessionStore] failed to ensure session_flow_jobs indexes:', error?.message || String(error));
}

function getSessionsTableSql() {
  const stmt = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'sessions'
  `);
  try {
    if (!stmt.step()) return '';
    const row = stmt.getAsObject();
    return String(row?.sql || '');
  } finally {
    stmt.free();
  }
}

function migrateSessionsTableDropCUserUnique() {
  const tableSql = getSessionsTableSql();
  const hasUniqueCUser = /\bc_user\b[\s\S]*\bUNIQUE\b/i.test(tableSql);
  if (!hasUniqueCUser) {
    return;
  }

  db.exec('BEGIN TRANSACTION');
  try {
    db.exec(`
      CREATE TABLE sessions_new (
        session_id TEXT PRIMARY KEY,
        c_user TEXT NOT NULL,
        cookie_format TEXT NOT NULL,
        cookies TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        proxy TEXT,
        twofa_secret TEXT,
        status TEXT,
        restricted INTEGER NOT NULL DEFAULT 0,
        restriction_details_json TEXT,
        restriction_detected_at INTEGER,
        queue_blocked_until INTEGER,
        queue_block_reason TEXT,
        queue_blocked_at INTEGER,
        last_activity INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      );
      INSERT INTO sessions_new (
        session_id, c_user, cookie_format, cookies, fingerprint, proxy, twofa_secret, status,
        restricted, restriction_details_json, restriction_detected_at, queue_blocked_until, queue_block_reason, queue_blocked_at,
        last_activity, created_at, updated_at
      )
      SELECT
        session_id, c_user, cookie_format, cookies, fingerprint, proxy, twofa_secret, status,
        0, NULL, NULL, NULL, NULL, NULL,
        last_activity, created_at, updated_at
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

let persistDirtyVersion = 0;
let persistedVersion = 0;
let persistInFlight = null;
let persistTimer = null;
let lastPersistStartedAt = null;
let lastPersistedAt = null;
let lastPersistError = null;

function exportDbBuffer() {
  const data = db.export();
  return Buffer.from(data);
}

function getTempDbPath() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${DB_PATH}.${suffix}.tmp`;
}

function fsyncParentDirSync(filePath) {
  let dirHandle = null;
  try {
    dirHandle = fs.openSync(path.dirname(filePath), 'r');
    fs.fsyncSync(dirHandle);
  } catch {
    // Best-effort only.
  } finally {
    if (dirHandle != null) {
      try {
        fs.closeSync(dirHandle);
      } catch {
        // ignore close errors
      }
    }
  }
}

function writeBufferAtomicallySync(filePath, buffer) {
  const tempPath = getTempDbPath();
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'w');
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }

  fs.renameSync(tempPath, filePath);
  fsyncParentDirSync(filePath);
}

async function writeBufferAtomically(filePath, buffer) {
  const tempPath = getTempDbPath();
  const handle = await fs.promises.open(tempPath, 'w');
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }

  await fs.promises.rename(tempPath, filePath);

  try {
    const dirHandle = await fs.promises.open(path.dirname(filePath), 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close().catch(() => {});
    }
  } catch {
    // Best-effort only.
  }
}

function clearPersistTimer() {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
}

function persistDbSync() {
  clearPersistTimer();
  lastPersistStartedAt = Date.now();
  writeBufferAtomicallySync(DB_PATH, exportDbBuffer());
  persistedVersion = persistDirtyVersion;
  lastPersistedAt = Date.now();
  lastPersistError = null;
}

async function flushPersistDbAsync() {
  if (persistInFlight) {
    return persistInFlight;
  }
  if (persistedVersion >= persistDirtyVersion) {
    return null;
  }

  const targetVersion = persistDirtyVersion;
  const buffer = exportDbBuffer();
  lastPersistStartedAt = Date.now();
  persistInFlight = writeBufferAtomically(DB_PATH, buffer)
    .then(() => {
      persistedVersion = Math.max(persistedVersion, targetVersion);
      lastPersistedAt = Date.now();
      lastPersistError = null;
    })
    .catch((error) => {
      lastPersistError = error?.message || String(error);
      console.error('[SessionStore] Persist failed:', lastPersistError);
    })
    .finally(() => {
      persistInFlight = null;
      if (persistedVersion < persistDirtyVersion) {
        schedulePersistDbFlush(0);
      }
    });
  return persistInFlight;
}

function schedulePersistDbFlush(delayMs = null) {
  if (persistTimer) return;
  const configuredDelay = Math.max(0, Number(config.storePersistDebounceMs) || 0);
  const waitMs = delayMs == null ? configuredDelay : Math.max(0, Number(delayMs) || 0);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPersistDbAsync().catch((error) => {
      lastPersistError = error?.message || String(error);
      console.error('[SessionStore] Persist flush failed:', lastPersistError);
    });
  }, waitMs);
}

function markDbDirty() {
  persistDirtyVersion += 1;
  if (Number(config.storePersistDebounceMs) <= 0) {
    persistDbSync();
    return;
  }
  schedulePersistDbFlush();
}

migrateSessionsTableDropCUserUnique();
persistDirtyVersion = 1;
persistDbSync();

function serialize(value) {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function deserialize(value) {
  if (value === null || value === undefined) return null;
  return JSON.parse(value);
}

function deserializeSafe(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function serializeCookies(format, raw) {
  if (format === 'json') {
    return JSON.stringify(raw || []);
  }
  return String(raw || '');
}

function deserializeCookies(format, raw) {
  if (format === 'json') {
    return JSON.parse(raw || '[]');
  }
  return raw || '';
}

function normalizeMessageJobPriority(priority, fallback = 'normal') {
  const normalized = String(priority || '').trim().toLowerCase();
  if (normalized === 'high' || normalized === 'low') {
    return normalized;
  }
  return fallback;
}

function normalizeMessageJobType(type) {
  const normalized = String(type || '').trim().toLowerCase();
  return normalized === 'media' ? 'media' : 'text';
}

function messageJobPriorityOrderSql(columnName = 'q.priority') {
  return `CASE ${columnName} WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END`;
}

function normalizeSessionFlowJobPriority(priority, fallback = 'normal') {
  return normalizeMessageJobPriority(priority, fallback);
}

function sessionFlowJobPriorityOrderSql(columnName = 'priority') {
  return `CASE ${columnName} WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END`;
}

function buildExcludedSessionSql(excludedSessionIds = [], params = {}) {
  const normalizedIds = Array.from(new Set(
    Array.isArray(excludedSessionIds)
      ? excludedSessionIds.map((id) => String(id || '').trim()).filter(Boolean)
      : []
  ));
  if (normalizedIds.length <= 0) {
    return '';
  }

  const placeholders = normalizedIds.map((id, index) => {
    const key = `:excluded_session_${index}`;
    params[key] = id;
    return key;
  });
  return `AND q.session_id NOT IN (${placeholders.join(', ')})`;
}

function buildSessionStatusSql(statuses = [], params = {}) {
  const normalizedStatuses = Array.from(new Set(
    Array.isArray(statuses)
      ? statuses.map((status) => String(status || '').trim()).filter(Boolean)
      : []
  ));
  if (normalizedStatuses.length <= 0) {
    return '';
  }

  const placeholders = normalizedStatuses.map((status, index) => {
    const key = `:session_status_${index}`;
    params[key] = status;
    return key;
  });
  return `AND COALESCE(s.status, 'missing') IN (${placeholders.join(', ')})`;
}

function getNextRunnableMessageJobRow(now = Date.now(), preferredSessionId = null, onlyPreferredSession = false, excludedSessionIds = [], options = {}) {
  const preferredSession = preferredSessionId ? String(preferredSessionId) : null;
  const normalizedExcludedSessionIds = Array.isArray(excludedSessionIds)
    ? excludedSessionIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const params = { ':now': now };
  const excludedSessionSql = buildExcludedSessionSql(normalizedExcludedSessionIds, params);
  const sessionStatusSql = buildSessionStatusSql(options?.sessionStatuses, params);
  const queueBlockedSql = "AND (s.queue_blocked_until IS NULL OR s.queue_blocked_until <= :now)";
  if (preferredSession) {
    if (normalizedExcludedSessionIds.includes(preferredSession)) {
      return null;
    }
    const preferredRow = getRow(`
      SELECT q.id
      FROM message_jobs q
      LEFT JOIN sessions s ON s.session_id = q.session_id
      WHERE q.session_id = :session_id
        AND q.status = 'queued'
        AND q.next_retry_at <= :now
        ${excludedSessionSql}
        ${sessionStatusSql}
        ${queueBlockedSql}
        AND NOT EXISTS (
          SELECT 1
          FROM message_jobs p
          WHERE p.session_id = q.session_id
            AND p.status = 'processing'
        )
      ORDER BY ${messageJobPriorityOrderSql('q.priority')} ASC, q.created_at ASC
      LIMIT 1
    `, {
      ...params,
      ':session_id': preferredSession,
    });
    if (preferredRow?.id) {
      return preferredRow;
    }
    if (onlyPreferredSession) {
      return null;
    }
  }

  return getRow(`
    SELECT q.id
    FROM message_jobs q
    LEFT JOIN sessions s ON s.session_id = q.session_id
    WHERE q.status = 'queued'
      AND q.next_retry_at <= :now
      ${excludedSessionSql}
      ${sessionStatusSql}
      ${queueBlockedSql}
      AND NOT EXISTS (
        SELECT 1
        FROM message_jobs p
        WHERE p.session_id = q.session_id
          AND p.status = 'processing'
      )
    ORDER BY
      ${messageJobPriorityOrderSql('q.priority')} ASC,
      CASE COALESCE(s.status, 'missing') WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END ASC,
      q.created_at ASC
    LIMIT 1
  `, params);
}

function getNextRunnableSessionFlowJobRow(now = Date.now()) {
  return getRow(`
    SELECT id
    FROM session_flow_jobs
    WHERE status = 'queued'
      AND next_retry_at <= :now
    ORDER BY
      ${sessionFlowJobPriorityOrderSql('priority')} ASC,
      CASE job_type
        WHEN 'create_session' THEN 0
        WHEN 'validate_cookies' THEN 1
        WHEN 'resume_check' THEN 2
        WHEN 'check_session' THEN 3
        ELSE 4
      END ASC,
      created_at ASC
    LIMIT 1
  `, { ':now': now });
}

function getNextRunnableCreateOperationRow(now = Date.now()) {
  return getRow(`
    SELECT id
    FROM create_operations
    WHERE status = 'queued'
      AND next_retry_at <= :now
    ORDER BY created_at ASC
    LIMIT 1
  `, { ':now': now });
}

function buildMessageJobFilterClause({ sessionId = null, jobIds = [] } = {}) {
  const conditions = [];
  const params = {};

  const normalizedSessionId = String(sessionId || '').trim();
  if (normalizedSessionId) {
    conditions.push('session_id = :filter_session_id');
    params[':filter_session_id'] = normalizedSessionId;
  }

  const normalizedJobIds = Array.isArray(jobIds)
    ? jobIds.map((value) => String(value || '').trim()).filter((value) => value.length > 0)
    : [];
  if (normalizedJobIds.length > 0) {
    const placeholders = normalizedJobIds.map((_, index) => `:filter_job_id_${index}`);
    conditions.push(`id IN (${placeholders.join(', ')})`);
    normalizedJobIds.forEach((value, index) => {
      params[`:filter_job_id_${index}`] = value;
    });
  }

  if (conditions.length === 0) {
    return { clause: null, params: {} };
  }

  return {
    clause: conditions.length === 1 ? conditions[0] : `(${conditions.join(' OR ')})`,
    params,
  };
}

function runStatement(sql, params) {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
  markDbDirty();
}

function runStatementWithChanges(sql, params) {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
  const changes = db.getRowsModified();
  markDbDirty();
  return changes;
}

function getRow(sql, params) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    if (!stmt.step()) {
      return null;
    }
    return stmt.getAsObject();
  } finally {
    stmt.free();
  }
}

function getRows(sql, params) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    cUser: row.c_user,
    cookieFormat: row.cookie_format,
    cookies: deserializeCookies(row.cookie_format, row.cookies),
    fingerprint: deserialize(row.fingerprint) || {},
    proxy: deserialize(row.proxy),
    twofaSecret: row.twofa_secret || null,
    status: row.status,
    restricted: Number(row.restricted || 0) === 1,
    restrictionDetails: deserializeSafe(row.restriction_details_json),
    restrictionDetectedAt: row.restriction_detected_at ? Number(row.restriction_detected_at) : null,
    queueBlockedUntil: row.queue_blocked_until ? Number(row.queue_blocked_until) : null,
    queueBlockReason: row.queue_block_reason || null,
    queueBlockedAt: row.queue_blocked_at ? Number(row.queue_blocked_at) : null,
    lastActivity: row.last_activity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeMessageJobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id || null,
    metaBlastMessageId: row.meta_blast_message_id || null,
    sessionId: row.session_id,
    priority: normalizeMessageJobPriority(row.priority, 'normal'),
    messageType: normalizeMessageJobType(row.message_type),
    extension: row.extension,
    phoneNumber: row.phone_number,
    message: row.message,
    mediaPayload: deserializeSafe(row.media_payload_json),
    useReplyFlow: Number(row.use_reply_flow) === 1,
    includeSuccessScreenshot: Number(row.include_success_screenshot) === 1,
    status: row.status,
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 0),
    errorMessage: row.error_message || null,
    result: deserializeSafe(row.result_json),
    nextRetryAt: Number(row.next_retry_at || 0),
    webhookNotified: Number(row.webhook_notified || 0) === 1,
    webhookAttempts: Number(row.webhook_attempts || 0),
    webhookNextRetryAt: Number(row.webhook_next_retry_at || 0),
    webhookLastError: row.webhook_last_error || null,
    webhookDeliveredAt: row.webhook_delivered_at ? Number(row.webhook_delivered_at) : null,
    startedAt: row.started_at ? Number(row.started_at) : null,
    finishedAt: row.finished_at ? Number(row.finished_at) : null,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

function normalizeArchivedMessageJobRow(row) {
  const normalized = normalizeMessageJobRow(row);
  if (!normalized) return null;

  normalized.status = 'archived';
  normalized.originalStatus = row.original_status || null;
  normalized.archivedAt = row.archived_at ? Number(row.archived_at) : null;
  normalized.archiveReason = row.archive_reason || null;
  normalized.archiveSource = row.archive_source || null;
  return normalized;
}

function normalizeMessageJobSessionRow(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    sessionStatus: row.session_status || null,
    totalJobs: Number(row.total_jobs || 0),
    queuedCount: Number(row.queued_count || 0),
    runnableQueuedCount: Number(row.runnable_queued_count || 0),
    delayedQueuedCount: Number(row.delayed_queued_count || 0),
    processingCount: Number(row.processing_count || 0),
    oldestQueuedCreatedAt: row.oldest_queued_created_at ? Number(row.oldest_queued_created_at) : null,
    oldestRunnableQueuedCreatedAt: row.oldest_runnable_queued_created_at
      ? Number(row.oldest_runnable_queued_created_at)
      : null,
    oldestProcessingUpdatedAt: row.oldest_processing_updated_at
      ? Number(row.oldest_processing_updated_at)
      : null,
    latestUpdatedAt: row.latest_updated_at ? Number(row.latest_updated_at) : null,
  };
}

function normalizeSessionFlowJobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id || null,
    jobType: row.job_type,
    priority: normalizeSessionFlowJobPriority(row.priority),
    coalesceKey: row.coalesce_key || null,
    targetSessionId: row.target_session_id || null,
    cUser: row.c_user || null,
    payload: deserializeSafe(row.payload_json),
    webhookUrl: row.webhook_url || null,
    status: row.status,
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 0),
    errorMessage: row.error_message || null,
    errorCode: row.error_code || null,
    result: deserializeSafe(row.result_json),
    nextRetryAt: Number(row.next_retry_at || 0),
    webhookNotified: Number(row.webhook_notified || 0) === 1,
    webhookAttempts: Number(row.webhook_attempts || 0),
    webhookNextRetryAt: Number(row.webhook_next_retry_at || 0),
    webhookLastError: row.webhook_last_error || null,
    webhookDeliveredAt: row.webhook_delivered_at ? Number(row.webhook_delivered_at) : null,
    startedAt: row.started_at ? Number(row.started_at) : null,
    finishedAt: row.finished_at ? Number(row.finished_at) : null,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

function normalizeCreateOperationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id || null,
    cUser: row.c_user || null,
    payload: deserializeSafe(row.payload_json) || {},
    status: row.status,
    step: row.step || null,
    message: row.message || null,
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 0),
    errorMessage: row.error_message || null,
    errorCode: row.error_code || null,
    result: deserializeSafe(row.result_json),
    debug: deserializeSafe(row.debug_json),
    nextRetryAt: Number(row.next_retry_at || 0),
    startedAt: row.started_at ? Number(row.started_at) : null,
    finishedAt: row.finished_at ? Number(row.finished_at) : null,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

export async function flushSessionStorePersist({ forceSync = false } = {}) {
  clearPersistTimer();

  if (forceSync) {
    if (persistInFlight) {
      await persistInFlight.catch(() => {});
    }
    if (persistedVersion < persistDirtyVersion || lastPersistError) {
      persistDbSync();
    }
    return;
  }

  await flushPersistDbAsync();
  if (persistInFlight) {
    await persistInFlight;
  }
  if (persistedVersion < persistDirtyVersion) {
    persistDbSync();
  }
}

export function getSessionStorePersistStatus(now = Date.now()) {
  return {
    dbPath: DB_PATH,
    dirty: persistedVersion < persistDirtyVersion,
    persistInFlight: !!persistInFlight,
    persistScheduled: !!persistTimer,
    lastPersistStartedAt,
    lastPersistedAt,
    lastPersistAgeMs: lastPersistedAt ? Math.max(0, now - lastPersistedAt) : null,
    lastPersistError,
  };
}

export const sessionStore = {
  listStoredSessionIds() {
    const rows = getRows(`
      SELECT session_id
      FROM sessions
      ORDER BY updated_at DESC, created_at DESC
    `, {});
    return rows
      .map((row) => String(row.session_id || '').trim())
      .filter(Boolean);
  },

  getBySessionId(sessionId) {
    const row = getRow('SELECT * FROM sessions WHERE session_id = :session_id', { ':session_id': sessionId });
    return normalizeRow(row);
  },

  getByCUser(cUser) {
    const row = getRow(`
      SELECT *
      FROM sessions
      WHERE c_user = :c_user
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `, { ':c_user': cUser });
    return normalizeRow(row);
  },

  getFingerprint(cUser) {
    const row = getRow('SELECT * FROM fingerprints WHERE c_user = :c_user', { ':c_user': cUser });
    if (!row || !row.fingerprint) return null;
    return deserialize(row.fingerprint) || null;
  },

  saveFingerprint(cUser, fingerprint) {
    const now = Date.now();
    runStatement(`
      INSERT INTO fingerprints (c_user, fingerprint, updated_at)
      VALUES (:c_user, :fingerprint, :updated_at)
      ON CONFLICT(c_user) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        updated_at = excluded.updated_at
    `, {
      ':c_user': cUser,
      ':fingerprint': serialize(fingerprint || {}),
      ':updated_at': now,
    });
  },

  saveSession({
    sessionId,
    cUser,
    cookieFormat,
    cookies,
    fingerprint,
    proxy,
    twofaSecret,
    status,
    lastActivity,
  }) {
    const now = Date.now();
    runStatement(`
      INSERT INTO sessions (
        session_id, c_user, cookie_format, cookies, fingerprint, proxy, twofa_secret, status, last_activity, created_at, updated_at
      ) VALUES (
        :session_id, :c_user, :cookie_format, :cookies, :fingerprint, :proxy, :twofa_secret, :status, :last_activity, :created_at, :updated_at
      )
      ON CONFLICT(session_id) DO UPDATE SET
        c_user = excluded.c_user,
        cookie_format = excluded.cookie_format,
        cookies = excluded.cookies,
        fingerprint = excluded.fingerprint,
        proxy = excluded.proxy,
        twofa_secret = excluded.twofa_secret,
        status = excluded.status,
        last_activity = excluded.last_activity,
        updated_at = excluded.updated_at
    `, {
      ':session_id': sessionId,
      ':c_user': cUser,
      ':cookie_format': cookieFormat,
      ':cookies': serializeCookies(cookieFormat, cookies),
      ':fingerprint': serialize(fingerprint || {}),
      ':proxy': serialize(proxy || null),
      ':twofa_secret': twofaSecret ? String(twofaSecret) : null,
      ':status': status || 'active',
      ':last_activity': lastActivity || now,
      ':created_at': now,
      ':updated_at': now,
    });
  },

  updateStatus(sessionId, status, lastActivity) {
    const now = Date.now();
    runStatement(`
      UPDATE sessions SET status = :status, last_activity = :last_activity, updated_at = :updated_at
      WHERE session_id = :session_id
    `, {
      ':session_id': sessionId,
      ':status': status,
      ':last_activity': lastActivity || now,
      ':updated_at': now,
    });
  },

  blockQueuedWorkForSession(sessionId, reason = 'unknown', blockedUntil = Date.now()) {
    const now = Date.now();
    runStatement(`
      UPDATE sessions
      SET queue_blocked_until = :queue_blocked_until,
          queue_block_reason = :queue_block_reason,
          queue_blocked_at = :queue_blocked_at,
          updated_at = :updated_at
      WHERE session_id = :session_id
    `, {
      ':session_id': sessionId,
      ':queue_blocked_until': Math.max(now, Number(blockedUntil) || now),
      ':queue_block_reason': String(reason || 'unknown'),
      ':queue_blocked_at': now,
      ':updated_at': now,
    });
  },

  clearQueuedWorkBlock(sessionId) {
    const now = Date.now();
    runStatement(`
      UPDATE sessions
      SET queue_blocked_until = NULL,
          queue_block_reason = NULL,
          queue_blocked_at = NULL,
          updated_at = :updated_at
      WHERE session_id = :session_id
    `, {
      ':session_id': sessionId,
      ':updated_at': now,
    });
  },

  clearExpiredQueuedWorkBlocks(now = Date.now()) {
    const stale = getRow(`
      SELECT COUNT(*) AS count
      FROM sessions
      WHERE queue_blocked_until IS NOT NULL
        AND queue_blocked_until <= :now
    `, { ':now': now });
    if (Number(stale?.count || 0) <= 0) {
      return 0;
    }

    return runStatementWithChanges(`
      UPDATE sessions
      SET queue_blocked_until = NULL,
          queue_block_reason = NULL,
          queue_blocked_at = NULL,
          updated_at = :updated_at
      WHERE queue_blocked_until IS NOT NULL
        AND queue_blocked_until <= :now
    `, {
      ':now': now,
      ':updated_at': now,
    });
  },

  getQueuedWorkBlock(sessionId, now = Date.now()) {
    const row = getRow(`
      SELECT session_id, queue_blocked_until, queue_block_reason, queue_blocked_at
      FROM sessions
      WHERE session_id = :session_id
        AND queue_blocked_until IS NOT NULL
        AND queue_blocked_until > :now
      LIMIT 1
    `, {
      ':session_id': String(sessionId || ''),
      ':now': now,
    });
    if (!row) return null;

    return {
      sessionId: row.session_id,
      reason: row.queue_block_reason || 'unknown',
      blockedAt: row.queue_blocked_at ? Number(row.queue_blocked_at) : null,
      blockedUntil: Number(row.queue_blocked_until || 0),
      remainingMs: Math.max(0, Number(row.queue_blocked_until || 0) - now),
      persisted: true,
    };
  },

  listQueuedWorkBlocks(now = Date.now()) {
    const rows = getRows(`
      SELECT session_id, queue_blocked_until, queue_block_reason, queue_blocked_at
      FROM sessions
      WHERE queue_blocked_until IS NOT NULL
        AND queue_blocked_until > :now
      ORDER BY queue_blocked_until ASC
    `, { ':now': now });
    return rows.map((row) => ({
      sessionId: row.session_id,
      reason: row.queue_block_reason || 'unknown',
      blockedAt: row.queue_blocked_at ? Number(row.queue_blocked_at) : null,
      blockedUntil: Number(row.queue_blocked_until || 0),
      remainingMs: Math.max(0, Number(row.queue_blocked_until || 0) - now),
      persisted: true,
    }));
  },

  markSessionRestricted(sessionId, details, detectedAt = Date.now()) {
    const now = Date.now();
    runStatement(`
      UPDATE sessions
      SET status = 'restricted',
          restricted = 1,
          restriction_details_json = :restriction_details_json,
          restriction_detected_at = :restriction_detected_at,
          last_activity = :last_activity,
          updated_at = :updated_at
      WHERE session_id = :session_id
    `, {
      ':session_id': sessionId,
      ':restriction_details_json': serialize(details || {}),
      ':restriction_detected_at': detectedAt || now,
      ':last_activity': detectedAt || now,
      ':updated_at': now,
    });
  },

  clearSessionRestricted(sessionId) {
    const now = Date.now();
    runStatement(`
      UPDATE sessions
      SET restricted = 0,
          restriction_details_json = NULL,
          restriction_detected_at = NULL,
          updated_at = :updated_at
      WHERE session_id = :session_id
    `, {
      ':session_id': sessionId,
      ':updated_at': now,
    });
  },

  updateCookies(sessionId, cookieFormat, cookies, twofaSecret = undefined) {
    const now = Date.now();
    if (twofaSecret !== undefined) {
      runStatement(`
        UPDATE sessions
        SET cookie_format = :cookie_format, cookies = :cookies, twofa_secret = :twofa_secret, updated_at = :updated_at
        WHERE session_id = :session_id
      `, {
        ':session_id': sessionId,
        ':cookie_format': cookieFormat,
        ':cookies': serializeCookies(cookieFormat, cookies),
        ':twofa_secret': twofaSecret ? String(twofaSecret) : null,
        ':updated_at': now,
      });
      return;
    }

    runStatement(`
      UPDATE sessions SET cookie_format = :cookie_format, cookies = :cookies, updated_at = :updated_at
      WHERE session_id = :session_id
    `, {
      ':session_id': sessionId,
      ':cookie_format': cookieFormat,
      ':cookies': serializeCookies(cookieFormat, cookies),
      ':updated_at': now,
    });
  },

  deleteSession(sessionId) {
    runStatement('DELETE FROM sessions WHERE session_id = :session_id', { ':session_id': sessionId });
  },

  enqueueMessageJob({
    id,
    requestId = null,
    metaBlastMessageId = null,
    sessionId,
    priority = 'normal',
    messageType = 'text',
    extension,
    phoneNumber,
    message,
    mediaPayload = null,
    useReplyFlow = false,
    includeSuccessScreenshot = false,
    maxAttempts = 5,
  }) {
    const now = Date.now();
    const normalizedType = normalizeMessageJobType(messageType);
    runStatement(`
      INSERT INTO message_jobs (
        id, request_id, meta_blast_message_id, session_id, priority, message_type, extension, phone_number, message, media_payload_json,
        use_reply_flow, include_success_screenshot, status, attempts, max_attempts,
        next_retry_at, webhook_notified, webhook_attempts, webhook_next_retry_at,
        created_at, updated_at
      ) VALUES (
        :id, :request_id, :meta_blast_message_id, :session_id, :priority, :message_type, :extension, :phone_number, :message, :media_payload_json,
        :use_reply_flow, :include_success_screenshot, 'queued', 0, :max_attempts,
        0, 0, 0, 0, :created_at, :updated_at
      )
    `, {
      ':id': id,
      ':request_id': requestId || null,
      ':meta_blast_message_id': metaBlastMessageId || null,
      ':session_id': sessionId,
      ':priority': normalizeMessageJobPriority(priority, useReplyFlow ? 'high' : 'normal'),
      ':message_type': normalizedType,
      ':extension': extension,
      ':phone_number': phoneNumber,
      ':message': message,
      ':media_payload_json': normalizedType === 'media' ? serialize(mediaPayload || {}) : null,
      ':use_reply_flow': useReplyFlow ? 1 : 0,
      ':include_success_screenshot': includeSuccessScreenshot ? 1 : 0,
      ':max_attempts': maxAttempts,
      ':created_at': now,
      ':updated_at': now,
    });
    return this.getMessageJob(id);
  },

  getMessageJob(jobId) {
    const row = getRow('SELECT * FROM message_jobs WHERE id = :id', { ':id': jobId });
    if (row) return normalizeMessageJobRow(row);

    const archivedRow = getRow('SELECT * FROM message_job_archives WHERE id = :id', { ':id': jobId });
    return normalizeArchivedMessageJobRow(archivedRow);
  },

  getMessageJobByRequestId(requestId) {
    if (!requestId) return null;
    const row = getRow(`
      SELECT *
      FROM message_jobs
      WHERE request_id = :request_id
      ORDER BY created_at DESC
      LIMIT 1
    `, { ':request_id': requestId });
    return normalizeMessageJobRow(row);
  },

  hasRunnableMessageJob(now = Date.now(), preferredSessionId = null, onlyPreferredSession = false, excludedSessionIds = [], options = {}) {
    const row = getNextRunnableMessageJobRow(now, preferredSessionId, onlyPreferredSession, excludedSessionIds, options);
    return !!row;
  },

  claimNextMessageJob(now = Date.now(), preferredSessionId = null, onlyPreferredSession = false, excludedSessionIds = [], options = {}) {
    const row = getNextRunnableMessageJobRow(now, preferredSessionId, onlyPreferredSession, excludedSessionIds, options);
    if (!row || !row.id) return null;

    const changes = runStatementWithChanges(`
      UPDATE message_jobs
      SET status = 'processing',
          attempts = attempts + 1,
          started_at = COALESCE(started_at, :now),
          updated_at = :now
      WHERE id = :id AND status = 'queued' AND next_retry_at <= :now
    `, {
      ':id': row.id,
      ':now': now,
    });
    if (changes <= 0) return null;
    return this.getMessageJob(row.id);
  },

  hasQueuedMessageJobForSession(sessionId, now = Date.now()) {
    if (!sessionId) return false;
    const row = getRow(`
      SELECT id
      FROM message_jobs
      WHERE session_id = :session_id
        AND status = 'queued'
        AND next_retry_at <= :now
      ORDER BY created_at ASC
      LIMIT 1
    `, {
      ':session_id': String(sessionId),
      ':now': now,
    });
    return !!row;
  },

  hasQueuedSessionFlowJobForSession(sessionId, now = Date.now()) {
    if (!sessionId) return false;
    const row = getRow(`
      SELECT id
      FROM session_flow_jobs
      WHERE target_session_id = :session_id
        AND status = 'queued'
        AND next_retry_at <= :now
      ORDER BY created_at ASC
      LIMIT 1
    `, {
      ':session_id': String(sessionId),
      ':now': now,
    });
    return !!row;
  },

  markMessageJobSent(jobId, result) {
    const now = Date.now();
    runStatement(`
      UPDATE message_jobs
      SET status = 'sent',
          error_message = NULL,
          result_json = :result_json,
          webhook_notified = 0,
          webhook_attempts = 0,
          webhook_next_retry_at = 0,
          webhook_last_error = NULL,
          webhook_delivered_at = NULL,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE id = :id
        AND status = 'processing'
    `, {
      ':id': jobId,
      ':result_json': serialize(result || {}),
      ':finished_at': now,
      ':updated_at': now,
    });
    return this.getMessageJob(jobId);
  },

  markMessageJobRetry(jobId, errorMessage, nextRetryAt) {
    const now = Date.now();
    runStatement(`
      UPDATE message_jobs
      SET status = 'queued',
          error_message = :error_message,
          next_retry_at = :next_retry_at,
          updated_at = :updated_at
      WHERE id = :id
        AND status = 'processing'
    `, {
      ':id': jobId,
      ':error_message': errorMessage || null,
      ':next_retry_at': nextRetryAt || now,
      ':updated_at': now,
    });
    return this.getMessageJob(jobId);
  },

  markMessageJobError(jobId, errorMessage, result = null) {
    const now = Date.now();
    runStatement(`
      UPDATE message_jobs
      SET status = 'error',
          error_message = :error_message,
          result_json = :result_json,
          webhook_notified = 0,
          webhook_attempts = 0,
          webhook_next_retry_at = 0,
          webhook_last_error = NULL,
          webhook_delivered_at = NULL,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE id = :id
        AND status = 'processing'
    `, {
      ':id': jobId,
      ':error_message': errorMessage || null,
      ':result_json': serialize(result),
      ':finished_at': now,
      ':updated_at': now,
    });
    return this.getMessageJob(jobId);
  },

  markQueuedMessageJobsForManagerReroute(
    sessionId,
    errorMessage,
    result = null,
    {
      now = Date.now(),
      onlyRunnable = true,
      statusFilter = ['suspended', 'missing', 'restricted', 'needs_manual_action'],
    } = {}
  ) {
    if (!sessionId) return 0;

    const safeNow = Math.max(0, Number(now) || Date.now());
    const statuses = Array.isArray(statusFilter) ? statusFilter.map((status) => String(status || '').trim()).filter(Boolean) : [];
    const statusPlaceholders = statuses.map((_, index) => `:status_${index}`);
    const statusParams = statuses.reduce((memo, status, index) => {
      memo[`:status_${index}`] = status;
      return memo;
    }, {});
    const statusClause = statusPlaceholders.length > 0
      ? `AND COALESCE(s.status, 'missing') IN (${statusPlaceholders.join(', ')})`
      : '';
    const runnableClause = onlyRunnable ? 'AND q.next_retry_at <= :now' : '';

    return runStatementWithChanges(`
      UPDATE message_jobs
      SET status = 'error',
          error_message = :error_message,
          result_json = :result_json,
          webhook_notified = 0,
          webhook_attempts = 0,
          webhook_next_retry_at = 0,
          webhook_last_error = NULL,
          webhook_delivered_at = NULL,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE id IN (
        SELECT q.id
        FROM message_jobs q
        LEFT JOIN sessions s ON s.session_id = q.session_id
        WHERE q.session_id = :session_id
          AND q.status = 'queued'
          AND COALESCE(TRIM(q.meta_blast_message_id), '') <> ''
          ${runnableClause}
          ${statusClause}
      )
    `, {
      ...statusParams,
      ':session_id': String(sessionId),
      ':error_message': errorMessage || null,
      ':result_json': serialize(result),
      ':now': safeNow,
      ':finished_at': safeNow,
      ':updated_at': safeNow,
    });
  },

  failQueuedMessageJobsForSession(sessionId, errorMessage, result = null, { suppressWebhook = true } = {}) {
    if (!sessionId) return 0;

    const now = Date.now();
    return runStatementWithChanges(`
      UPDATE message_jobs
      SET status = 'error',
          error_message = :error_message,
          result_json = :result_json,
          webhook_notified = :webhook_notified,
          webhook_attempts = 0,
          webhook_next_retry_at = 0,
          webhook_last_error = NULL,
          webhook_delivered_at = CASE WHEN :webhook_notified = 1 THEN :finished_at ELSE NULL END,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE session_id = :session_id
        AND status = 'queued'
    `, {
      ':session_id': String(sessionId),
      ':error_message': errorMessage || null,
      ':result_json': serialize(result),
      ':webhook_notified': suppressWebhook ? 1 : 0,
      ':finished_at': now,
      ':updated_at': now,
    });
  },

  deferQueuedMessageJobsForBackpressure({
    now = Date.now(),
    delayMs = 600000,
    suspendedQueuedAgeMs = 300000,
    maxRunnableQueuedPerSession = 250,
    globalQueuedThreshold = 25000,
    maxRunnableSessions = 40,
    maxSessions = 25,
  } = {}) {
    const safeNow = Math.max(0, Number(now) || Date.now());
    const safeDelayMs = Math.max(1000, Number(delayMs) || 600000);
    const safeSuspendedAgeMs = Math.max(1000, Number(suspendedQueuedAgeMs) || 300000);
    const safeMaxRunnable = Math.max(1, Number(maxRunnableQueuedPerSession) || 250);
    const safeGlobalQueuedThreshold = Math.max(1, Number(globalQueuedThreshold) || 25000);
    const safeMaxRunnableSessions = Math.max(1, Number(maxRunnableSessions) || 40);
    const safeMaxSessions = Math.max(1, Number(maxSessions) || 25);
    const deferUntil = safeNow + safeDelayMs;
    const rows = getRows(`
      SELECT
        q.session_id,
        COALESCE(s.status, 'missing') AS session_status,
        COUNT(*) AS runnable_count,
        MIN(q.created_at) AS oldest_created_at
      FROM message_jobs q
      LEFT JOIN sessions s ON s.session_id = q.session_id
      WHERE q.status = 'queued'
        AND q.next_retry_at <= :now
      GROUP BY q.session_id
      HAVING
        COALESCE(s.status, 'missing') IN ('restricted', 'needs_manual_action', 'missing')
        OR (
          COALESCE(s.status, 'missing') = 'suspended'
          AND MIN(q.created_at) <= :suspended_cutoff
        )
        OR COUNT(*) > :max_runnable
      ORDER BY
        CASE COALESCE(s.status, 'missing')
          WHEN 'restricted' THEN 0
          WHEN 'needs_manual_action' THEN 1
          WHEN 'missing' THEN 2
          WHEN 'suspended' THEN 3
          ELSE 4
        END ASC,
        COUNT(*) DESC,
        MIN(q.created_at) ASC
      LIMIT :limit
    `, {
      ':now': safeNow,
      ':suspended_cutoff': safeNow - safeSuspendedAgeMs,
      ':max_runnable': safeMaxRunnable,
      ':limit': safeMaxSessions,
    });

    let deferredJobs = 0;
    const sessions = [];
    let globalDeferredJobs = 0;
    let globalDeferredSessions = 0;
    let reroutedJobs = 0;
    let reroutedSessions = 0;
    rows.forEach((row) => {
      const sessionId = String(row.session_id || '').trim();
      if (!sessionId) return;

      const status = String(row.session_status || 'missing');
      const runnableCount = Number(row.runnable_count || 0);
      const unhealthy = ['restricted', 'needs_manual_action', 'missing', 'suspended'].includes(status);
      const reason = unhealthy ? `backpressure:${status}` : 'backpressure:per_session_cap';
      let rerouted = 0;
      let changes = 0;

      if (unhealthy) {
        rerouted = this.markQueuedMessageJobsForManagerReroute(
          sessionId,
          `MetaBiz session ${status}; requeueing to manager for a healthy replacement.`,
          {
            error: `MetaBiz session ${status}; requeueing to manager for a healthy replacement.`,
            errorCode: 'session_backpressure_reroute',
            details: {
              reason,
              sessionId,
              sessionStatus: status,
              source: 'message_queue_backpressure_sweep',
            },
          },
          {
            now: safeNow,
            onlyRunnable: false,
            statusFilter: [status],
          }
        );
        changes = runStatementWithChanges(`
          UPDATE message_jobs
          SET next_retry_at = :defer_until,
              error_message = :reason,
              updated_at = :updated_at
          WHERE session_id = :session_id
            AND status = 'queued'
            AND next_retry_at <= :now
        `, {
          ':session_id': sessionId,
          ':defer_until': deferUntil,
          ':reason': reason,
          ':updated_at': safeNow,
          ':now': safeNow,
        });
        if (changes > 0) {
          this.blockQueuedWorkForSession(sessionId, reason, deferUntil);
        }
      } else if (runnableCount > safeMaxRunnable) {
        changes = runStatementWithChanges(`
          UPDATE message_jobs
          SET next_retry_at = :defer_until,
              error_message = :reason,
              updated_at = :updated_at
          WHERE id IN (
            SELECT id
            FROM message_jobs
            WHERE session_id = :session_id
              AND status = 'queued'
              AND next_retry_at <= :now
            ORDER BY ${messageJobPriorityOrderSql('priority')} ASC, created_at ASC
            LIMIT -1 OFFSET :keep_count
          )
        `, {
          ':session_id': sessionId,
          ':defer_until': deferUntil,
          ':reason': reason,
          ':updated_at': safeNow,
          ':now': safeNow,
          ':keep_count': safeMaxRunnable,
        });
      }

      if (rerouted > 0) {
        reroutedJobs += rerouted;
        reroutedSessions += 1;
      }
      if (changes > 0) {
        deferredJobs += changes;
        sessions.push({
          sessionId,
          status,
          runnableCount,
          deferredJobs: changes,
          reroutedJobs: rerouted,
          reason,
          deferUntil,
        });
      } else if (rerouted > 0) {
        sessions.push({
          sessionId,
          status,
          runnableCount,
          deferredJobs: 0,
          reroutedJobs: rerouted,
          reason: 'manager_reroute',
          deferUntil: null,
        });
      }
    });

    const queueTotals = getRow(`
      SELECT
        COUNT(*) AS queued_count,
        COUNT(DISTINCT CASE WHEN next_retry_at <= :now THEN session_id END) AS runnable_session_count
      FROM message_jobs
      WHERE status = 'queued'
    `, { ':now': safeNow }) || {};
    const queuedCount = Number(queueTotals.queued_count || 0);
    const runnableSessionCount = Number(queueTotals.runnable_session_count || 0);

    if (queuedCount >= safeGlobalQueuedThreshold && runnableSessionCount > safeMaxRunnableSessions) {
      const extraRows = getRows(`
        SELECT
          q.session_id,
          COALESCE(s.status, 'missing') AS session_status,
          COUNT(*) AS runnable_count,
          MIN(q.created_at) AS oldest_created_at
        FROM message_jobs q
        LEFT JOIN sessions s ON s.session_id = q.session_id
        WHERE q.status = 'queued'
          AND q.next_retry_at <= :now
        GROUP BY q.session_id
        ORDER BY
          CASE COALESCE(s.status, 'missing')
            WHEN 'active' THEN 0
            WHEN 'suspended' THEN 1
            WHEN 'restricted' THEN 2
            WHEN 'needs_manual_action' THEN 3
            WHEN 'missing' THEN 4
            ELSE 5
          END ASC,
          COUNT(*) DESC,
          MIN(q.created_at) ASC,
          q.session_id ASC
        LIMIT -1 OFFSET :keep_count
      `, {
        ':now': safeNow,
        ':keep_count': safeMaxRunnableSessions,
      });

      extraRows.slice(0, safeMaxSessions).forEach((row) => {
        const sessionId = String(row.session_id || '').trim();
        if (!sessionId) return;

        const reason = 'backpressure:global_session_cap';
        const changes = runStatementWithChanges(`
          UPDATE message_jobs
          SET next_retry_at = :defer_until,
              error_message = :reason,
              updated_at = :updated_at
          WHERE session_id = :session_id
            AND status = 'queued'
            AND next_retry_at <= :now
        `, {
          ':session_id': sessionId,
          ':defer_until': deferUntil,
          ':reason': reason,
          ':updated_at': safeNow,
          ':now': safeNow,
        });
        if (changes <= 0) return;

        globalDeferredJobs += changes;
        globalDeferredSessions += 1;
        deferredJobs += changes;
        sessions.push({
          sessionId,
          status: String(row.session_status || 'missing'),
          runnableCount: Number(row.runnable_count || 0),
          deferredJobs: changes,
          reason,
          deferUntil,
        });
      });
    }

    return {
      checkedSessions: rows.length,
      deferredSessions: sessions.length,
      deferredJobs,
      reroutedJobs,
      reroutedSessions,
      globalQueuedCount: queuedCount,
      globalRunnableSessionCount: runnableSessionCount,
      globalMaxRunnableSessions: safeMaxRunnableSessions,
      globalDeferredSessions,
      globalDeferredJobs,
      sessions,
    };
  },

  archiveDelayedMessageJobsForBackpressure({
    now = Date.now(),
    queuedThreshold = 10000,
    terminalThreshold = 1000,
    minAgeMs = 300000,
    maxJobs = 10000,
    maxSessions = 150,
    source = 'backpressure_delayed_archive',
  } = {}) {
    const safeNow = Math.max(0, Number(now) || Date.now());
    const safeQueuedThreshold = Math.max(1, Number(queuedThreshold) || 10000);
    const safeTerminalThreshold = Math.max(1, Number(terminalThreshold) || 1000);
    const safeMinAgeMs = Math.max(1000, Number(minAgeMs) || 300000);
    const safeMaxJobs = Math.max(1, Number(maxJobs) || 10000);
    const safeMaxSessions = Math.max(1, Number(maxSessions) || 150);
    const cutoff = safeNow - safeMinAgeMs;
    const totals = getRow(`
      SELECT COUNT(*) AS queued_count
      FROM message_jobs
      WHERE status = 'queued'
    `, {}) || {};
    const queuedCount = Number(totals.queued_count || 0);
    const terminalTotals = getRow(`
      SELECT COUNT(*) AS terminal_delayed_count
      FROM message_jobs q
      LEFT JOIN sessions s ON s.session_id = q.session_id
      WHERE q.status = 'queued'
        AND q.next_retry_at > :now
        AND q.created_at <= :cutoff
        AND COALESCE(s.status, 'missing') IN ('restricted', 'needs_manual_action', 'missing', 'suspended')
    `, {
      ':now': safeNow,
      ':cutoff': cutoff,
    }) || {};
    const terminalDelayedCount = Number(terminalTotals.terminal_delayed_count || 0);
    if (queuedCount < safeQueuedThreshold && terminalDelayedCount < safeTerminalThreshold) {
      return {
        archivedJobs: 0,
        archivedSessions: 0,
        checkedSessions: 0,
        queuedCount,
        terminalDelayedCount,
        threshold: safeQueuedThreshold,
        terminalThreshold: safeTerminalThreshold,
        reason: 'below_threshold',
      };
    }

    const sessionRows = getRows(`
      SELECT
        q.session_id,
        COALESCE(s.status, 'missing') AS session_status,
        COUNT(*) AS delayed_count,
        MIN(q.created_at) AS oldest_created_at
      FROM message_jobs q
      LEFT JOIN sessions s ON s.session_id = q.session_id
      WHERE q.status = 'queued'
        AND q.next_retry_at > :now
        AND q.created_at <= :cutoff
      GROUP BY q.session_id
      HAVING COALESCE(s.status, 'missing') IN ('restricted', 'needs_manual_action', 'missing', 'suspended')
      ORDER BY
        CASE COALESCE(s.status, 'missing')
          WHEN 'missing' THEN 0
          WHEN 'restricted' THEN 1
          WHEN 'needs_manual_action' THEN 2
          WHEN 'suspended' THEN 3
          ELSE 4
        END ASC,
        COUNT(*) DESC,
        MIN(q.created_at) ASC
      LIMIT :limit
    `, {
      ':now': safeNow,
      ':cutoff': cutoff,
      ':limit': safeMaxSessions,
    });

    let archivedJobs = 0;
    let archivedSessions = 0;
    const sessions = [];
    for (const row of sessionRows) {
      if (archivedJobs >= safeMaxJobs) break;

      const sessionId = String(row.session_id || '').trim();
      if (!sessionId) continue;

      const remaining = safeMaxJobs - archivedJobs;
      const reason = `archive:${String(row.session_status || 'missing')}`;
      const archiveRows = getRows(`
        SELECT id
        FROM message_jobs
        WHERE session_id = :session_id
          AND status = 'queued'
          AND next_retry_at > :now
          AND created_at <= :cutoff
        ORDER BY created_at ASC
        LIMIT :limit
      `, {
        ':session_id': sessionId,
        ':now': safeNow,
        ':cutoff': cutoff,
        ':limit': remaining,
      });
      const ids = archiveRows.map((item) => String(item.id || '').trim()).filter(Boolean);
      if (ids.length === 0) continue;

      const placeholders = ids.map((_, index) => `:archive_job_id_${index}`);
      const params = {
        ':archived_at': safeNow,
        ':archive_reason': reason,
        ':archive_source': String(source || 'backpressure_delayed_archive'),
      };
      ids.forEach((id, index) => {
        params[`:archive_job_id_${index}`] = id;
      });

      runStatement(`
        INSERT OR REPLACE INTO message_job_archives (
          id, request_id, meta_blast_message_id, session_id, priority, message_type, extension, phone_number, message, media_payload_json,
          use_reply_flow, include_success_screenshot, status, original_status, attempts, max_attempts,
          error_message, result_json, next_retry_at, webhook_notified, webhook_attempts,
          webhook_next_retry_at, webhook_last_error, webhook_delivered_at, started_at, finished_at,
          created_at, updated_at, archived_at, archive_reason, archive_source
        )
        SELECT
          id, request_id, meta_blast_message_id, session_id, priority, message_type, extension, phone_number, message, media_payload_json,
          use_reply_flow, include_success_screenshot, 'archived', status, attempts, max_attempts,
          error_message, result_json, next_retry_at, 1, webhook_attempts,
          0, webhook_last_error, webhook_delivered_at, started_at, finished_at,
          created_at, :archived_at, :archived_at, :archive_reason, :archive_source
        FROM message_jobs
        WHERE id IN (${placeholders.join(', ')})
      `, params);
      const deleted = runStatementWithChanges(`
        DELETE FROM message_jobs
        WHERE id IN (${placeholders.join(', ')})
      `, params);
      if (deleted <= 0) continue;

      archivedJobs += deleted;
      archivedSessions += 1;
      sessions.push({
        sessionId,
        status: String(row.session_status || 'missing'),
        archivedJobs: deleted,
        reason,
      });
    }

    return {
      archivedJobs,
      archivedSessions,
      checkedSessions: sessionRows.length,
      queuedCount,
      terminalDelayedCount,
      threshold: safeQueuedThreshold,
      terminalThreshold: safeTerminalThreshold,
      sessions,
    };
  },

  failMessageJobsForSession(sessionId, errorMessage, result = null, { suppressWebhook = true } = {}) {
    if (!sessionId) return 0;

    const now = Date.now();
    return runStatementWithChanges(`
      UPDATE message_jobs
      SET status = 'error',
          error_message = :error_message,
          result_json = :result_json,
          webhook_notified = :webhook_notified,
          webhook_attempts = 0,
          webhook_next_retry_at = 0,
          webhook_last_error = NULL,
          webhook_delivered_at = CASE WHEN :webhook_notified = 1 THEN :finished_at ELSE NULL END,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE session_id = :session_id
        AND status IN ('queued', 'processing')
    `, {
      ':session_id': String(sessionId),
      ':error_message': errorMessage || null,
      ':result_json': serialize(result),
      ':webhook_notified': suppressWebhook ? 1 : 0,
      ':finished_at': now,
      ':updated_at': now,
    });
  },

  failQueuedSessionFlowJobsForSession(sessionId, errorMessage, errorCode = null, result = null, { suppressWebhook = true } = {}) {
    if (!sessionId) return 0;

    const now = Date.now();
    return runStatementWithChanges(`
      UPDATE session_flow_jobs
      SET status = 'error',
          error_message = :error_message,
          error_code = :error_code,
          result_json = :result_json,
          webhook_notified = :webhook_notified,
          webhook_attempts = 0,
          webhook_next_retry_at = 0,
          webhook_last_error = NULL,
          webhook_delivered_at = CASE WHEN :webhook_notified = 1 THEN :finished_at ELSE NULL END,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE target_session_id = :session_id
        AND status = 'queued'
    `, {
      ':session_id': String(sessionId),
      ':error_message': errorMessage || null,
      ':error_code': errorCode || null,
      ':result_json': serialize(result),
      ':webhook_notified': suppressWebhook ? 1 : 0,
      ':finished_at': now,
      ':updated_at': now,
    });
  },

  failSessionFlowJobsForSession(sessionId, errorMessage, errorCode = null, result = null, { suppressWebhook = true } = {}) {
    if (!sessionId) return 0;

    const now = Date.now();
    return runStatementWithChanges(`
      UPDATE session_flow_jobs
      SET status = 'error',
          error_message = :error_message,
          error_code = :error_code,
          result_json = :result_json,
          webhook_notified = :webhook_notified,
          webhook_attempts = 0,
          webhook_next_retry_at = 0,
          webhook_last_error = NULL,
          webhook_delivered_at = CASE WHEN :webhook_notified = 1 THEN :finished_at ELSE NULL END,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE target_session_id = :session_id
        AND status IN ('queued', 'processing')
    `, {
      ':session_id': String(sessionId),
      ':error_message': errorMessage || null,
      ':error_code': errorCode || null,
      ':result_json': serialize(result),
      ':webhook_notified': suppressWebhook ? 1 : 0,
      ':finished_at': now,
      ':updated_at': now,
    });
  },

  summarizeMessageJobs({ sessionId = null, jobIds = [] } = {}) {
    const filter = buildMessageJobFilterClause({ sessionId, jobIds });
    if (!filter.clause) {
      return { matched: 0, queued: 0, processing: 0 };
    }

    const rows = getRows(`
      SELECT status, COUNT(*) AS count
      FROM message_jobs
      WHERE ${filter.clause}
        AND status IN ('queued', 'processing')
      GROUP BY status
    `, filter.params);

    return rows.reduce((memo, row) => {
      const count = Number(row.count || 0);
      const status = String(row.status || '').trim().toLowerCase();
      memo.matched += count;
      if (status === 'queued') memo.queued += count;
      if (status === 'processing') memo.processing += count;
      return memo;
    }, { matched: 0, queued: 0, processing: 0 });
  },

  cancelQueuedMessageJobs({ sessionId = null, jobIds = [], errorMessage = 'canceled', result = null, suppressWebhook = true } = {}) {
    const filter = buildMessageJobFilterClause({ sessionId, jobIds });
    if (!filter.clause) return 0;

    const now = Date.now();
    return runStatementWithChanges(`
      UPDATE message_jobs
      SET status = 'error',
          error_message = :error_message,
          result_json = :result_json,
          webhook_notified = :webhook_notified,
          webhook_attempts = 0,
          webhook_next_retry_at = 0,
          webhook_last_error = NULL,
          webhook_delivered_at = CASE WHEN :webhook_notified = 1 THEN :finished_at ELSE NULL END,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE ${filter.clause}
        AND status = 'queued'
    `, {
      ...filter.params,
      ':error_message': errorMessage || null,
      ':result_json': serialize(result),
      ':webhook_notified': suppressWebhook ? 1 : 0,
      ':finished_at': now,
      ':updated_at': now,
    });
  },

  requeueStaleProcessingMessageJobs(timeoutMs = 180000) {
    const now = Date.now();
    const threshold = now - Math.max(1000, Number(timeoutMs) || 180000);
    runStatement(`
      UPDATE message_jobs
      SET status = 'queued',
          next_retry_at = :now,
          updated_at = :now
      WHERE status = 'processing' AND updated_at < :threshold
    `, {
      ':now': now,
      ':threshold': threshold,
    });
  },

  listMessageJobsByStatus(status, limit = 100) {
    const maxRows = Math.max(1, Number(limit) || 100);
    const rows = getRows(`
      SELECT *
      FROM message_jobs
      WHERE status = :status
      ORDER BY created_at DESC
      LIMIT :limit
    `, {
      ':status': status,
      ':limit': maxRows,
    });
    return rows.map(normalizeMessageJobRow);
  },

  messageJobStatusCounts() {
    const rows = getRows(`
      SELECT status, COUNT(*) AS count
      FROM message_jobs
      GROUP BY status
    `, {});

    const counts = rows.reduce((memo, row) => {
      const status = String(row.status || "").trim().toLowerCase();
      if (!status) return memo;
      memo[status] = Number(row.count || 0);
      return memo;
    }, {});
    const archived = getRow(`
      SELECT COUNT(*) AS count
      FROM message_job_archives
      WHERE status = 'archived'
    `, {}) || {};
    counts.archived = Number(archived.count || 0);
    return counts;
  },

  sessionFlowJobStatusCounts(now = Date.now()) {
    const countsRows = getRows(`
      SELECT status, COUNT(*) AS count
      FROM session_flow_jobs
      GROUP BY status
    `, {});
    const counts = countsRows.reduce((memo, row) => {
      const status = String(row.status || '').trim().toLowerCase();
      if (!status) return memo;
      memo[status] = Number(row.count || 0);
      return memo;
    }, {});

    const runnable = getRow(`
      SELECT COUNT(*) AS count, MIN(created_at) AS oldest_created_at
      FROM session_flow_jobs
      WHERE status = 'queued'
        AND next_retry_at <= :now
    `, { ':now': now }) || {};
    const processing = getRow(`
      SELECT COUNT(*) AS count, MIN(updated_at) AS oldest_updated_at
      FROM session_flow_jobs
      WHERE status = 'processing'
    `, {}) || {};
    const priorityRows = getRows(`
      SELECT COALESCE(priority, 'normal') AS priority, status, COUNT(*) AS count
      FROM session_flow_jobs
      WHERE status IN ('queued', 'processing')
      GROUP BY COALESCE(priority, 'normal'), status
    `, {});
    const priorityCounts = priorityRows.reduce((memo, row) => {
      const priority = String(row.priority || 'normal').trim().toLowerCase() || 'normal';
      const status = String(row.status || '').trim().toLowerCase();
      if (!status) return memo;
      memo[priority] = memo[priority] || {};
      memo[priority][status] = Number(row.count || 0);
      return memo;
    }, {});
    const oldestQueuedCreatedAt = Number(runnable.oldest_created_at || 0) || null;
    const oldestProcessingUpdatedAt = Number(processing.oldest_updated_at || 0) || null;

    return {
      ...counts,
      priorityCounts,
      runnable: Number(runnable.count || 0),
      processing: Number(processing.count || counts.processing || 0),
      oldestRunnableAgeMs: oldestQueuedCreatedAt ? Math.max(0, now - oldestQueuedCreatedAt) : null,
      oldestProcessingAgeMs: oldestProcessingUpdatedAt ? Math.max(0, now - oldestProcessingUpdatedAt) : null,
    };
  },

  reconcileInvalidSessionFlowJobs({
    now = Date.now(),
    defaultValidateTimeoutMs = null,
    defaultTwofaInputTimeoutMs = null,
  } = {}) {
    const pendingRows = getRows(`
      SELECT id, payload_json
      FROM session_flow_jobs
      WHERE job_type = 'update_session_cookies'
        AND target_session_id = 'pending'
        AND status IN ('queued', 'processing')
    `, {});
    let convertedPendingTarget = 0;
    let skippedPendingTarget = 0;
    pendingRows.forEach((row) => {
      const payload = deserializeSafe(row.payload_json) || {};
      if (!payload.cookies) {
        skippedPendingTarget += 1;
        return;
      }
      payload.persist = true;
      payload.checkAfterSuccess = true;
      payload.freshBrowser = payload.freshBrowser === true;
      if (defaultValidateTimeoutMs && !payload.validateTimeoutMs) {
        payload.validateTimeoutMs = defaultValidateTimeoutMs;
      }
      if (defaultTwofaInputTimeoutMs && !payload.twofaInputTimeoutMs) {
        payload.twofaInputTimeoutMs = defaultTwofaInputTimeoutMs;
      }
      runStatement(`
        UPDATE session_flow_jobs
        SET job_type = 'validate_cookies',
            priority = 'low',
            target_session_id = NULL,
            status = 'queued',
            attempts = 0,
            payload_json = :payload_json,
            error_message = NULL,
            error_code = NULL,
            result_json = NULL,
            next_retry_at = :now,
            started_at = NULL,
            finished_at = NULL,
            updated_at = :now
        WHERE id = :id
      `, {
        ':id': row.id,
        ':payload_json': serialize(payload),
        ':now': now,
      });
      convertedPendingTarget += 1;
    });

    return {
      convertedPendingTarget,
      skippedPendingTarget,
    };
  },

  listQueuedMessageJobs(limit = 100) {
    const maxRows = Math.max(1, Number(limit) || 100);
    const rows = getRows(`
      SELECT *
      FROM message_jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT :limit
    `, {
      ':limit': maxRows,
    });
    return rows.map(normalizeMessageJobRow);
  },

  listProcessingMessageJobs(limit = 100) {
    const maxRows = Math.max(1, Number(limit) || 100);
    const rows = getRows(`
      SELECT *
      FROM message_jobs
      WHERE status = 'processing'
      ORDER BY updated_at ASC
      LIMIT :limit
    `, {
      ':limit': maxRows,
    });
    return rows.map(normalizeMessageJobRow);
  },

  listMessageJobSessions(limit = 100, now = Date.now()) {
    const maxRows = Math.max(1, Number(limit) || 100);
    const rows = getRows(`
      SELECT
        q.session_id,
        COALESCE(s.status, 'missing') AS session_status,
        COUNT(*) AS total_jobs,
        SUM(CASE WHEN q.status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
        SUM(CASE WHEN q.status = 'queued' AND q.next_retry_at <= :now THEN 1 ELSE 0 END) AS runnable_queued_count,
        SUM(CASE WHEN q.status = 'queued' AND q.next_retry_at > :now THEN 1 ELSE 0 END) AS delayed_queued_count,
        SUM(CASE WHEN q.status = 'processing' THEN 1 ELSE 0 END) AS processing_count,
        MIN(CASE WHEN q.status = 'queued' THEN q.created_at END) AS oldest_queued_created_at,
        MIN(CASE WHEN q.status = 'queued' AND q.next_retry_at <= :now THEN q.created_at END) AS oldest_runnable_queued_created_at,
        MIN(CASE WHEN q.status = 'processing' THEN q.updated_at END) AS oldest_processing_updated_at,
        MAX(q.updated_at) AS latest_updated_at
      FROM message_jobs q
      LEFT JOIN sessions s ON s.session_id = q.session_id
      WHERE q.status IN ('queued', 'processing')
      GROUP BY q.session_id
      ORDER BY
        CASE COALESCE(s.status, 'missing') WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END ASC,
        runnable_queued_count DESC,
        processing_count DESC,
        COALESCE(oldest_runnable_queued_created_at, 9223372036854775807) ASC,
        COALESCE(oldest_processing_updated_at, 9223372036854775807) ASC,
        COALESCE(oldest_queued_created_at, 9223372036854775807) ASC,
        q.session_id ASC
      LIMIT :limit
    `, {
      ':now': now,
      ':limit': maxRows,
    });
    return rows.map(normalizeMessageJobSessionRow);
  },

  hasPendingWebhook(now = Date.now()) {
    const row = getRow(`
      SELECT id
      FROM message_jobs
      WHERE webhook_notified = 0
        AND COALESCE(TRIM(meta_blast_message_id), '') <> ''
        AND status IN ('sent', 'error')
        AND webhook_next_retry_at <= :now
      ORDER BY updated_at ASC
      LIMIT 1
    `, { ':now': now });
    return !!row;
  },

  claimPendingWebhook(now = Date.now()) {
    const row = getRow(`
      SELECT id
      FROM message_jobs
      WHERE webhook_notified = 0
        AND COALESCE(TRIM(meta_blast_message_id), '') <> ''
        AND status IN ('sent', 'error')
        AND webhook_next_retry_at <= :now
      ORDER BY updated_at ASC
      LIMIT 1
    `, { ':now': now });
    if (!row || !row.id) return null;

    const changes = runStatementWithChanges(`
      UPDATE message_jobs
      SET webhook_attempts = webhook_attempts + 1,
          updated_at = :updated_at
      WHERE id = :id
        AND webhook_notified = 0
        AND COALESCE(TRIM(meta_blast_message_id), '') <> ''
        AND status IN ('sent', 'error')
        AND webhook_next_retry_at <= :now
    `, {
      ':id': row.id,
      ':now': now,
      ':updated_at': now,
    });
    if (changes <= 0) return null;
    return this.getMessageJob(row.id);
  },

  stopInvalidMessageJobWebhooks() {
    const now = Date.now();
    return runStatementWithChanges(`
      UPDATE message_jobs
      SET webhook_notified = 1,
          webhook_next_retry_at = 0,
          updated_at = :updated_at
      WHERE webhook_notified = 0
        AND status IN ('sent', 'error')
        AND (
          COALESCE(TRIM(meta_blast_message_id), '') = ''
          OR LOWER(COALESCE(webhook_last_error, '')) LIKE '%meta blast message id not found%'
        )
    `, {
      ':updated_at': now,
    });
  },

  markWebhookDelivered(jobId) {
    const now = Date.now();
    runStatement(`
      UPDATE message_jobs
      SET webhook_notified = 1,
          webhook_last_error = NULL,
          webhook_delivered_at = :webhook_delivered_at,
          updated_at = :updated_at
      WHERE id = :id
    `, {
      ':id': jobId,
      ':webhook_delivered_at': now,
      ':updated_at': now,
    });
    return this.getMessageJob(jobId);
  },

  markWebhookRetry(jobId, errorMessage, nextRetryAt) {
    const now = Date.now();
    runStatement(`
      UPDATE message_jobs
      SET webhook_notified = 0,
          webhook_last_error = :webhook_last_error,
          webhook_next_retry_at = :webhook_next_retry_at,
          updated_at = :updated_at
      WHERE id = :id
    `, {
      ':id': jobId,
      ':webhook_last_error': errorMessage || null,
      ':webhook_next_retry_at': nextRetryAt || now,
      ':updated_at': now,
    });
    return this.getMessageJob(jobId);
  },

  markWebhookStopped(jobId, errorMessage) {
    const now = Date.now();
    runStatement(`
      UPDATE message_jobs
      SET webhook_notified = 1,
          webhook_last_error = :webhook_last_error,
          webhook_next_retry_at = 0,
          updated_at = :updated_at
      WHERE id = :id
    `, {
      ':id': jobId,
      ':webhook_last_error': errorMessage || null,
      ':updated_at': now,
    });
    return this.getMessageJob(jobId);
  },

  enqueueSessionFlowJob({
    id,
    requestId = null,
    jobType,
    priority = 'normal',
    coalesceKey = null,
    targetSessionId = null,
    cUser = null,
    payload = {},
    webhookUrl = null,
    maxAttempts = 3,
  }) {
    const now = Date.now();
    runStatement(`
      INSERT INTO session_flow_jobs (
        id, request_id, job_type, priority, coalesce_key, target_session_id, c_user, payload_json, webhook_url,
        status, attempts, max_attempts, next_retry_at,
        webhook_notified, webhook_attempts, webhook_next_retry_at,
        created_at, updated_at
      ) VALUES (
        :id, :request_id, :job_type, :priority, :coalesce_key, :target_session_id, :c_user, :payload_json, :webhook_url,
        'queued', 0, :max_attempts, 0,
        0, 0, 0,
        :created_at, :updated_at
      )
    `, {
      ':id': id,
      ':request_id': requestId || null,
      ':job_type': jobType,
      ':priority': normalizeSessionFlowJobPriority(priority),
      ':coalesce_key': coalesceKey || null,
      ':target_session_id': targetSessionId || null,
      ':c_user': cUser || null,
      ':payload_json': serialize(payload || {}),
      ':webhook_url': webhookUrl || null,
      ':max_attempts': maxAttempts,
      ':created_at': now,
      ':updated_at': now,
    });
    return this.getSessionFlowJob(id);
  },

  getActiveSessionFlowJobByCoalesceKey(coalesceKey) {
    const normalized = String(coalesceKey || '').trim();
    if (!normalized) return null;

    const row = getRow(`
      SELECT *
      FROM session_flow_jobs
      WHERE coalesce_key = :coalesce_key
        AND status IN ('queued', 'processing')
      ORDER BY
        CASE status WHEN 'queued' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END ASC,
        updated_at DESC
      LIMIT 1
    `, { ':coalesce_key': normalized });
    return normalizeSessionFlowJobRow(row);
  },

  coalesceQueuedSessionFlowJob(jobId, {
    requestId = null,
    priority = 'normal',
    targetSessionId = null,
    cUser = null,
    payload = {},
    webhookUrl = null,
    maxAttempts = 3,
  } = {}) {
    const now = Date.now();
    runStatement(`
      UPDATE session_flow_jobs
      SET request_id = COALESCE(:request_id, request_id),
          priority = :priority,
          target_session_id = :target_session_id,
          c_user = :c_user,
          payload_json = :payload_json,
          webhook_url = COALESCE(:webhook_url, webhook_url),
          max_attempts = :max_attempts,
          error_message = NULL,
          error_code = NULL,
          result_json = NULL,
          next_retry_at = :now,
          updated_at = :now
      WHERE id = :id
        AND status = 'queued'
    `, {
      ':id': jobId,
      ':request_id': requestId || null,
      ':priority': normalizeSessionFlowJobPriority(priority),
      ':target_session_id': targetSessionId || null,
      ':c_user': cUser || null,
      ':payload_json': serialize(payload || {}),
      ':webhook_url': webhookUrl || null,
      ':max_attempts': Math.max(1, Number(maxAttempts) || 1),
      ':now': now,
    });
    return this.getSessionFlowJob(jobId);
  },

  getSessionFlowJob(jobId) {
    const row = getRow('SELECT * FROM session_flow_jobs WHERE id = :id', { ':id': jobId });
    return normalizeSessionFlowJobRow(row);
  },

  getSessionFlowJobByRequestId(requestId) {
    if (!requestId) return null;
    const row = getRow(`
      SELECT *
      FROM session_flow_jobs
      WHERE request_id = :request_id
      ORDER BY created_at DESC
      LIMIT 1
    `, { ':request_id': requestId });
    return normalizeSessionFlowJobRow(row);
  },

  hasRunnableSessionFlowJob(now = Date.now()) {
    const row = getNextRunnableSessionFlowJobRow(now);
    return !!row;
  },

  claimNextSessionFlowJob(now = Date.now()) {
    const row = getNextRunnableSessionFlowJobRow(now);
    if (!row || !row.id) return null;

    const changes = runStatementWithChanges(`
      UPDATE session_flow_jobs
      SET status = 'processing',
          attempts = attempts + 1,
          started_at = COALESCE(started_at, :now),
          updated_at = :now
      WHERE id = :id AND status = 'queued' AND next_retry_at <= :now
    `, {
      ':id': row.id,
      ':now': now,
    });
    if (changes <= 0) return null;
    return this.getSessionFlowJob(row.id);
  },

  markSessionFlowJobCompleted(jobId, result) {
    const now = Date.now();
    runStatement(`
      UPDATE session_flow_jobs
      SET status = 'completed',
          error_message = NULL,
          error_code = NULL,
          result_json = :result_json,
          webhook_notified = 0,
          webhook_attempts = 0,
          webhook_next_retry_at = 0,
          webhook_last_error = NULL,
          webhook_delivered_at = NULL,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE id = :id
        AND status = 'processing'
    `, {
      ':id': jobId,
      ':result_json': serialize(result || {}),
      ':finished_at': now,
      ':updated_at': now,
    });
    return this.getSessionFlowJob(jobId);
  },

  markSessionFlowJobRetry(jobId, errorMessage, errorCode, nextRetryAt, result = null) {
    const now = Date.now();
    runStatement(`
      UPDATE session_flow_jobs
      SET status = 'queued',
          error_message = :error_message,
          error_code = :error_code,
          result_json = COALESCE(:result_json, result_json),
          next_retry_at = :next_retry_at,
          updated_at = :updated_at
      WHERE id = :id
        AND status = 'processing'
    `, {
      ':id': jobId,
      ':error_message': errorMessage || null,
      ':error_code': errorCode || null,
      ':result_json': result ? serialize(result) : null,
      ':next_retry_at': nextRetryAt || now,
      ':updated_at': now,
    });
    return this.getSessionFlowJob(jobId);
  },

  markSessionFlowJobError(jobId, errorMessage, errorCode, result = null) {
    const now = Date.now();
    runStatement(`
      UPDATE session_flow_jobs
      SET status = 'error',
          error_message = :error_message,
          error_code = :error_code,
          result_json = :result_json,
          webhook_notified = 0,
          webhook_attempts = 0,
          webhook_next_retry_at = 0,
          webhook_last_error = NULL,
          webhook_delivered_at = NULL,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE id = :id
        AND status = 'processing'
    `, {
      ':id': jobId,
      ':error_message': errorMessage || null,
      ':error_code': errorCode || null,
      ':result_json': serialize(result),
      ':finished_at': now,
      ':updated_at': now,
    });
    return this.getSessionFlowJob(jobId);
  },

  requeueStaleProcessingSessionFlowJobs(timeoutMs = 240000) {
    const now = Date.now();
    const threshold = now - Math.max(1000, Number(timeoutMs) || 240000);
    runStatement(`
      UPDATE session_flow_jobs
      SET status = 'queued',
          next_retry_at = :now,
          updated_at = :now
      WHERE status = 'processing' AND updated_at < :threshold
    `, {
      ':now': now,
      ':threshold': threshold,
    });
  },

  hasPendingSessionFlowWebhook(now = Date.now(), requireWebhookUrl = false) {
    const row = getRow(`
      SELECT id
      FROM session_flow_jobs
      WHERE webhook_notified = 0
        AND status IN ('completed', 'error')
        AND webhook_next_retry_at <= :now
        AND (:require_webhook_url = 0 OR COALESCE(webhook_url, '') <> '')
      ORDER BY updated_at ASC
      LIMIT 1
    `, {
      ':now': now,
      ':require_webhook_url': requireWebhookUrl ? 1 : 0,
    });
    return !!row;
  },

  claimPendingSessionFlowWebhook(now = Date.now(), requireWebhookUrl = false) {
    const row = getRow(`
      SELECT id
      FROM session_flow_jobs
      WHERE webhook_notified = 0
        AND status IN ('completed', 'error')
        AND webhook_next_retry_at <= :now
        AND (:require_webhook_url = 0 OR COALESCE(webhook_url, '') <> '')
      ORDER BY updated_at ASC
      LIMIT 1
    `, {
      ':now': now,
      ':require_webhook_url': requireWebhookUrl ? 1 : 0,
    });
    if (!row || !row.id) return null;

    const changes = runStatementWithChanges(`
      UPDATE session_flow_jobs
      SET webhook_attempts = webhook_attempts + 1,
          updated_at = :updated_at
      WHERE id = :id
        AND webhook_notified = 0
        AND status IN ('completed', 'error')
        AND webhook_next_retry_at <= :now
        AND (:require_webhook_url = 0 OR COALESCE(webhook_url, '') <> '')
    `, {
      ':id': row.id,
      ':now': now,
      ':require_webhook_url': requireWebhookUrl ? 1 : 0,
      ':updated_at': now,
    });
    if (changes <= 0) return null;
    return this.getSessionFlowJob(row.id);
  },

  markSessionFlowWebhookDelivered(jobId) {
    const now = Date.now();
    runStatement(`
      UPDATE session_flow_jobs
      SET webhook_notified = 1,
          webhook_last_error = NULL,
          webhook_delivered_at = :webhook_delivered_at,
          updated_at = :updated_at
      WHERE id = :id
    `, {
      ':id': jobId,
      ':webhook_delivered_at': now,
      ':updated_at': now,
    });
    return this.getSessionFlowJob(jobId);
  },

  markSessionFlowWebhookRetry(jobId, errorMessage, nextRetryAt) {
    const now = Date.now();
    runStatement(`
      UPDATE session_flow_jobs
      SET webhook_notified = 0,
          webhook_last_error = :webhook_last_error,
          webhook_next_retry_at = :webhook_next_retry_at,
          updated_at = :updated_at
      WHERE id = :id
    `, {
      ':id': jobId,
      ':webhook_last_error': errorMessage || null,
      ':webhook_next_retry_at': nextRetryAt || now,
      ':updated_at': now,
    });
    return this.getSessionFlowJob(jobId);
  },

  markSessionFlowWebhookStopped(jobId, errorMessage) {
    const now = Date.now();
    runStatement(`
      UPDATE session_flow_jobs
      SET webhook_notified = 1,
          webhook_last_error = :webhook_last_error,
          webhook_next_retry_at = 0,
          updated_at = :updated_at
      WHERE id = :id
    `, {
      ':id': jobId,
      ':webhook_last_error': errorMessage || null,
      ':updated_at': now,
    });
    return this.getSessionFlowJob(jobId);
  },

  enqueueCreateOperation({
    id,
    requestId = null,
    cUser = null,
    payload = {},
    maxAttempts = 3,
    step = 'create.queued',
    message = 'Create Meta queued.',
  }) {
    const now = Date.now();
    runStatement(`
      INSERT INTO create_operations (
        id, request_id, c_user, payload_json, status, step, message,
        attempts, max_attempts, next_retry_at,
        created_at, updated_at
      ) VALUES (
        :id, :request_id, :c_user, :payload_json, 'queued', :step, :message,
        0, :max_attempts, 0,
        :created_at, :updated_at
      )
    `, {
      ':id': id,
      ':request_id': requestId || null,
      ':c_user': cUser || null,
      ':payload_json': serialize(payload || {}),
      ':step': step,
      ':message': message,
      ':max_attempts': maxAttempts,
      ':created_at': now,
      ':updated_at': now,
    });
    return this.getCreateOperation(id);
  },

  getCreateOperation(operationId) {
    const row = getRow('SELECT * FROM create_operations WHERE id = :id', { ':id': operationId });
    return normalizeCreateOperationRow(row);
  },

  getCreateOperationByRequestId(requestId) {
    if (!requestId) return null;
    const row = getRow(`
      SELECT *
      FROM create_operations
      WHERE request_id = :request_id
      ORDER BY created_at DESC
      LIMIT 1
    `, { ':request_id': requestId });
    return normalizeCreateOperationRow(row);
  },

  hasRunnableCreateOperation(now = Date.now()) {
    const row = getNextRunnableCreateOperationRow(now);
    return !!row;
  },

  createOperationDemand(now = Date.now()) {
    const row = getRow(`
      SELECT
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing_count,
        SUM(CASE WHEN status = 'queued' AND next_retry_at <= :now THEN 1 ELSE 0 END) AS runnable_count,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_count
      FROM create_operations
      WHERE status IN ('queued', 'processing')
    `, {
      ':now': now,
    }) || {};

    const processingCount = Number(row.processing_count || 0);
    const runnableCount = Number(row.runnable_count || 0);
    const queuedCount = Number(row.queued_count || 0);
    return {
      processingCount,
      runnableCount,
      queuedCount,
      active: processingCount > 0 || runnableCount > 0,
    };
  },

  claimNextCreateOperation(now = Date.now()) {
    const row = getNextRunnableCreateOperationRow(now);
    if (!row || !row.id) return null;

    const changes = runStatementWithChanges(`
      UPDATE create_operations
      SET status = 'processing',
          attempts = attempts + 1,
          started_at = COALESCE(started_at, :now),
          updated_at = :now
      WHERE id = :id
        AND status = 'queued'
        AND next_retry_at <= :now
    `, {
      ':id': row.id,
      ':now': now,
    });
    if (changes <= 0) return null;
    return this.getCreateOperation(row.id);
  },

  markCreateOperationProgress(operationId, step, message, result = null) {
    const now = Date.now();
    runStatement(`
      UPDATE create_operations
      SET status = 'processing',
          step = :step,
          message = :message,
          result_json = COALESCE(:result_json, result_json),
          updated_at = :updated_at
      WHERE id = :id
    `, {
      ':id': operationId,
      ':step': step || null,
      ':message': message || null,
      ':result_json': result ? serialize(result) : null,
      ':updated_at': now,
    });
    return this.getCreateOperation(operationId);
  },

  markCreateOperationCompleted(operationId, result = null, message = 'Create Meta completed.') {
    const now = Date.now();
    runStatement(`
      UPDATE create_operations
      SET status = 'completed',
          step = 'create.done',
          message = :message,
          error_message = NULL,
          error_code = NULL,
          result_json = :result_json,
          debug_json = NULL,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE id = :id
        AND status = 'processing'
    `, {
      ':id': operationId,
      ':message': message || 'Create Meta completed.',
      ':result_json': serialize(result || {}),
      ':finished_at': now,
      ':updated_at': now,
    });
    return this.getCreateOperation(operationId);
  },

  markCreateOperationRetry(operationId, errorMessage, errorCode, nextRetryAt, debug = null, result = null) {
    const now = Date.now();
    runStatement(`
      UPDATE create_operations
      SET status = 'queued',
          error_message = :error_message,
          error_code = :error_code,
          debug_json = COALESCE(:debug_json, debug_json),
          result_json = COALESCE(:result_json, result_json),
          next_retry_at = :next_retry_at,
          updated_at = :updated_at
      WHERE id = :id
        AND status = 'processing'
    `, {
      ':id': operationId,
      ':error_message': errorMessage || null,
      ':error_code': errorCode || null,
      ':debug_json': debug ? serialize(debug) : null,
      ':result_json': result ? serialize(result) : null,
      ':next_retry_at': nextRetryAt || now,
      ':updated_at': now,
    });
    return this.getCreateOperation(operationId);
  },

  markCreateOperationError(operationId, errorMessage, errorCode, debug = null, result = null) {
    const now = Date.now();
    runStatement(`
      UPDATE create_operations
      SET status = 'error',
          step = COALESCE(step, 'create.failed'),
          message = :error_message,
          error_message = :error_message,
          error_code = :error_code,
          debug_json = :debug_json,
          result_json = :result_json,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE id = :id
        AND status = 'processing'
    `, {
      ':id': operationId,
      ':error_message': errorMessage || null,
      ':error_code': errorCode || null,
      ':debug_json': serialize(debug || {}),
      ':result_json': serialize(result || {}),
      ':finished_at': now,
      ':updated_at': now,
    });
    return this.getCreateOperation(operationId);
  },

  requeueStaleProcessingCreateOperations(timeoutMs = 900000) {
    const now = Date.now();
    const parsedTimeout = Number(timeoutMs);
    const effectiveTimeoutMs = Number.isFinite(parsedTimeout)
      ? Math.max(0, parsedTimeout)
      : 900000;
    const threshold = now - effectiveTimeoutMs;
    runStatement(`
      UPDATE create_operations
      SET status = 'queued',
          next_retry_at = :now,
          updated_at = :now
      WHERE status = 'processing' AND updated_at <= :threshold
    `, {
      ':now': now,
      ':threshold': threshold,
    });
  },


  clearAll() {
    runStatement('DELETE FROM sessions', {});
    runStatement('DELETE FROM fingerprints', {});
    runStatement('DELETE FROM message_jobs', {});
    runStatement('DELETE FROM session_flow_jobs', {});
    runStatement('DELETE FROM create_operations', {});
  },
};
