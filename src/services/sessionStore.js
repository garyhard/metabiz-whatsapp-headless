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
`);

try {
  db.exec('ALTER TABLE sessions ADD COLUMN twofa_secret TEXT');
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
        last_activity INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      );
      INSERT INTO sessions_new (
        session_id, c_user, cookie_format, cookies, fingerprint, proxy, twofa_secret, status, last_activity, created_at, updated_at
      )
      SELECT
        session_id, c_user, cookie_format, cookies, fingerprint, proxy, twofa_secret, status, last_activity, created_at, updated_at
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
        id, request_id, meta_blast_message_id, session_id, extension, phone_number, message,
        use_reply_flow, include_success_screenshot, status, attempts, max_attempts,
        next_retry_at, webhook_notified, webhook_attempts, webhook_next_retry_at,
        created_at, updated_at
      ) VALUES (
        :id, :request_id, :meta_blast_message_id, :session_id, :extension, :phone_number, :message,
        :use_reply_flow, :include_success_screenshot, 'queued', 0, :max_attempts,
        0, 0, 0, 0, :created_at, :updated_at
      )
    `, {
      ':id': id,
      ':request_id': requestId || null,
      ':meta_blast_message_id': metaBlastMessageId || null,
      ':session_id': sessionId,
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

  hasRunnableMessageJob(now = Date.now()) {
    const row = getRow(`
      SELECT id
      FROM message_jobs
      WHERE status = 'queued' AND next_retry_at <= :now
      ORDER BY created_at ASC
      LIMIT 1
    `, { ':now': now });
    return !!row;
  },

  claimNextMessageJob(now = Date.now()) {
    const row = getRow(`
      SELECT id
      FROM message_jobs
      WHERE status = 'queued' AND next_retry_at <= :now
      ORDER BY created_at ASC
      LIMIT 1
    `, { ':now': now });
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

  markMessageJobError(jobId, errorMessage) {
    const now = Date.now();
    runStatement(`
      UPDATE message_jobs
      SET status = 'error',
          error_message = :error_message,
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
      ':finished_at': now,
      ':updated_at': now,
    });
    return this.getMessageJob(jobId);
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

  hasPendingWebhook(now = Date.now()) {
    const row = getRow(`
      SELECT id
      FROM message_jobs
      WHERE webhook_notified = 0
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

  clearAll() {
    runStatement('DELETE FROM sessions', {});
    runStatement('DELETE FROM fingerprints', {});
    runStatement('DELETE FROM message_jobs', {});
  },
};
