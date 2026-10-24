#!/usr/bin/env node
/**
 * 从墨刀工作区同步最新生成版到 code/frontend
 *
 * 用法：
 *   node tools/sync-frontend.mjs                 # 自动找最新的 workspace 目录
 *   node tools/sync-frontend.mjs <源目录>         # 指定目录
 *   node tools/sync-frontend.mjs --dry-run       # 只看会改什么，不动文件
 *   node tools/sync-frontend.mjs --check-only    # 只跑验收检查，不复制
 *
 * 做的事：
 *   1. 定位源目录（默认扫 C:\Users\16595\Documents\modao\workspaces 下最新的）
 *   2. 跑 6 项验收检查（技术栈 / 依赖 / 无外链 / build）
 *   3. 排除 node_modules、dist 后复制到 code/frontend
 *   4. 打印新增 / 修改 / 删除的文件清单摘要
 *
 * 不自动 git commit —— 提交由人决定。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const TARGET = path.join(REPO, 'code', 'frontend')
const WORKSPACES = 'C:\\Users\\16595\\Documents\\modao\\workspaces'
const EXCLUDE = /[\\/](node_modules|dist|\.git)[\\/]|vite\.dev\.config\.mjs|^\.vite-cache/

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const checkOnly = args.includes('--check-only')
const explicit = args.find((a) => !a.startsWith('--'))

function latestWorkspace() {
  if (!fs.existsSync(WORKSPACES)) throw new Error(`找不到墨刀工作区目录: ${WORKSPACES}`)
  const found = []
  for (const day of fs.readdirSync(WORKSPACES)) {
    const dayPath = path.join(WORKSPACES, day)
    if (!fs.statSync(dayPath).isDirectory()) continue
    for (const id of fs.readdirSync(dayPath)) {
      const p = path.join(dayPath, id)
      if (!fs.statSync(p).isDirectory()) continue
      if (!fs.existsSync(path.join(p, 'package.json'))) continue
      found.push({ path: p, mtime: fs.statSync(p).mtimeMs })
    }
  }
  if (!found.length) throw new Error('工作区里没有含 package.json 的生成目录')
  found.sort((a, b) => b.mtime - a.mtime)
  return found[0].path
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (EXCLUDE.test(full)) continue
    if (entry.isDirectory()) walk(full, base, out)
    else out.push(path.relative(base, full))
  }
  return out
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

function dirSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else total += fs.statSync(full).size
  }
  return total
}
function checks(src) {
  const res = []
  const pkgPath = path.join(src, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const deps = Object.keys(pkg.dependencies ?? {})
  const devDeps = Object.keys(pkg.devDependencies ?? {})

  const react = [...deps, ...devDeps].filter((d) => /react/i.test(d))
  res.push(['无 React 依赖', react.length === 0, react.join(', ') || '0 个'])

  const files = walk(src)
  const vueCount = files.filter((f) => f.endsWith('.vue')).length
  const tsxCount = files.filter((f) => /\.(tsx|jsx)$/.test(f)).length
  res.push(['.vue 文件存在', vueCount > 0, `${vueCount} 个`])
  res.push(['无 .tsx / .jsx', tsxCount === 0, `${tsxCount} 个`])

  const srcDir = path.join(src, 'src')
  let modaoHits = 0
  if (fs.existsSync(srcDir)) {
    for (const rel of walk(srcDir)) {
      const text = fs.readFileSync(path.join(srcDir, rel), 'utf8')
      modaoHits += (text.match(/modao\.cc/g) ?? []).length
    }
  }
  res.push(['src 内无 modao.cc 外链', modaoHits === 0, `${modaoHits} 处`])
  res.push(['依赖数收敛', deps.length <= 8, `${deps.length} 个: ${deps.join(', ')}`])

  return { res, pkg, files }
}

function runBuild(src) {
  const env = {
    ...process.env,
    TMPDIR: path.join(REPO, '.tmp'),
    TEMP: path.join(REPO, '.tmp'),
    TMP: path.join(REPO, '.tmp'),
  }
  fs.mkdirSync(env.TMPDIR, { recursive: true })
  try {
    const out = execSync('npm run build', { cwd: src, env, encoding: 'utf8', stdio: 'pipe' })
    const distDir = path.join(src, 'dist')
    const size = fs.existsSync(distDir) ? dirSize(distDir) : 0
    return { ok: true, tail: out.trim().split('\n').slice(-6).join('\n'), size }
  } catch (e) {
    return { ok: false, tail: String(e.stdout ?? e.message).split('\n').slice(-12).join('\n'), size: 0 }
  }
}

function main() {
  const src = explicit ? path.resolve(explicit) : latestWorkspace()
  console.log(`源目录: ${src}`)
  console.log(`目标:   ${TARGET}\n`)

  const { res, pkg } = checks(src)
  console.log('=== 验收检查 ===')
  let failed = 0
  for (const [name, ok, detail] of res) {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(24)} ${detail}`)
    if (!ok) failed++
  }
  console.log(`  package name: ${pkg.name}`)

  if (checkOnly || dryRun) {
    console.log('\n=== 构建 ===')
    const b = runBuild(src)
    console.log(b.ok ? `  OK  dist ${(b.size / 1024 / 1024).toFixed(2)} MB` : '  FAIL')
    console.log(b.tail)
  } else {
    console.log('\n=== 构建 ===')
    const b = runBuild(src)
    console.log(b.ok ? `  OK  dist ${(b.size / 1024 / 1024).toFixed(2)} MB` : '  FAIL')
    console.log(b.tail)
    if (!b.ok) {
      console.log('\n构建失败，已中止复制。')
      process.exit(1)
    }
  }

  // 差异对比
  const srcFiles = walk(src)
  const dstFiles = fs.existsSync(TARGET) ? walk(TARGET) : []
  const added = srcFiles.filter((f) => !dstFiles.includes(f))
  const removed = dstFiles.filter((f) => !srcFiles.includes(f))
  const modified = srcFiles.filter(
    (f) => dstFiles.includes(f) && sha(path.join(src, f)) !== sha(path.join(TARGET, f)),
  )

  console.log('\n=== 差异 ===')
  console.log(`  新增 ${added.length} / 修改 ${modified.length} / 删除 ${removed.length}`)
  for (const f of added.slice(0, 12)) console.log(`    + ${f}`)
  for (const f of modified.slice(0, 12)) console.log(`    M ${f}`)
  for (const f of removed.slice(0, 12)) console.log(`    - ${f}`)

  if (dryRun) {
    console.log('\n[dry-run] 未复制任何文件。')
    return
  }
  if (failed > 0) {
    console.log(`\n有 ${failed} 项检查未通过，已中止复制。加 --check-only 可只看检查结果。`)
    process.exit(1)
  }

  fs.rmSync(TARGET, { recursive: true, force: true })
  fs.mkdirSync(TARGET, { recursive: true })
  for (const rel of srcFiles) {
    const to = path.join(TARGET, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(path.join(src, rel), to)
  }
  console.log(`\n已同步 ${srcFiles.length} 个文件到 code/frontend`)
  console.log('下一步：git add -A && git commit，或直接在 GitHub Desktop 里提交推送。')
}

main()
