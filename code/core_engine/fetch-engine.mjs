// 拉取 Office 内核产物（OnlyofficePersonal 9.3 产物 + x2t wasm）。
// 产物约 342MB 且含商业字体，绝不能进 Git，所以由这个脚本在构建时拉。
//
// 用法：
//   node code/core_engine/fetch-engine.mjs                  # 有网：从远端下载
//   node code/core_engine/fetch-engine.mjs --from=engine.tgz # 无网：从本地压缩包展开
//
// 产物落在 code/frontend/public/editor/（已在 .gitignore 中排除）
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

// TODO(Day 2 上午): 换成实际验证过的产物地址（OnlyofficePersonal 的 Release / 分支 9.3.0.133）
const DEFAULT_URL = process.env.LITEOFFICE_ENGINE_URL || ''

const ROOT = path.resolve(process.cwd())
const DEST = path.join(ROOT, 'code/frontend/public/editor')
const TMP = path.join(ROOT, '.cache/engine.tgz')

function log(msg) { console.log(`[engine] ${msg}`) }

async function download(url, file) {
  log(`下载 ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${res.statusText}`)
  await mkdir(path.dirname(file), { recursive: true })
  await pipeline(res.body, createWriteStream(file))
  const { size } = await stat(file)
  log(`已下载 ${(size / 1024 / 1024).toFixed(1)} MB`)
}

function untar(file, dest) {
  log(`展开到 ${path.relative(ROOT, dest)}`)
  return new Promise((resolve, reject) => {
    // 用系统 tar，避免为一次性脚本引入 npm 依赖
    const child = spawn('tar', ['-xzf', file, '-C', dest, '--strip-components=0'], {
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`))))
  })
}

async function main() {
  const fromArg = process.argv.find((a) => a.startsWith('--from='))
  const from = fromArg ? path.resolve(ROOT, fromArg.slice('--from='.length)) : null

  if (existsSync(DEST) && existsSync(path.join(DEST, 'onlyoffice.html')) === false) {
    // 目录存在但没有入口文件，按残留处理
    log('检测到残留目录，清理后重来')
    await rm(DEST, { recursive: true, force: true })
  }

  let archive = from
  if (!archive) {
    const url = DEFAULT_URL
    if (!url) {
      console.error(
        [
          '[engine] 还没有配置产物地址。',
          '  两个办法：',
          '  1) 设环境变量：LITEOFFICE_ENGINE_URL=https://.../engine-9.3.tgz node code/core_engine/fetch-engine.mjs',
          '  2) 离线包：    node code/core_engine/fetch-engine.mjs --from=engine-9.3.tgz',
        ].join('\n'),
      )
      process.exit(1)
    }
    archive = TMP
    await download(url, archive)
  }

  if (!existsSync(archive)) throw new Error(`找不到压缩包：${archive}`)

  await mkdir(DEST, { recursive: true })
  await untar(archive, DEST)

  log('完成。下一步：确认 public/editor/onlyoffice.html 可访问')
  log('注意：该目录含商业字体，仅供本地/内网构建，禁止分发到公网静态站（见规划 6.3）')
}

main().catch((err) => {
  console.error(`[engine] 失败：${err.message}`)
  process.exit(1)
})
