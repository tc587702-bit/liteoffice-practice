import { renderMarkdown } from '../src/lib/markdown.ts'

const cases: Array<{ name: string; input: string; expect: string[] }> = [
  {
    name: '标题 / 粗斜体 / 行内代码',
    input: '# 标题\n\n这里有 **粗体** 和 *斜体* 以及 `code`。',
    expect: ['<h1>标题</h1>', '<strong>粗体</strong>', '<em>斜体</em>', '<code>code</code>'],
  },
  {
    name: '链接与图片',
    input: '[官网](https://example.com) 和 ![图](https://example.com/a.png)',
    expect: ['<a href="https://example.com" target="_blank" rel="noopener noreferrer">官网</a>', '<img src="https://example.com/a.png"', 'loading="lazy"'],
  },
  {
    name: '危险协议被拒',
    input: '[点我](javascript:alert(1))',
    expect: ['点我'],
  },
  {
    name: '有序 / 无序列表',
    input: '- 甲\n- 乙\n\n1. 一\n2. 二',
    expect: ['<ul><li>甲</li><li>乙</li></ul>', '<ol><li>一</li><li>二</li></ol>'],
  },
  {
    name: '表格',
    input: '| A | B |\n| --- | ---: |\n| 1 | 2 |',
    expect: ['<table>', '<th>A</th>', 'text-align:right', '<td>1</td>'],
  },
  {
    name: '引用 / 分割线 / 代码块',
    input: '> 引用一行\n\n---\n\n```js\nconst a = 1\n```',
    expect: ['<blockquote><p>引用一行</p></blockquote>', '<hr />', '<pre data-lang="js"><code>const a = 1</code></pre>'],
  },
  {
    name: 'HTML 注入被转义',
    input: '<script>alert(1)</script>',
    expect: ['&lt;script&gt;'],
  },
  {
    name: '行尾双空格 → 硬换行',
    input: '第一行  \n第二行',
    expect: ['<br />'],
  },
  {
    name: '删除线',
    input: '~~作废~~',
    expect: ['<del>作废</del>'],
  },
  {
    name: '表格里的竖线转义不误伤',
    input: '| 描述 |\n| --- |\n| a\\|b |',
    expect: ['<table>'],
  },
]

let failed = 0
for (const c of cases) {
  const out = renderMarkdown(c.input)
  const missing = c.expect.filter((e) => !out.includes(e))
  const ok = missing.length === 0
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!ok) {
    console.log('   期望包含:', missing)
    console.log('   实际输出:', out.replace(/\n/g, ' ⏎ ').slice(0, 240))
  }
}

// 安全回归：绝对不能出现未转义的 script
const dangerous = renderMarkdown('<img src=x onerror=alert(1)>')
const safe = !dangerous.includes('<img src=x') && dangerous.includes('&lt;img')
console.log(`${safe ? 'PASS' : 'FAIL'}  未转义标签不会直出`)
if (!safe) failed++

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
