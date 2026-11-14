/** 字符级 diff：给「改写前 / 改写后」做红绿对比 */

export interface DiffSegment {
  type: 'same' | 'del' | 'ins'
  text: string
}

/** 相邻同类合并，减少渲染节点 */
function merge(segs: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = []
  for (const s of segs) {
    if (!s.text) continue
    const last = out[out.length - 1]
    if (last && last.type === s.type) last.text += s.text
    else out.push({ ...s })
  }
  return out
}

/** 超长文本直接粗粒度：公共前后缀 + 中间整体替换（避免 O(n²) 卡死） */
function coarse(before: string, after: string): DiffSegment[] {
  let start = 0
  const maxStart = Math.min(before.length, after.length)
  while (start < maxStart && before[start] === after[start]) start += 1

  let endB = before.length
  let endA = after.length
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB -= 1
    endA -= 1
  }

  const out: DiffSegment[] = []
  if (start) out.push({ type: 'same', text: before.slice(0, start) })
  if (endB > start) out.push({ type: 'del', text: before.slice(start, endB) })
  if (endA > start) out.push({ type: 'ins', text: after.slice(start, endA) })
  if (endB < before.length) out.push({ type: 'same', text: before.slice(endB) })
  return merge(out)
}

function lcsDiff(before: string, after: string): DiffSegment[] {
  const n = before.length
  const m = after.length
  // dp[i][j] = before[i:] 与 after[j:] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const segs: DiffSegment[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      segs.push({ type: 'same', text: before[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      segs.push({ type: 'del', text: before[i] })
      i += 1
    } else {
      segs.push({ type: 'ins', text: after[j] })
      j += 1
    }
  }
  while (i < n) {
    segs.push({ type: 'del', text: before[i] })
    i += 1
  }
  while (j < m) {
    segs.push({ type: 'ins', text: after[j] })
    j += 1
  }
  return merge(segs)
}

/**
 * 对比两段文字。
 * 先剥掉公共前后缀，再对中间部分做 LCS，长文本自动降级为粗粒度。
 */
export function diffChars(before: string, after: string): DiffSegment[] {
  if (before === after) return before ? [{ type: 'same', text: before }] : []

  let start = 0
  const maxStart = Math.min(before.length, after.length)
  while (start < maxStart && before[start] === after[start]) start += 1

  let endB = before.length
  let endA = after.length
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB -= 1
    endA -= 1
  }

  const midB = before.slice(start, endB)
  const midA = after.slice(start, endA)
  if (midB.length + midA.length > 2400) return coarse(before, after)

  const out: DiffSegment[] = []
  if (start) out.push({ type: 'same', text: before.slice(0, start) })
  out.push(...lcsDiff(midB, midA))
  if (endB < before.length) out.push({ type: 'same', text: before.slice(endB) })
  return merge(out)
}

/** 变更统计，用于"共 3 处改动"这类提示 */
export function summarizeDiff(segs: DiffSegment[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const s of segs) {
    if (s.type === 'ins') added += s.text.length
    if (s.type === 'del') removed += s.text.length
  }
  return { added, removed }
}
