/**
 * docx 格式往返保真测试
 *
 * 覆盖第一期新增的行内格式（字体/字号/颜色/底色/删除线/上下标）与段落对齐。
 * 两类断言缺一不可：
 *   A. XML 层：属性存在、且**元素顺序符合 OOXML 的 xsd:sequence**
 *      —— Word 对顺序错误直接判「文件已损坏」，而 WPS 宽容，
 *         只测内容不测顺序会漏掉这类问题（本项目曾真实踩到）。
 *   B. 往返层：buildDocx → parseDocx，样式必须原样读回。
 */
import { describe, expect, it } from 'vitest'

import { buildDocx, parseDocx } from '../src/lib/docx'

/** 从 zip 里取出 word/document.xml 的文本，用于断言 XML 结构 */
function documentXml(bytes: Uint8Array): string {
  // 导出用 store（不压缩），直接在字节里找 document.xml 的内容即可
  const text = new TextDecoder().decode(bytes)
  const start = text.indexOf('<w:document')
  if (start < 0) return ''
  const end = text.indexOf('</w:document>', start)
  return end > start ? text.slice(start, end + 13) : text.slice(start)
}

async function roundtrip(html: string) {
  const bytes = buildDocx(html, '测试文档')
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const doc = await parseDocx(buf as ArrayBuffer)
  return { bytes, doc, xml: documentXml(bytes) }
}

