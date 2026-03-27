/**
 * SQLite-backed session store (sql.js)
 */

import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
    extension TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    message TEXT NOT NULL,
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
  CREATE INDEX IF NOT EXISTS idx_message_jobs_status_retry_priority_created
    ON message_jobs(status, next_retry_at, priority, created_at);
  CREATE TABLE IF NOT EXISTS session_flow_jobs (
    id TEXT PRIMARY KEY,
    request_id TEXT UNIQUE,
    job_type TEXT NOT NULL,
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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_jobs_status_retry_priority_created
      ON message_jobs(status, next_retry_at, priority, created_at)
  `);
} catch {
  // Index already exists.
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
        last_activity INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      );
      INSERT INTO sessions_new (
        session_id, c_user, cookie_format, cookies, fingerprint, proxy, twofa_secret, status,
        restricted, restriction_details_json, restriction_detected_at,
        last_activity, created_at, updated_at
      )
      SELECT
        session_id, c_user, cookie_format, cookies, fingerprint, proxy, twofa_secret, status,
        0, NULL, NULL,
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

function persistDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

migrateSessionsTableDropCUserUnique();
persistDb();

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

function messageJobPriorityOrderSql(columnName = 'q.priority') {
  return `CASE ${columnName} WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END`;
}

function getNextRunnableMessageJobRow(now = Date.now(), preferredSessionId = null, onlyPreferredSession = false) {
  const preferredSession = preferredSessionId ? String(preferredSessionId) : null;
  if (preferredSession) {
    const preferredRow = getRow(`
      SELECT q.id
      FROM message_jobs q
      WHERE q.session_id = :session_id
        AND q.status = 'queued'
        AND q.next_retry_at <= :now
        AND NOT EXISTS (
          SELECT 1
          FROM message_jobs p
          WHERE p.session_id = q.session_id
            AND p.status = 'processing'
        )
      ORDER BY ${messageJobPriorityOrderSql('q.priority')} ASC, q.created_at ASC
      LIMIT 1
    `, {
      ':session_id': preferredSession,
      ':now': now,
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
    WHERE q.status = 'queued'
      AND q.next_retry_at <= :now
      AND NOT EXISTS (
        SELECT 1
        FROM message_jobs p
        WHERE p.session_id = q.session_id
          AND p.status = 'processing'
      )
    ORDER BY ${messageJobPriorityOrderSql('q.priority')} ASC, q.created_at ASC
    LIMIT 1
  `, { ':now': now });
}

