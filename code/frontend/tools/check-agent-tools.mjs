/**
 * 本地工具集自检（Node 24 原生类型擦除，不需要 esbuild）
 *
 *   node tools/check-agent-tools.mjs
 *
 * 构造一份"有毛病"的文档，断言每个工具都能发现问题；
 * 再构造一份"干净"的文档，断言不误报。
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '..', 'src', 'lib', 'agent', 'tools.ts')

const T = await import(pathToFileURL(SRC).href)

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

/* ---------- 脏文档：每类问题各一处 ---------- */
const dirty = {
  title: '问题文档',
  kind: 'docx',
  html: `
    <h1>实验报告</h1>
    <p>这是第一段落，内容足够长以便参与重复检测。</p>
    <h3>跳级标题</h3>
    <p>这是第一段落，内容足够长以便参与重复检测。</p>
    <table>
      <tr><th>电压</th><th>电流</th><th>备注</th></tr>
      <tr><td>0.6</td><td>1.2</td></tr>
      <tr><td>0.7</td><td></td><td>正常</td></tr>
    </table>
    <h1>第二个一级标题</h1>
    <p>短</p>
  `,
}

console.log('\n=== 1) 统计 ===')
const stats = T.getStats(dirty)
check('统计出正文字数', stats.charsNoSpace > 30, `字数=${stats.charsNoSpace}`)
check('统计出表格数', stats.tables === 1, `表格=${stats.tables}`)
check('统计出标题数', stats.headings === 3, `标题=${stats.headings}`)
check('阅读时长 >= 1 分钟', stats.readingMinutes >= 1, `${stats.readingMinutes} 分钟`)

console.log('\n=== 2) 大纲 ===')
const outline = T.getOutline(dirty)
check('大纲有 3 项', outline.length === 3, JSON.stringify(outline.map((o) => `h${o.level}:${o.text}`)))
check('含跳级 h1→h3', outline.some((o) => o.level === 3))

console.log('\n=== 3) 检索 ===')
const hits = T.searchDocument(dirty, '第一段落')
check('命中 2 处重复段落', hits.length === 2, `命中=${hits.length}`)
const reHits = T.searchDocument(dirty, '电压|电流', { regex: true })
check('正则检索可用', reHits.length >= 1, `命中=${reHits.length}`)
check('空查询返回空', T.searchDocument(dirty, '   ').length === 0)

console.log('\n=== 4) 表格检查 ===')
const tableIssues = T.checkTables(dirty)
check('发现列数不一致', tableIssues.some((i) => i.code === 'TABLE_ROW_WIDTH'))
check('严重级别为 error', tableIssues.find((i) => i.code === 'TABLE_ROW_WIDTH')?.severity === 'error')
check('发现空单元格', tableIssues.some((i) => i.code === 'TABLE_EMPTY_CELL'))
const tableHtml = dirty.html.match(/<table[\s\S]*?<\/table>/)[0]
const rows = T.parseTableRows(tableHtml)
check('解析出 3 行', rows.length === 3, `行=${rows.length}`)
check('首行 3 列', rows[0].length === 3)

console.log('\n=== 5) 标题检查 ===')
const headIssues = T.checkHeadings(dirty)
check('发现跳级', headIssues.some((i) => i.code === 'HEADING_SKIP'))
check('发现多个一级标题', headIssues.some((i) => i.code === 'HEADING_MULTI_H1'))

console.log('\n=== 6) 重复段落 ===')
const dupIssues = T.checkDuplicates(dirty)
check('发现重复段落', dupIssues.length === 1, `重复=${dupIssues.length}`)
check('短段落不误报', dupIssues.every((i) => !String(i.detail).includes('短')))

console.log('\n=== 7) 总体检 ===')
const report = T.diagnoseReport(dirty)
check('有 error 级问题', report.counts.error >= 1, `error=${report.counts.error}`)
check('有 warning 级问题', report.counts.warning >= 2, `warning=${report.counts.warning}`)
check('按严重级别排序', report.issues[0].severity === 'error')

console.log('\n=== 8) 干净文档不误报 ===')
const clean = {
  title: '干净文档',
  kind: 'docx',
  html: `
    <h1>标题</h1>
    <h2>小节一</h2>
    <p>这是一段正常内容，长度足够但与其他段落不同，不应被判为重复。</p>
    <h2>小节二</h2>
    <p>这又是另一段正常内容，讲的是不同的事情，同样不应被判为重复。</p>
    <table>
      <tr><th>项目</th><th>数值</th></tr>
      <tr><td>甲</td><td>1</td></tr>
    </table>
  `,
}
const cleanReport = T.diagnoseReport(clean)
check('干净文档无 error', cleanReport.counts.error === 0, `error=${cleanReport.counts.error}`)
check('干净文档无重复段落', !cleanReport.issues.some((i) => i.code === 'DUP_PARAGRAPH'))
check('干净文档无标题问题', !cleanReport.issues.some((i) => i.code.startsWith('HEADING')))

console.log('\n=== 9) 表格导出 ===')
const md = T.tableToMarkdown([['a', 'b'], ['1', '2']])
check('markdown 表格正确', md.includes('| a | b |') && md.includes('| --- | --- |'), md.split('\n')[0])
const csv = T.tableToCsv([['x', 'y'], ['1', '含,逗号']])
check('csv 自动加引号', csv.includes('"含,逗号"'), csv.split('\n')[1])
check('参差不齐的行自动补齐', T.tableToMarkdown([['a', 'b', 'c'], ['1']]).includes('| 1 |  |  |'))

console.log('\n=== 10) 工具声明 ===')
const names = Object.keys(T.TOOL_META)
check('声明了 7 个工具', names.length === 7, names.join(','))
check('全部不需要模型', names.every((n) => T.TOOL_META[n].needsModel === false))
check('全部不是破坏性操作', names.every((n) => T.TOOL_META[n].destructive === false))
check('全部需要当前文档', names.every((n) => T.TOOL_META[n].requires.includes('current_document')))

console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