describe('A. XML 结构：属性写入与元素顺序', () => {
  it('字体写入三个槽位，中文走 eastAsia', async () => {
    const { xml } = await roundtrip('<p><span style="font-family:宋体">中文</span></p>')
    expect(xml).toContain('w:eastAsia="宋体"')
    // 中文字体时西文槽位不能填中文名，否则 Word 用西文字体渲染汉字会缺字
    expect(xml).toContain('w:ascii="Times New Roman"')
  })

  it('字号写成半磅，且 sz 与 szCs 同时出现', async () => {
    const { xml } = await roundtrip('<p><span style="font-size:12pt">小四</span></p>')
    expect(xml).toContain('<w:sz w:val="24"/>')
    expect(xml).toContain('<w:szCs w:val="24"/>')
  })

  it('半磅取整覆盖非整数磅值（五号 10.5pt → 21）', async () => {
    const { xml } = await roundtrip('<p><span style="font-size:10.5pt">五号</span></p>')
    expect(xml).toContain('<w:sz w:val="21"/>')
  })

  it('颜色转成十六进制，不带 # 也不写 rgb()', async () => {
    const { xml } = await roundtrip('<p><span style="color:rgb(192, 0, 0)">红字</span></p>')
    expect(xml).toContain('<w:color w:val="c00000"/>')
    expect(xml).not.toContain('rgb(')
  })

  it('底色命中 16 色枚举走 w:highlight，不写非法值', async () => {
    const { xml } = await roundtrip('<p><span style="background-color:rgb(255, 255, 0)">高亮</span></p>')
    expect(xml).toContain('<w:highlight w:val="yellow"/>')
    // 关键：浏览器给的 rgb() 绝不能原样进 w:val，否则 Word 拒绝打开
    expect(xml).not.toMatch(/<w:highlight w:val="rgb/)
  })

  it('非枚举底色降级为字符底纹 w:shd', async () => {
    const { xml } = await roundtrip('<p><span style="background-color:rgb(255, 140, 0)">自定义底</span></p>')
    expect(xml).toContain('<w:shd')
    expect(xml).toContain('w:fill="ff8c00"')
  })

  it('删除线与上下标写入', async () => {
    const s = await roundtrip('<p><s>删</s><sup>上</sup><sub>下</sub></p>')
    expect(s.xml).toContain('<w:strike/>')
    expect(s.xml).toContain('<w:vertAlign w:val="superscript"/>')
    expect(s.xml).toContain('<w:vertAlign w:val="subscript"/>')
  })

  it('rPr 内部顺序符合 CT_RPr：rFonts→b→i→strike→color→sz→highlight→u→vertAlign', async () => {
    // 同时给全所有属性，顺序错就会在这里暴露
    const { xml } = await roundtrip(
      '<p><span style="font-family:黑体;font-size:14pt;color:#c00000;background-color:#ffff00;text-decoration-line:line-through"><u><strong><em>全属性</em></strong></u></span></p>',
    )
    const m = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(xml)
    expect(m, '应生成 w:rPr').toBeTruthy()
    const order = [...m![1].matchAll(/<w:(\w+)/g)].map((x) => x[1])
    const rank: Record<string, number> = {
      rFonts: 0, b: 1, i: 2, strike: 3, color: 4, sz: 5, szCs: 5, highlight: 6, u: 7, shd: 8, vertAlign: 9,
    }
    const bad = order.filter((name, idx) =>
      idx > 0 && rank[name] !== undefined && rank[order[idx - 1]] !== undefined && rank[name] < rank[order[idx - 1]],
    )
    expect(bad, `rPr 元素顺序违反 OOXML 序列：${order.join(' → ')}`).toEqual([])
  })

  it('段落对齐写入 w:jc，且顺序符合 CT_PPr', async () => {
    const { xml } = await roundtrip('<p style="text-align:center">居中段</p>')
    expect(xml).toContain('<w:jc w:val="center"/>')
    const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(xml)
    expect(pPr).toBeTruthy()
    // pStyle 必须在 jc 之前；jc 必须在 outlineLvl 之前
    const order = [...pPr![1].matchAll(/<w:(\w+)/g)].map((x) => x[1])
    const rank: Record<string, number> = { pStyle: 0, jc: 1, outlineLvl: 2, numPr: 3 }
    const bad = order.filter(
      (n, i) => i > 0 && rank[n] !== undefined && rank[order[i - 1]] !== undefined && rank[n] < rank[order[i - 1]],
    )
    expect(bad, `pPr 元素顺序违反 OOXML 序列：${order.join(' → ')}`).toEqual([])
  })

  it('标题带对齐时 jc 仍在 outlineLvl 之前', async () => {
    const { xml } = await roundtrip('<h1 style="text-align:right">右对齐标题</h1>')
    expect(xml).toContain('<w:jc w:val="right"/>')
    const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(xml)
    const jcIdx = pPr![1].indexOf('<w:jc')
    const outlineIdx = pPr![1].indexOf('<w:outlineLvl')
    expect(jcIdx).toBeGreaterThan(-1)
    expect(jcIdx).toBeLessThan(outlineIdx)
  })

  it('列表项带对齐时 jc 在 numPr 之后', async () => {
    const { xml } = await roundtrip('<ul><li style="text-align:center">居中项</li></ul>')
    const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(xml)
    expect(pPr).toBeTruthy()
    expect(pPr![1].indexOf('<w:numPr')).toBeLessThan(pPr![1].indexOf('<w:jc'))
  })

  it('左对齐不写 jc（Word 默认值，省略更干净）', async () => {
    const { xml } = await roundtrip('<p style="text-align:left">左对齐</p>')
    expect(xml).not.toContain('<w:jc')
  })

  it('两端对齐映射为 both', async () => {
    const { xml } = await roundtrip('<p style="text-align:justify">两端</p>')
    expect(xml).toContain('<w:jc w:val="both"/>')
  })
})

describe('B. 往返保真：buildDocx → parseDocx', () => {
  it('字体往返', async () => {
    const { doc } = await roundtrip('<p><span style="font-family:黑体">黑体字</span></p>')
    expect(doc.html).toContain("font-family:'黑体'")
    expect(doc.plainText).toContain('黑体字')
  })

  it('字号往返（pt 值精确）', async () => {
    const { doc } = await roundtrip('<p><span style="font-size:10.5pt">五号</span></p>')
    expect(doc.html).toContain('font-size:10.5pt')
  })

  it('颜色往返（rgb → hex → hex 语义一致）', async () => {
    const { doc } = await roundtrip('<p><span style="color:rgb(192, 0, 0)">红</span></p>')
    expect(doc.html.toLowerCase()).toContain('color:#c00000')
  })

  it('枚举底色往返回 rgb', async () => {
    const { doc } = await roundtrip('<p><span style="background-color:rgb(255, 255, 0)">亮</span></p>')
    expect(doc.html).toContain('background-color:rgb(255, 255, 0)')
  })

  it('非枚举底色经 w:shd 往返', async () => {
    const { doc } = await roundtrip('<p><span style="background-color:rgb(255, 140, 0)">橙底</span></p>')
    expect(doc.html.toLowerCase()).toContain('background-color:#ff8c00')
  })

  it('删除线往返', async () => {
    const { doc } = await roundtrip('<p><s>划掉</s></p>')
    expect(doc.html).toContain('<s>')
    expect(doc.plainText).toContain('划掉')
  })

  it('上下标往返', async () => {
    const { doc } = await roundtrip('<p>x<sup>2</sup>+y<sub>i</sub></p>')
    expect(doc.html).toContain('<sup>')
    expect(doc.html).toContain('<sub>')
  })

  // 浏览器实测形态（Chrome 144，styleWithCSS=true）：execCommand('superscript')
  // 产出 <span style="vertical-align: super">，不是 <sup> 标签。
  // 只认标签会让真实编辑器的上下标导出 Word 时静默丢失（曾真实踩到）。
  it('浏览器真实形态的上下标（span vertical-align）仍能导出', async () => {
    const sup = await roundtrip('<p><span style="vertical-align: super;">2</span></p>')
    expect(sup.xml).toContain('<w:vertAlign w:val="superscript"/>')
    const sub = await roundtrip('<p><span style="vertical-align: sub;">i</span></p>')
    expect(sub.xml).toContain('<w:vertAlign w:val="subscript"/>')
  })

  it('浏览器真实形态的上下标往返', async () => {
    // 读回侧统一规范化成 <sup>/<sub> 标签形态（语义与 span vertical-align 等价，
    // 且标签形态能被导出侧再次识别，往返闭环成立）。
    const { doc } = await roundtrip('<p><span style="vertical-align: super;">上</span></p>')
    expect(doc.html).toContain('<sup>')
    expect(doc.plainText).toContain('上')
    // 二次往返仍保住 vertAlign
    const again = await roundtrip(doc.html)
    expect(again.xml).toContain('<w:vertAlign w:val="superscript"/>')
  })

  it('段落对齐往返（center/right/justify 三种）', async () => {
    for (const align of ['center', 'right', 'justify']) {
      const { doc } = await roundtrip(`<p style="text-align:${align}">段落</p>`)
      expect(doc.html, `align=${align}`).toContain(`text-align:${align}`)
    }
  })

  it('加粗/斜体/下划线未回归（第一期改造不应破坏原有能力）', async () => {
    const { doc } = await roundtrip('<p><strong>粗</strong><em>斜</em><u>划</u></p>')
    expect(doc.html).toContain('<strong>')
    expect(doc.html).toContain('<em>')
    expect(doc.html).toContain('<u>')
  })

  it('复合样式共存：粗体 + 黑体 + 小四 + 红字 + 黄底', async () => {
    const html =
      '<p><strong><span style="font-family:黑体;font-size:12pt;color:#c00000;background-color:#ffff00">复合</span></strong></p>'
    const { doc } = await roundtrip(html)
    expect(doc.html).toContain('<strong>')
    expect(doc.html).toContain("font-family:'黑体'")
    expect(doc.html).toContain('font-size:12pt')
    expect(doc.html.toLowerCase()).toContain('color:#c00000')
    expect(doc.html).toContain('background-color:rgb(255, 255, 0)')
  })

  it('历史遗留 <font> 标签仍能导出（兼容旧文档）', async () => {
    const { xml } = await roundtrip('<p><font face="楷体" size="7">老标签</font></p>')
    expect(xml).toContain('w:eastAsia="楷体"')
    expect(xml).toContain('<w:sz w:val="64"/>') // size 7 → 32pt → 64 半磅
  })

  it('纯文本段落往返，正文不丢', async () => {
    const { doc } = await roundtrip('<p>第一段</p><p>第二段</p>')
    expect(doc.plainText).toContain('第一段')
    expect(doc.plainText).toContain('第二段')
    expect(doc.paragraphCount).toBe(2)
  })

  it('导出无异常告警', async () => {
    const { doc } = await roundtrip('<p style="text-align:center"><strong><span style="font-size:14pt">干净</span></strong></p>')
    expect(doc.warnings).toEqual([])
  })
})

describe('C. 非法输入不产损坏文件', () => {
  it('越界字号不写非法 w:sz', async () => {
    const zero = await roundtrip('<p><span style="font-size:0pt">零</span></p>')
    expect(zero.xml).not.toContain('<w:sz')
  })

  it('非法颜色不写入，避免破坏 XML 属性', async () => {
    const { xml } = await roundtrip('<p><span style="color:rgb(999, 999, 999)">怪色</span></p>')
    expect(xml).not.toMatch(/<w:color w:val="[0-9a-fA-F]*[G-Zg-z]/)
  })

  it('transparent 底色不写入', async () => {
    const { xml } = await roundtrip('<p><span style="background-color:transparent">透明</span></p>')
    expect(xml).not.toContain('<w:highlight')
    expect(xml).not.toContain('<w:shd')
  })
})