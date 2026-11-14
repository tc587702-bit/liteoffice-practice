/**
 * SQLite 持久化（Node 内置 node:sqlite，无需原生编译）
 *
 * 表结构：
 *   documents   文档主体（原始字节 + 渲染好的 HTML）
 *   shares      分享链接（token → 权限 / 过期 / 撤销）
 *   updates     协作增量（Yjs update 二进制，按 seq 递增）
 *   snapshots   定期快照（避免重放全部增量）
 */
import { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.LITEOFFICE_DB ?? resolve(__dirname, '..', 'data', 'liteoffice.db')

mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new DatabaseSync(DB_PATH)

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  html        TEXT NOT NULL DEFAULT '',
  content     BLOB,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  token       TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('view','edit')),
  expires_at  INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_doc ON shares(doc_id);

CREATE TABLE IF NOT EXISTS updates (
  doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  update_blob BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (doc_id, seq)
);

CREATE TABLE IF NOT EXISTS snapshots (
  doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  at_seq      INTEGER NOT NULL,
  state_blob  BLOB NOT NULL,
  PRIMARY KEY (doc_id, at_seq)
);
`)

const now = () => Date.now()

/* ---------------- documents ---------------- */

export function createDocument({ title, kind, html = '', content = null }) {
  const id = randomUUID()
  const t = now()
  db.prepare(
    `INSERT INTO documents (id, title, kind, html, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, title, kind, html, content, t, t)
  return id
}

export function getDocument(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id) ?? null
}

export function updateDocumentHtml(id, html) {
  db.prepare('UPDATE documents SET html = ?, updated_at = ? WHERE id = ?').run(html, now(), id)
}

export function listDocuments(limit = 50) {
  return db
    .prepare('SELECT id, title, kind, updated_at FROM documents ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
}

export function deleteDocument(id) {
  db.prepare('DELETE FROM documents WHERE id = ?').run(id)
}

/* ---------------- shares ---------------- */

export function createShare({ docId, role, expiresAt = null }) {
  const token = randomBytes(16).toString('hex') // 128 bit，不可猜
  db.prepare(
    'INSERT INTO shares (token, doc_id, role, expires_at, revoked, created_at) VALUES (?, ?, ?, ?, 0, ?)',
  ).run(token, docId, role, expiresAt, now())
  return token
}

/**
 * 校验顺序：存在 → 未撤销 → 未过期。
 * 返回 { ok, reason?, share?, doc? }
 */
export function resolveShare(token) {
  const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(token)
  if (!share) return { ok: false, reason: 'not_found' }
  if (share.revoked) return { ok: false, reason: 'revoked' }
  if (share.expires_at && share.expires_at < now()) return { ok: false, reason: 'expired' }
  const doc = getDocument(share.doc_id)
  if (!doc) return { ok: false, reason: 'not_found' }
  return { ok: true, share, doc }
}

export function revokeShare(token) {
  const r = db.prepare('UPDATE shares SET revoked = 1 WHERE token = ?').run(token)
  return r.changes > 0
}

export function revokeSharesOfDocument(docId) {
  return db.prepare('UPDATE shares SET revoked = 1 WHERE doc_id = ?').run(docId).changes
}

export function listShares(docId) {
  return db
    .prepare(
      'SELECT token, role, expires_at, revoked, created_at FROM shares WHERE doc_id = ? ORDER BY created_at DESC',
    )
    .all(docId)
}

/* ---------------- 协作增量 ---------------- */

/**
 * 追加增量。
 * seq 必须是全局单调的：既大于现有增量，也要大于最近快照的 at_seq，
 * 否则「写快照 → 裁剪旧增量 → MAX(seq) 归零」会让新增量拿到更小的 seq，
 * 重启后 replay 直接跳过它们（数据丢失）。
 */
export function appendUpdate(docId, update) {
  const row = db
    .prepare(
      `SELECT
         COALESCE((SELECT MAX(seq) FROM updates WHERE doc_id = ?), 0) AS us,
         COALESCE((SELECT MAX(at_seq) FROM snapshots WHERE doc_id = ?), 0) AS ss`,
    )
    .get(docId, docId)
  const seq = Math.max(row.us, row.ss) + 1
  db.prepare('INSERT INTO updates (doc_id, seq, update_blob, created_at) VALUES (?, ?, ?, ?)').run(
    docId,
    seq,
    update,
    now(),
  )
  return seq
}

export function listUpdates(docId, sinceSeq = 0) {
  return db
    .prepare('SELECT seq, update_blob FROM updates WHERE doc_id = ? AND seq > ? ORDER BY seq')
    .all(docId, sinceSeq)
}

export function latestSnapshot(docId) {
  return db
    .prepare('SELECT at_seq, state_blob FROM snapshots WHERE doc_id = ? ORDER BY at_seq DESC LIMIT 1')
    .get(docId) ?? null
}

export function latestSeq(docId) {
  const row = db
    .prepare(
      `SELECT MAX(
         COALESCE((SELECT MAX(seq) FROM updates WHERE doc_id = ?), 0),
         COALESCE((SELECT MAX(at_seq) FROM snapshots WHERE doc_id = ?), 0)
       ) AS s`,
    )
    .get(docId, docId)
  return row.s ?? 0
}

/** 快照落盘后裁掉已被快照覆盖的增量，避免表无限增长 */
export function pruneUpdates(docId, atSeq) {
  return db.prepare('DELETE FROM updates WHERE doc_id = ? AND seq <= ?').run(docId, atSeq).changes
}
export function saveSnapshot(docId, atSeq, state) {
  db.prepare('INSERT OR REPLACE INTO snapshots (doc_id, at_seq, state_blob) VALUES (?, ?, ?)').run(
    docId,
    atSeq,
    state,
  )
}

export { DB_PATH }
