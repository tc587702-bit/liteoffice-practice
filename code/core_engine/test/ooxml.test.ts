/**
 * @liteoffice/ooxml 共用层验证。
 *
 * 这一层是所有 docx/xlsx/pptx 读取器的公共前置，错了会同时污染三种格式，
 * 所以用**真实 Word 生成的文件**做验证，而不只用自造的最小样例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZipReader } from '../packages/zip/src/index.ts';
import {
  parseContentTypes,
  parseRels,
  relsPathFor,
  resolveTarget,
  normalizePart,
  shortRelType,
  findRelByType,
  parseWordStyles,
  parseNumbering,
  resolveParaProps,
  resolveRunProps,
  levelOf,
  renderListMarker,
  parseTheme,
  applyTheme,
  DEFAULT_OFFICE_THEME,
  themeColorAt,
  styleIdByName,
  attr,
  parseColor,
  parseOnOff,
} from '../packages/ooxml/src/index.ts';
import { XmlPullParser } from '../packages/xml/src/index.ts';

const WORKSPACE = 'C:\\deepseekharness';

function realDocx(): string | null {
  const candidates = ['二极管伏安特性实验报告.docx', '实验报告-1N4001伏安特性.docx', 'testF_del25.docx'];
  return candidates.map((f) => join(WORKSPACE, f)).find((p) => existsSync(p)) ?? null;
}

function loadDocx(path: string) {
  const bytes = new Uint8Array(readFileSync(path));
  return ZipReader.open(bytes);
}

test('OPC 路径解析：区分「源部件目录」与「_rels 目录」', () => {
  // 最常见的实现错误：把 media/image1.png 解析到 word/_rels/ 下
  assert.equal(resolveTarget('word/document.xml', 'media/image1.png'), 'word/media/image1.png');
  assert.equal(resolveTarget('word/document.xml', '/word/styles.xml'), 'word/styles.xml');
  assert.equal(resolveTarget('word/document.xml', '../customXml/item1.xml'), 'customXml/item1.xml');
  assert.equal(resolveTarget('xl/worksheets/sheet1.xml', '../sharedStrings.xml'), 'xl/sharedStrings.xml');
  assert.equal(resolveTarget('ppt/slides/slide1.xml', '../slideLayouts/slideLayout1.xml'), 'ppt/slideLayouts/slideLayout1.xml');
  assert.equal(relsPathFor('word/document.xml'), 'word/_rels/document.xml.rels');
  assert.equal(relsPathFor('[Content_Types].xml'), '_rels/[Content_Types].xml.rels');
  assert.equal(normalizePart('/a//b/./c/../d.xml'), 'a/b/d.xml');
  assert.equal(shortRelType('http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'), 'image');
});

test('关系解析：TargetMode 与相对路径', () => {
  const xml = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
</Relationships>`;
  const rels = parseRels(xml, 'word/document.xml');
  assert.equal(rels.size, 3);
  assert.equal(rels.get('rId1').target, 'word/styles.xml');
  assert.equal(rels.get('rId1').external, false);
  assert.equal(rels.get('rId2').target, 'word/media/image1.png');
  assert.equal(rels.get('rId3').mode, 'External');
  assert.equal(findRelByType(rels, 'styles').id, 'rId1');
});

test('关系解析：外部关系必须保持原始 URL，不得按包内路径解析', () => {
  // 真实踩过的 bug：parseRels 一律按包内相对路径解析 Target，不看 TargetMode，
  // 于是 `Target="https://example.com" TargetMode="External"` 被解析成
  // `word/https:/example.com`（normalizePart 还把 `//` 合并成 `/`）。
  // 后果是**所有超链接与外链图片全部失效**，而且失效得很隐蔽：链接还在，只是点到 404。
  // docx / xlsx / pptx 三种格式都受影响。
  const xml = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="a" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/path?q=1#frag" TargetMode="External"/>
  <Relationship Id="b" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:a@b.com" TargetMode="External"/>
  <Relationship Id="c" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="file:///C:/pics/x.png" TargetMode="External"/>
  <Relationship Id="d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/内部图.png"/>
  <Relationship Id="e" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="http://漏写了 TargetMode 的地址.com/x"/>
</Relationships>`;
  const rels = parseRels(xml, 'word/document.xml');

  assert.equal(rels.get('a').target, 'https://example.com/path?q=1#frag', 'URL 必须原样保留（含查询串与片段）');
  assert.equal(rels.get('a').external, true);
  assert.equal(rels.get('b').target, 'mailto:a@b.com', 'mailto 也是外部引用');
  assert.equal(rels.get('b').external, true);
  assert.equal(rels.get('c').target, 'file:///C:/pics/x.png', 'file: URL 不应被当成包内部件路径');
  assert.equal(rels.get('c').external, true);

  // 内部关系仍必须按「源部件所在目录」解析
  assert.equal(rels.get('d').target, 'word/media/内部图.png');
  assert.equal(rels.get('d').external, false);

  // 漏写 TargetMode 但给了绝对 URL —— 真实文件里出现过，也要按外部处理
  assert.equal(rels.get('e').external, true, '目标本身像 URL 时，即使漏写 TargetMode 也应判为外部');
  assert.equal(rels.get('e').target, 'http://漏写了 TargetMode 的地址.com/x');

  // 直接验算 resolveTarget 不会被 URL 破坏
  assert.equal(resolveTarget('word/document.xml', 'https://a.com/b.png'), 'https://a.com/b.png');
  assert.equal(resolveTarget('word/document.xml', 'media/a.png'), 'word/media/a.png');
  // 带冒号的部件名不应被误判成 URL（冒号前出现了斜杠）
  assert.equal(resolveTarget('word/document.xml', 'media/a:b.png'), 'word/media/a:b.png');
});

test('内容类型解析', () => {
  const xml = `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const ct = parseContentTypes(xml);
  assert.equal(ct.defaults.get('png'), 'image/png');
  // Override 的 PartName 带前导 '/'，必须规范化后才能与部件路径比对
  assert.equal(ct.overrides.get('word/document.xml'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml');
});

test('属性访问：带前缀与不带前缀都要命中', () => {
  const p = new XmlPullParser('<w:spacing w:before="240" after="120" w:line="360" w:lineRule="auto"/>');
  const e = p.next();
  assert.equal(attr(e, 'before'), '240');
  assert.equal(attr(e, 'lineRule'), 'auto');
  assert.equal(attr(e, 'missing'), undefined);
  assert.equal(parseOnOff('0'), false);
  assert.equal(parseOnOff('false'), false);
  assert.equal(parseOnOff('off'), false);
  assert.equal(parseOnOff('1'), true);
  assert.equal(parseOnOff(undefined), true, '仅存在性即表示 true');
  assert.equal(parseColor('FF0000'), '#ff0000');
  assert.equal(parseColor('auto'), undefined, 'auto 必须返回 undefined 以免打断继承链');
  assert.equal(parseColor(''), undefined);
});

test('样式解析：继承链、docDefaults、本地化样式名', () => {
  const xml = `<?xml version="1.0"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体"/><w:sz w:val="21"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/><w:color w:themeColor="accent1"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="MySub">
    <w:name w:val="我的子样式"/><w:basedOn w:val="Heading1"/>
    <w:rPr><w:i/></w:rPr>
  </w:style>
</w:styles>`;

  const styles = parseWordStyles(xml);
  assert.equal(styles.defaultRun.sizePt, 10.5, 'docDefaults 的 sz=21 半磅 -> 10.5pt');
  assert.equal(styles.defaultRun.font, 'Calibri');
  assert.equal(styles.defaultRun.fontEastAsia, '宋体');
  assert.equal(styles.defaultPara.spaceAfterPt, 8, '160 twip -> 8pt');
  assert.ok(Math.abs(styles.defaultPara.lineHeight - 259 / 240) < 1e-9);

  const h1 = resolveRunProps(styles, 'Heading1');
  assert.equal(h1.bold, true);
  assert.equal(h1.sizePt, 16, '32 半磅 -> 16pt');
  assert.equal(h1.themeColor, 'accent1');
  assert.equal(h1.font, 'Calibri', '应继承 docDefaults 的字体');

  const h1p = resolveParaProps(styles, 'Heading1');
  assert.equal(h1p.outlineLevel, 0);
  assert.equal(h1p.spaceBeforePt, 12, '240 twip -> 12pt');
  assert.equal(h1p.spaceAfterPt, 8, '未覆盖时应继承 docDefaults');

  // 多级继承：MySub -> Heading1 -> Normal -> docDefaults
  const sub = resolveRunProps(styles, 'MySub');
  assert.equal(sub.italic, true);
  assert.equal(sub.bold, true, '应继承 Heading1 的粗体');
  assert.equal(sub.sizePt, 16);

  // 直接格式优先级最高
  const direct = resolveRunProps(styles, 'MySub', { sizePt: 9 });
  assert.equal(direct.sizePt, 9);
  assert.equal(direct.italic, true, '未覆盖的部分仍应继承');

  // 本地化样式名与 styleId 都能查到。
  // byName 的键统一为小写，但调用方不该需要记住这件事 —— 用 styleIdByName() 更稳。
  assert.equal(styles.byName.get('heading 1'), 'Heading1');
  assert.equal(styles.byName.get('我的子样式'), 'MySub');
  assert.equal(styleIdByName(styles, 'Heading1'), 'Heading1');
  assert.equal(styleIdByName(styles, 'HEADING1'), 'Heading1', 'styleIdByName 必须做大小写归一');
  assert.equal(styleIdByName(styles, '  我的子样式  '), 'MySub', '应容忍首尾空白');
  assert.equal(styleIdByName(styles, '不存在的样式'), undefined);
});

test('样式环保护：互相 basedOn 不应死循环', () => {
  const xml = `<w:styles xmlns:w="x">
    <w:style w:type="paragraph" w:styleId="A"><w:basedOn w:val="B"/><w:rPr><w:b/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="B"><w:basedOn w:val="A"/><w:rPr><w:i/></w:rPr></w:style>
  </w:styles>`;
  const styles = parseWordStyles(xml);
  const props = resolveRunProps(styles, 'A');
  assert.equal(props.bold, true);
  assert.equal(props.italic, true);
});

test('编号解析与编号文本渲染', () => {
  const xml = `<?xml version="1.0"?>
<w:numbering xmlns:w="x">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#61623;"/><w:rFonts w:ascii="Symbol"/>
      <w:pPr><w:ind w:start="720" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

  const num = parseNumbering(xml);
  assert.equal(num.numToAbstract.get('1'), '0');
  assert.equal(num.numToAbstract.get('2'), '1');

  const lvl0 = levelOf(num, '1', 0);
  assert.equal(lvl0.numFmt, 'bullet');
  assert.equal(lvl0.indentStartTwip, 720);
  assert.equal(lvl0.hangingTwip, 360);
  // Symbol 字体的私用区字符必须被映射成可显示的项目符号
  const marker = renderListMarker(lvl0);
  assert.equal(marker, '•', `私用区符号应映射为可显示字符，实际 ${JSON.stringify(marker)}`);

  const lvl1 = levelOf(num, '1', 1);
  assert.equal(renderListMarker(lvl1, [1, 3]), 'c)');
  assert.equal(renderListMarker(lvl1, [1, 2]), 'b)');

  const dec = levelOf(num, '2', 0);
  assert.equal(renderListMarker(dec, [7]), '7.');

  // 越界层级回退到第 0 层而不是返回 undefined
  assert.equal(levelOf(num, '2', 5).numFmt, 'decimal');
  assert.equal(levelOf(num, 'nonexistent', 0), undefined);
});

test('主题色解析（srgbClr 与 sysClr 都要认）', () => {
  const xml = `<?xml version="1.0"?>
<a:theme xmlns:a="x"><a:themeElements><a:clrScheme name="Office">
  <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
  <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
  <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
  <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
</a:clrScheme></a:themeElements></a:theme>`;
  const theme = parseTheme(xml);
  assert.equal(theme.get('accent1'), '#4472c4');
  assert.equal(theme.get('dk1'), '#000000', 'sysClr 应取 lastClr');
  assert.equal(theme.get('lt1'), '#ffffff');
  assert.equal(themeColorAt(theme, 'accent1'), '#4472c4');
  assert.equal(themeColorAt(theme, 'text1'), '#000000', '别名 text1 -> dk1');

  const props: { color?: string; themeColor?: string } = { themeColor: 'accent2' };
  applyTheme(theme, props);
  assert.equal(props.color, '#ed7d31');
  // 已有显式颜色时不应被主题覆盖
  const explicit: { color?: string; themeColor?: string } = { color: '#123456', themeColor: 'accent1' };
  applyTheme(theme, explicit);
  assert.equal(explicit.color, '#123456');
  assert.equal(DEFAULT_OFFICE_THEME.get('accent1'), '#4472c4');
});

test('真实 docx：styles / numbering / rels / contentTypes / theme 全都能解析', async (t) => {
  const path = realDocx();
  if (!path) {
    t.skip('工作区没有可用的真实 .docx');
    return;
  }
  const r = loadDocx(path);
  const types = r.has('[Content_Types].xml') ? parseContentTypes(await r.text('[Content_Types].xml')) : undefined;
  assert.ok(types, '[Content_Types].xml 必须存在');
  assert.ok(types.overrides.size > 0, '应解析出部件级内容类型');

  // 关系：从根关系找到主文档部件，再找到样式与编号
  const rootRels = parseRels(await r.text('_rels/.rels'), '');
  const officeDoc = findRelByType(rootRels, 'officeDocument') ?? findRelByType(rootRels, 'package');
  assert.ok(officeDoc, '应能通过关系找到主文档部件');
  assert.ok(r.has(officeDoc.target), `关系指向的主部件应存在: ${officeDoc.target}`);
  console.log(`  [真实 docx] 主部件 ${officeDoc.target}（通过关系解析，而非硬编码路径）`);

  const docRelsPath = relsPathFor(officeDoc.target);
  const docRels = r.has(docRelsPath) ? parseRels(await r.text(docRelsPath), officeDoc.target) : new Map();
  console.log(`  [真实 docx] ${docRels.size} 条文档级关系，短类型: ${[...new Set([...docRels.values()].map((x) => x.shortType))].join(', ')}`);

  const stylesRel = findRelByType(docRels, 'styles');
  assert.ok(stylesRel, '文档应引用 styles 部件');
  const styles = parseWordStyles(await r.text(stylesRel.target));
  assert.ok(styles.styles.size > 3, `应解析出多个样式，实际 ${styles.styles.size}`);
  assert.ok(styles.defaultRun.sizePt !== undefined || styles.defaultRun.font !== undefined, '应解析出 docDefaults');
  console.log(`  [真实 docx] ${styles.styles.size} 个样式；默认字体=${styles.defaultRun.font ?? '未指定'} / 默认字号=${styles.defaultRun.sizePt ?? '未指定'}pt`);

  // 抽样验证：所有段落样式的继承解析都不应抛错，且至少能取到属性
  let withProps = 0;
  for (const [id, def] of styles.styles) {
    if (def.type !== 'paragraph') continue;
    const rp = resolveParaProps(styles, id);
    if (rp.spaceBeforePt !== undefined || rp.spaceAfterPt !== undefined || rp.align || rp.outlineLevel !== undefined) withProps++;
  }
  console.log(`  [真实 docx] ${withProps} 个段落样式解析出有效属性`);
  assert.ok(withProps > 0, '至少应有段落样式能解析出属性');

  const numRel = findRelByType(docRels, 'numbering');
  if (numRel && r.has(numRel.target)) {
    const numbering = parseNumbering(await r.text(numRel.target));
    console.log(`  [真实 docx] ${numbering.numToAbstract.size} 个编号实例 / ${numbering.abstract.size} 个抽象编号`);
    assert.ok(numbering.numToAbstract.size > 0, 'numbering.xml 存在时应解析出编号实例');
    for (const numId of numbering.numToAbstract.keys()) {
      const lvl = levelOf(numbering, numId, 0);
      assert.ok(lvl, `numId=${numId} 应能取到第 0 层定义`);
      const marker = renderListMarker(lvl);
      assert.equal(typeof marker, 'string');
    }
  } else {
    console.log('  [真实 docx] 无 numbering 部件，跳过编号验证');
  }

  const themeRel = findRelByType(docRels, 'theme');
  if (themeRel && r.has(themeRel.target)) {
    const theme = parseTheme(await r.text(themeRel.target));
    console.log(`  [真实 docx] 主题槽位 ${theme.size} 个，accent1=${theme.get('accent1') ?? '缺失'}`);
    assert.ok(theme.size >= 8, `主题应解析出多数槽位，实际 ${theme.size}`);
  } else {
    console.log('  [真实 docx] 无 theme 部件');
  }
});
