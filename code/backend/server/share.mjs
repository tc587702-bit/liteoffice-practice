/**
 * 分享链接：生成规则、限速、URL 拼装
 *
 * 设计要点：
 *  1. token 用 128 位随机（32 位十六进制），不用自增 ID、不用可逆编码
 *  2. 链接里只放 token，不含 doc_id（避免暴露文档总数）
 *  3. 同一 IP 校验失败次数超限 → 429
 *  4. 撤销不改 token，只置 revoked（旧链接立刻失效，便于排查）
 */
import { createShare, resolveShare, revokeShare, listShares } from './db.mjs'

const FAIL_LIMIT = 20
const FAIL_WINDOW_MS = 60_000
const failures = new Map() // ip -> { count, resetAt }

export function noteFailure(ip) {
  const t = Date.now()
  const rec = failures.get(ip)
  if (!rec || rec.resetAt < t) {
    failures.set(ip, { count: 1, resetAt: t + FAIL_WINDOW_MS })
    return
  }
  rec.count += 1
}

export function isBlocked(ip) {
  const rec = failures.get(ip)
  if (!rec) return false
  if (rec.resetAt < Date.now()) {
    failures.delete(ip)
    return false
  }
  return rec.count >= FAIL_LIMIT
}

export function makeShare({ docId, role, expiresInHours = 0 }) {
  if (role !== 'view' && role !== 'edit') throw new Error('role 只能是 view 或 edit')
  const expiresAt = expiresInHours > 0 ? Date.now() + expiresInHours * 3600_000 : null
  const token = createShare({ docId, role, expiresAt })
  return { token, role, expiresAt, url: `/d/${token}` }
}

export function checkShare(token) {
  return resolveShare(token)
}

export function revoke(token) {
  return revokeShare(token)
}

export function sharesOf(docId) {
  return listShares(docId)
}

const REASON_TEXT = {
  not_found: '链接不存在或文档已被删除',
  revoked: '链接已失效，请向发起者索取新的链接',
  expired: '链接已过期，请向发起者索取新的链接',
}

export function reasonText(reason) {
  return REASON_TEXT[reason] ?? '链接不可用'
}