function getNextRunnableSessionFlowJobRow(now = Date.now()) {
  return getRow(`
    SELECT id
    FROM session_flow_jobs
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
  persistDb();
}

function runStatementWithChanges(sql, params) {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
  const changes = db.getRowsModified();
  persistDb();
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
    extension: row.extension,
    phoneNumber: row.phone_number,
    message: row.message,
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

function normalizeSessionFlowJobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id || null,
    jobType: row.job_type,
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

export const sessionStore = {
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
    extension,
    phoneNumber,
    message,
    useReplyFlow = false,
    includeSuccessScreenshot = false,
    maxAttempts = 5,
  }) {
    const now = Date.now();
    runStatement(`
      INSERT INTO message_jobs (
        id, request_id, meta_blast_message_id, session_id, priority, extension, phone_number, message,
        use_reply_flow, include_success_screenshot, status, attempts, max_attempts,
        next_retry_at, webhook_notified, webhook_attempts, webhook_next_retry_at,
        created_at, updated_at
      ) VALUES (
        :id, :request_id, :meta_blast_message_id, :session_id, :priority, :extension, :phone_number, :message,
        :use_reply_flow, :include_success_screenshot, 'queued', 0, :max_attempts,
        0, 0, 0, 0, :created_at, :updated_at
      )
    `, {
      ':id': id,
      ':request_id': requestId || null,
      ':meta_blast_message_id': metaBlastMessageId || null,
      ':session_id': sessionId,
      ':priority': normalizeMessageJobPriority(priority, useReplyFlow ? 'high' : 'normal'),
      ':extension': extension,
      ':phone_number': phoneNumber,
      ':message': message,
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
    return normalizeMessageJobRow(row);
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

  hasRunnableMessageJob(now = Date.now(), preferredSessionId = null, onlyPreferredSession = false) {
    const row = getNextRunnableMessageJobRow(now, preferredSessionId, onlyPreferredSession);
    return !!row;
  },

  claimNextMessageJob(now = Date.now(), preferredSessionId = null, onlyPreferredSession = false) {
    const row = getNextRunnableMessageJobRow(now, preferredSessionId, onlyPreferredSession);
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

  markMessageJobSent(jobId, result) {
    const now = Date.now();
    runStatement(`
      UPDATE message_jobs
      SET status = 'sent',
          error_message = NULL,
          result_json = :result_json,
          webhook_notified = CASE WHEN COALESCE(TRIM(meta_blast_message_id), '') = '' THEN 1 ELSE 0 END,
          webhook_attempts = 0,
          webhook_next_retry_at = 0,
          webhook_last_error = NULL,
          webhook_delivered_at = CASE WHEN COALESCE(TRIM(meta_blast_message_id), '') = '' THEN :finished_at ELSE NULL END,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE id = :id
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
          webhook_notified = CASE WHEN COALESCE(TRIM(meta_blast_message_id), '') = '' THEN 1 ELSE 0 END,
          webhook_attempts = 0,
          webhook_next_retry_at = 0,
          webhook_last_error = NULL,
          webhook_delivered_at = CASE WHEN COALESCE(TRIM(meta_blast_message_id), '') = '' THEN :finished_at ELSE NULL END,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE id = :id
    `, {
      ':id': jobId,
      ':error_message': errorMessage || null,
      ':result_json': serialize(result),
      ':finished_at': now,
      ':updated_at': now,
    });
    return this.getMessageJob(jobId);
  },

  failQueuedMessageJobsForSession(sessionId, errorMessage, result = null) {
    if (!sessionId) return 0;

    const now = Date.now();
    return runStatementWithChanges(`
      UPDATE message_jobs
      SET status = 'error',
          error_message = :error_message,
          result_json = :result_json,
          webhook_notified = CASE WHEN COALESCE(TRIM(meta_blast_message_id), '') = '' THEN 1 ELSE 0 END,
          webhook_attempts = 0,
          webhook_next_retry_at = 0,
          webhook_last_error = NULL,
          webhook_delivered_at = CASE WHEN COALESCE(TRIM(meta_blast_message_id), '') = '' THEN :finished_at ELSE NULL END,
          finished_at = :finished_at,
          updated_at = :updated_at
      WHERE session_id = :session_id
        AND status = 'queued'
    `, {
      ':session_id': String(sessionId),
      ':error_message': errorMessage || null,
      ':result_json': serialize(result),
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

    return rows.reduce((memo, row) => {
      const status = String(row.status || "").trim().toLowerCase();
      if (!status) return memo;
      memo[status] = Number(row.count || 0);
      return memo;
    }, {});
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
    targetSessionId = null,
    cUser = null,
    payload = {},
    webhookUrl = null,
    maxAttempts = 3,
  }) {
    const now = Date.now();
    runStatement(`
      INSERT INTO session_flow_jobs (
        id, request_id, job_type, target_session_id, c_user, payload_json, webhook_url,
        status, attempts, max_attempts, next_retry_at,
        webhook_notified, webhook_attempts, webhook_next_retry_at,
        created_at, updated_at
      ) VALUES (
        :id, :request_id, :job_type, :target_session_id, :c_user, :payload_json, :webhook_url,
        'queued', 0, :max_attempts, 0,
        0, 0, 0,
        :created_at, :updated_at
      )
    `, {
      ':id': id,
      ':request_id': requestId || null,
      ':job_type': jobType,
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

  clearAll() {
    runStatement('DELETE FROM sessions', {});
    runStatement('DELETE FROM fingerprints', {});
    runStatement('DELETE FROM message_jobs', {});
    runStatement('DELETE FROM session_flow_jobs', {});
  },
};
