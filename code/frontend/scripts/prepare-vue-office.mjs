/**
 * prepare-vue-office.mjs —— 补跑 @vue-office 的 postinstall。
 *
 * ## 为什么需要这一步
 * @vue-office/docx、/excel、/pptx、/pdf 这四个包都用 postinstall 脚本生成入口文件：
 *
 *   lib/v3/index.js   （Vue 3 构建）
 *   lib/v2/index.js   （Vue 2 构建）
 *        ↓ postinstall 按当前 Vue 版本复制其中一份
 *   lib/index.js      ←  package.json 里 "main" 指向的就是它
 *
 * 而 npm 11 起默认**不自动执行** postinstall（安全策略 allowScripts）。
 * 结果就是 `lib/index.js` 根本不存在，Vite 启动时报：
 *
 *   Failed to resolve entry for package "@vue-office/docx".
 *   The package may have incorrect main/module/exports specified in its package.json.
 *
 * 这个错误信息会把人引向「包坏了」的错误方向，实际只是脚本没跑。
 *
 * ## 用法
 *   npm run prepare:vo
 *
 * 幂等：入口文件已存在时跳过。
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['docx', 'excel', 'pptx', 'pdf'];

let fixed = 0;
let skipped = 0;
let failed = 0;

for (const name of PACKAGES) {
  const base = join(ROOT, 'node_modules', '@vue-office', name);
  if (!existsSync(base)) {
    console.log(`[prepare-vo] 跳过 @vue-office/${name}（未安装）`);
    skipped++;
    continue;
  }

  const entry = join(base, 'lib', 'index.js');
  if (existsSync(entry)) {
    console.log(`[prepare-vo] @vue-office/${name} 入口已存在，跳过`);
    skipped++;
    continue;
  }

  const script = join(base, 'lib', 'script', 'postinstall.js');
  if (!existsSync(script)) {
    console.error(`[prepare-vo] @vue-office/${name} 找不到 postinstall 脚本，包结构可能已变`);
    failed++;
    continue;
  }

  try {
    // 直接用当前 Node 执行，不经过 npm —— npm 的脚本审批机制不会介入
    execFileSync(process.execPath, [script], { cwd: base, stdio: 'pipe' });
    const ok = existsSync(entry);
    console.log(`[prepare-vo] @vue-office/${name} ${ok ? '入口已生成' : '执行了脚本但入口仍缺失'}`);
    if (ok) fixed++;
    else failed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[prepare-vo] @vue-office/${name} 执行失败：${msg}`);
    failed++;
  }
}

console.log(`\n[prepare-vo] 完成：修复 ${fixed}，跳过 ${skipped}，失败 ${failed}`);

if (failed > 0) {
  console.error('[prepare-vo] 有包未能就绪。可以手动执行：');
  console.error('            node node_modules/@vue-office/<name>/lib/script/postinstall.js');
  process.exit(1);
}
