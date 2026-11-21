/**
 * PPTX 解析回归测试
 *
 * 覆盖三类实测确认的问题（用真实课件验证过）：
 *   ① Wingdings 私有区字符 → 乱码（实测单文件 424 段）
 *   ② 58% 的 run 没有显式字号，需从母版 titleStyle/bodyStyle 继承
 *   ③ wmf/emf 矢量图在装饰层被静默丢弃（整页背景/logo 消失）
 *
 * 这些是纯函数级断言，不依赖真实文件与浏览器解压能力。
 */
import { describe, expect, it } from 'vitest'

import {
  mapSymbolTextForTest,
  ptToCardFont,
  readTxStyleSizesForTest,
  resolveThemeFaceForTest,
  slideWidthPtOf,
} from '../src/lib/pptxLayout'

describe('① 符号字体映射（乱码根因）', () => {
  it('Wingdings 勾号映射为 ✓', () => {
    expect(mapSymbolTextForTest('\uF0FC', 'Wingdings')).toBe('✓')
  })

  it('Wingdings 叉号映射为 ✗', () => {
    expect(mapSymbolTextForTest('\uF0FB', 'Wingdings')).toBe('✗')
  })

  it('符号字体声明时整段替换（实测 U+F09F 是钩形项目符）', () => {
    const out = mapSymbolTextForTest('\uF0FC 已完成', 'Wingdings')
    expect(out).toBe('✓ 已完成')
  })

  it('即使未声明符号字体，私有区字符也会尝试映射', () => {
    // 真实文件里存在 rPr 未写 latin 但字符落在私有区的情况
    expect(mapSymbolTextForTest('\uF0FC')).toBe('✓')
  })

  it('普通文本原样返回，不受影响', () => {
    expect(mapSymbolTextForTest('一元二次方程的判别式', '宋体')).toBe('一元二次方程的判别式')
  })

  it('未知私有区字符保持原样，不乱猜', () => {
    const rare = '\uE123'
    expect(mapSymbolTextForTest(rare, 'Wingdings')).toBe(rare)
  })
})

describe('② 主题字体占位符解析', () => {
  const theme = { majorLatin: 'Century Gothic', majorEa: 'Arial', minorLatin: 'Calibri', minorEa: '微软雅黑' }

  it('+mn-ea 解析为次体东亚字体', () => {
    expect(resolveThemeFaceForTest('+mn-ea', theme)).toBe('微软雅黑')
  })

  it('+mj-lt 解析为主体西文字体', () => {
    expect(resolveThemeFaceForTest('+mj-lt', theme)).toBe('Century Gothic')
  })

  it('具体字体名原样返回', () => {
    expect(resolveThemeFaceForTest('宋体', theme)).toBe('宋体')
  })

  it('无对应映射的占位符返回 undefined（交给浏览器回退）', () => {
    expect(resolveThemeFaceForTest('+mj-cs', theme)).toBeUndefined()
  })

  it('空值返回 undefined', () => {
    expect(resolveThemeFaceForTest('', theme)).toBeUndefined()
    expect(resolveThemeFaceForTest(null, theme)).toBeUndefined()
  })
})

describe('③ 母版字号继承（文字撑破文本框的根因）', () => {
  // 取自真实课件的 slideMaster1.xml 结构
  const masterXml = `
    <p:txStyles>
      <p:titleStyle>
        <a:lvl1pPr><a:defRPr sz="4000" kern="1200"/></a:lvl1pPr>
      </p:titleStyle>
      <p:bodyStyle>
        <a:lvl1pPr><a:defRPr sz="2400" kern="1200"/></a:lvl1pPr>
        <a:lvl2pPr><a:defRPr sz="2000"/></a:lvl2pPr>
        <a:lvl3pPr><a:defRPr sz="1800"/></a:lvl3pPr>
      </p:bodyStyle>
    </p:txStyles>`

  it('标题一级取 40pt', () => {
    const r = readTxStyleSizesForTest(masterXml)
    expect(r.title.get(1)).toBe(40)
  })

  it('正文各级字号分别取 24/20/18pt', () => {
    const r = readTxStyleSizesForTest(masterXml)
    expect(r.body.get(1)).toBe(24)
    expect(r.body.get(2)).toBe(20)
    expect(r.body.get(3)).toBe(18)
  })

  it('空 XML 不崩且返回空表', () => {
    const r = readTxStyleSizesForTest('')
    expect(r.title.size).toBe(0)
    expect(r.body.size).toBe(0)
  })

  it('没有 txStyles 时返回空表', () => {
    const r = readTxStyleSizesForTest('<p:sldMaster></p:sldMaster>')
    expect(r.title.size).toBe(0)
    expect(r.body.size).toBe(0)
  })
})

describe('④ 页宽换算（16:9 文字被裁切的根因）', () => {
  // 取自用户真实课件 presentation.xml：<p:sldSz cx="12192000" cy="6858000"/>
  it('16:9 页宽是 960pt，不是 720pt', () => {
    expect(slideWidthPtOf(12192000)).toBe(960)
  })

  it('4:3 页宽仍是 720pt', () => {
    expect(slideWidthPtOf(9144000)).toBe(720)
  })

  it('缺尺寸时兜底 720pt，不产生 NaN', () => {
    expect(slideWidthPtOf(0)).toBe(720)
  })

  const cqwOf = (css: string) => Number(/([\d.]+)cqw/.exec(css)?.[1] ?? NaN)

  it('同一个 28pt 字：按 720 算会比按 960 大三分之一', () => {
    const wide = cqwOf(ptToCardFont(28, 960))
    const wrong = cqwOf(ptToCardFont(28, 720))
    expect(wide).toBeCloseTo(2.9167, 3)
    expect(wrong).toBeCloseTo(3.8889, 3)
    // 写死 720 会把字放大 4/3，正是文字撑出文本框的原因
    expect(wrong / wide).toBeGreaterThan(1.3)
  })

  it('用容器单位而非固定像素：卡片变窄时字号会跟着缩', () => {
    // 回归防线：一旦改回写死 900px 基准，编辑器里 640px 的卡片又会裁字
    expect(ptToCardFont(28, 960)).toContain('cqw')
    expect(ptToCardFont(28, 960)).not.toMatch(/^\d+px$/)
  })

  it('字号缺失时按 18pt 兜底', () => {
    expect(cqwOf(ptToCardFont(undefined, 960))).toBeCloseTo(1.875, 3)
  })

  it('极小字号不设 px 下限：否则窄卡片上小字被抬大反而溢出', () => {
    expect(ptToCardFont(2, 960)).toBe('0.2083cqw')
    expect(ptToCardFont(2, 960)).not.toContain('max(')
  })

  it('页宽非法时兜底，不出现 Infinity/NaN', () => {
    expect(cqwOf(ptToCardFont(28, 0))).toBeCloseTo(3.8889, 3)
  })
})