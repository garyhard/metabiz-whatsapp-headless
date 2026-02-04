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
    c_user TEXT NOT NULL UNIQUE,
    cookie_format TEXT NOT NULL,
    cookies TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    proxy TEXT,
    status TEXT,
    last_activity INTEGER,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);
`);

function persistDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function serialize(value) {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function deserialize(value) {
  if (value === null || value === undefined) return null;
  return JSON.parse(value);
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

function normalizeRow(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    cUser: row.c_user,
    cookieFormat: row.cookie_format,
    cookies: deserializeCookies(row.cookie_format, row.cookies),
    fingerprint: deserialize(row.fingerprint) || {},
    proxy: deserialize(row.proxy),
    status: row.status,
    lastActivity: row.last_activity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const sessionStore = {
  getBySessionId(sessionId) {
    const row = getRow('SELECT * FROM sessions WHERE session_id = :session_id', { ':session_id': sessionId });
    return normalizeRow(row);
  },

  getByCUser(cUser) {
    const row = getRow('SELECT * FROM sessions WHERE c_user = :c_user', { ':c_user': cUser });
    return normalizeRow(row);
  },

  saveSession({
    sessionId,
    cUser,
    cookieFormat,
    cookies,
    fingerprint,
    proxy,
    status,
    lastActivity,
  }) {
    const now = Date.now();
    runStatement(`
      INSERT INTO sessions (
        session_id, c_user, cookie_format, cookies, fingerprint, proxy, status, last_activity, created_at, updated_at
      ) VALUES (
        :session_id, :c_user, :cookie_format, :cookies, :fingerprint, :proxy, :status, :last_activity, :created_at, :updated_at
      )
      ON CONFLICT(session_id) DO UPDATE SET
        c_user = excluded.c_user,
        cookie_format = excluded.cookie_format,
        cookies = excluded.cookies,
        fingerprint = excluded.fingerprint,
        proxy = excluded.proxy,
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

  updateCookies(sessionId, cookieFormat, cookies) {
    const now = Date.now();
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
};
