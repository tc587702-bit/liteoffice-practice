/**
 * fixtures.mjs —— 基准用的合成大文件生成器。
 *
 * 为什么基准要自带生成器，而不能只依赖用户本机的真实文件：
 *   「低内存」是本项目的核心主张，主张必须**可复现**。真实文件在别人机器上不存在，
 *   基准就会静默跳过全部有意义的测量，输出一份「成功运行但没有数据」的报告。
 *
 * 另一层价值：这些生成器是**照规范独立写的**，与各 format-* 读取器、以及它们
 * 各自的测试夹具都无共享代码。于是「我的生成器造出的文件能被读取器正确解析」
 * 构成一次真正的交叉验证 —— 两边独立实现却互相认可，比单一实现自测可信得多。
 *
 * 内存约束：生成大文件时按块累积字符串再一次性 join，
 * 避免 `str += x` 在 V8 里反复复制导致生成期内存爆掉（那是生成器的问题，不是被测代码的）。
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ZipWriter } from '../packages/zip/src/index.ts';

const enc = new TextEncoder();

/* ================================================================== */
/* 通用                                                                */
/* ================================================================== */

/** 列号转 OOXML 引用（0 -> A, 25 -> Z, 26 -> AA）。base-26，注意没有 0 对应的字母。 */
export function colRef(c: number): string {
  let s = '';
  let n = c;
  for (;;) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}

/** 按块累积再 join，避免大字符串反复拼接 */
class Chunks {
  private readonly parts: string[] = [];
  push(s: string): void {
    this.parts.push(s);
  }
  toString(): string {
    return this.parts.join('');
  }
}

/* ================================================================== */
/* XLSX —— 最小但合法的工作簿                                            */
/* ================================================================== */

const XLSX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const XLSX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const XLSX_WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="大数据集" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const XLSX_WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/**
 * 含 0-49 内置 numFmt 之外的一个自定义格式，以及两种 cellXfs：
 * xf 0 默认、xf 1 加粗居中（用于验证样式索引共享）。
 */
const XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFF0000"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment horizontal="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

export interface XlsxOptions {
  rows: number;
  cols: number;
  /** 每行生成的单元格类型：数字 / 字符串 / 公式 */
  seedStrings?: number;
}

/**
 * 生成一个合法的大工作簿。
 *
 * 结构要点（都会被测到）：
 *   - 首行是字符串表头（走 sharedStrings，索引 0..cols-1）
 *   - 数据行：第 0 列数字、第 1 列字符串（复用少量共享字符串）、
 *     第 2 列公式（`<f>` + `<v>`）、其余列为数字
 *   - 每 1000 行插一个样式单元格（xf 1 加粗）与一个自定义数字格式（xf 2）
 *   - 稀疏：每 7 行跳过前 3 列，验证读取器不假设密集
 *   - dimension 给出准确范围（读取器据此判断表有多大）
 */
export async function makeXlsx(options: XlsxOptions): Promise<Uint8Array> {
  const { rows, cols } = options;
  const sharedStrings: string[] = ['编号', '名称', '公式列', '数值列', '备注'];
  for (let i = 0; i < 40; i++) sharedStrings.push(`分类-${String.fromCharCode(65 + (i % 26))}${i}`);

  const sheet = new Chunks();
  sheet.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n');
  sheet.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  sheet.push(`<dimension ref="A1:${colRef(cols - 1)}${rows}"/>`);
  sheet.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
  // 列宽：交替两种宽度，验证列宽换算
  sheet.push('<cols>');
  for (let c = 0; c < cols; c++) sheet.push(`<col min="${c + 1}" max="${c + 1}" width="${c % 3 === 0 ? 12.5 : 8.43}" customWidth="1"/>`);
  sheet.push('</cols>');
  sheet.push('<sheetData>');

  for (let r = 1; r <= rows; r++) {
    // 每 7 行制造稀疏：跳过前 3 列
    const sparseSkip = r % 7 === 0 ? 3 : 0;
    const ht = r % 100 === 0 ? ' ht="28" customHeight="1"' : '';
    sheet.push(`<row r="${r}"${ht}>`);
    for (let c = sparseSkip; c < cols; c++) {
      const ref = `${colRef(c)}${r}`;
      if (r === 1) {
        // 表头：共享字符串 + 加粗样式
        const si = c < sharedStrings.length ? c : 0;
        sheet.push(`<c r="${ref}" s="1" t="s"><v>${si}</v></c>`);
        continue;
      }
      if (r % 1000 === 0 && c === 0) {
        sheet.push(`<c r="${ref}" s="2"><v>${r * 1.5}</v></c>`);
      } else if (c === 0) {
        sheet.push(`<c r="${ref}"><v>${r}</v></c>`);
      } else if (c === 1) {
        sheet.push(`<c r="${ref}" t="s"><v>${5 + (r % 40)}</v></c>`);
      } else if (c === 2) {
        sheet.push(`<c r="${ref}"><f>SUM(A${r}:B${r})</f><v>${r * 2 + (r % 40)}</v></c>`);
      } else if (c === 3) {
        sheet.push(`<c r="${ref}" t="inlineStr"><is><t>行内-${r}</t></is></c>`);
      } else {
        sheet.push(`<c r="${ref}"><v>${(r * c) % 9973}.${(r + c) % 100}</v></c>`);
      }
    }
    sheet.push('</row>');
  }
  sheet.push('</sheetData>');
  sheet.push(`<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>`);
  sheet.push('</worksheet>');

  const sst = new Chunks();
  sst.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n');
  sst.push(`<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">`);
  for (const s of sharedStrings) sst.push(`<si><t>${escapeXml(s)}</t></si>`);
  sst.push('</sst>');

  const w = new ZipWriter();
  w.addFirst('[Content_Types].xml', XLSX_CONTENT_TYPES);
  w.add('_rels/.rels', XLSX_ROOT_RELS);
  w.add('xl/workbook.xml', XLSX_WORKBOOK);
  w.add('xl/_rels/workbook.xml.rels', XLSX_WORKBOOK_RELS);
  w.add('xl/styles.xml', XLSX_STYLES);
  w.add('xl/sharedStrings.xml', sst.toString());
  w.add('xl/worksheets/sheet1.xml', sheet.toString());
  return w.build();
}

/* ================================================================== */
/* DOCX                                                                */
/* ================================================================== */

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const DOCX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCX_DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体"/><w:sz w:val="21"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="32"/><w:color w:themeColor="accent1"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Heading1"/>
<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>
<w:pPr><w:ind w:start="720"/><w:shd w:val="clear" w:fill="F2F2F2"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
</w:styles>`;

const DOCX_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>
<w:pPr><w:ind w:start="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1">
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#61623;"/><w:rFonts w:ascii="Symbol"/>
<w:pPr><w:ind w:start="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

export interface DocxOptions {
  paragraphs: number;
  /** 每多少段插入一个二级标题（用来生成大纲） */
  headingEvery?: number;
  /** 是否在末尾插入一个表格 */
  withTable?: boolean;
}

/** 生成一个合法的大 docx：标题层级 + 有序/无序列表 + 富文本 run + 表格 */
export async function makeDocx(options: DocxOptions): Promise<Uint8Array> {
  const { paragraphs, headingEvery = 50, withTable = true } = options;
  const body = new Chunks();
  body.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n');
  body.push('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>');

  let ordered = 1;
  for (let i = 1; i <= paragraphs; i++) {
    if (i % headingEvery === 1) {
      body.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第 ${Math.ceil(i / headingEvery)} 章 测试标题</w:t></w:r></w:p>`,
      );
    }
    if (i % 10 === 0) {
      // 有序列表：验证编号计数是否递增（%1. 模板要用当前计数渲染）
      body.push(
        `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>` +
          `<w:r><w:t>有序列表项 ${ordered++}</w:t></w:r></w:p>`,
      );
    } else if (i % 10 === 5) {
      body.push(
        `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>无序列表项</w:t></w:r></w:p>`,
      );
    } else if (i % 17 === 0) {
      body.push(
        `<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>引用段落 ${i}</w:t></w:r></w:p>`,
      );
    } else {
      // 混合行内样式：验证 RunStyle 解析与继承。
      //
      // 这里**刻意不给 pStyle**。早期版本用了 Heading2，而 Heading2 继承 Heading1 的
      // `<w:b/>`，于是整段（含第一段「普通」文字）全是粗体 —— 交叉验证里
      // 「找到第一个 bold run」于是拿到的不是显式加粗那一个，期望落空。
      // 更根本的问题是：正文段落挂标题样式在语义上就是错的，会让所有正文变成大纲项。
      body.push(
        `<w:p>` +
          `<w:r><w:t xml:space="preserve">段落 ${i} 普通  </w:t></w:r>` +
          `<w:r><w:rPr><w:b/></w:rPr><w:t>加粗</w:t></w:r>` +
          `<w:r><w:rPr><w:i/><w:color w:val="FF0000"/></w:rPr><w:t>红色斜体</w:t></w:r>` +
          `<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>下划线</w:t></w:r>` +
          `<w:r><w:br/><w:t>换行后文本</w:t></w:r>` +
          `</w:p>`,
      );
    }
  }

  if (withTable) {
    body.push('<w:tbl><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>');
    for (let r = 0; r < 200; r++) {
      body.push('<w:tr>');
      for (let c = 0; c < 3; c++) {
        const span = r === 0 && c === 0 ? '<w:gridSpan w:val="2"/>' : '';
        body.push(
          `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/>${span}${r === 0 ? '<w:shd w:val="clear" w:fill="DDDDDD"/>' : ''}</w:tcPr>` +
            `<w:p><w:r><w:t>单元格 ${r}-${c}</w:t></w:r></w:p></w:tc>`,
        );
      }
      body.push('</w:tr>');
    }
    body.push('</w:tbl>');
  }

  body.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>');
  body.push('</w:body></w:document>');

  const w = new ZipWriter();
  w.addFirst('[Content_Types].xml', DOCX_CONTENT_TYPES);
  w.add('_rels/.rels', DOCX_ROOT_RELS);
  w.add('word/_rels/document.xml.rels', DOCX_DOC_RELS);
  w.add('word/styles.xml', DOCX_STYLES);
  w.add('word/numbering.xml', DOCX_NUMBERING);
  w.add('word/document.xml', body.toString());
  return w.build();
}

/* ================================================================== */
/* ODT —— 顺带验证扁平/压缩 ODF 路径                                     */
/* ================================================================== */

export interface OdtOptions {
  paragraphs: number;
}

export async function makeOdt(options: OdtOptions): Promise<Uint8Array> {
  const { paragraphs } = options;
  const body = new Chunks();
  body.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  body.push(
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
      'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
      'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
      'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
      'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2">',
  );
  body.push('<office:automatic-styles>');
  body.push('<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>');
  body.push('<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#0000ff"/></style:style>');
  body.push('<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."/></text:list-style>');
  body.push('</office:automatic-styles>');
  body.push('<office:body><office:text>');
  for (let i = 1; i <= paragraphs; i++) {
    if (i % 25 === 1) {
      body.push(`<text:h text:outline-level="1">第 ${Math.ceil(i / 25)} 节 ODF 标题</text:h>`);
    }
    if (i % 12 === 0) {
      body.push('<text:list text:style-name="L1"><text:list-item><text:p>列表项</text:p></text:list-item></text:list>');
    } else {
      body.push(
        `<text:p text:style-name="P1">第 ${i} 段 普通文本 <text:span text:style-name="T1">加粗蓝色</text:span>` +
          `<text:s text:c="3"/>制表<text:tab/>后<text:a xlink:href="https://example.com" xmlns:xlink="http://www.w3.org/1999/xlink">链接</text:a></text:p>`,
      );
    }
  }
  // `table:number-columns-repeated` 是 ODF 最危险的地方：一个巨大数字会膨胀出上万格
  body.push('<table:table table:name="Sheet1">');
  body.push('<table:table-column table:number-columns-repeated="4"/>');
  body.push('<table:table-row><table:table-cell office:value-type="string"><text:p>表头A</text:p></table:table-cell>');
  body.push('<table:table-cell table:number-columns-repeated="3" office:value-type="string"><text:p>表头</text:p></table:table-cell></table:table-row>');
  body.push('<table:table-row><table:table-cell office:value-type="float" office:value="42"><text:p>42</text:p></table:table-cell>');
  body.push('<table:table-cell table:number-columns-repeated="16380"/></table:table-row>');
  body.push('</table:table>');
  body.push('</office:text></office:body></office:document-content>');

  const w = new ZipWriter();
  // ODF 规范硬要求：mimetype 必须是第一个条目且**不压缩**
  w.addFirst('mimetype', 'application/vnd.oasis.opendocument.text', { store: true });
  w.add('META-INF/manifest.xml',
    '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">' +
      '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>');
  w.add('content.xml', body.toString());
  return w.build();
}

/* ================================================================== */
/* 纯文本家族                                                           */
/* ================================================================== */

export function makeTxt(lines: number): Uint8Array {
  const c = new Chunks();
  for (let i = 1; i <= lines; i++) c.push(`第 ${i} 行：这是一行用于基准的纯文本内容，包含一些中文字符与 ASCII words。\n`);
  return enc.encode(c.toString());
}

export function makeCsv(rows: number, cols: number): Uint8Array {
  const c = new Chunks();
  c.push(Array.from({ length: cols }, (_, i) => `列${i + 1}`).join(',') + '\n');
  for (let r = 1; r <= rows; r++) {
    const cells: string[] = [];
    for (let x = 0; x < cols; x++) {
      // 混合引号转义、含逗号的值、含换行的值 —— 覆盖 RFC4180 的三个要点
      if (x === 1) cells.push(`"含,逗号的值${r}"`);
      else if (x === 2) cells.push(`"含""引号""的值"`);
      else if (x === 3) cells.push(`"含\n换行的值${r}"`);
      else cells.push(String((r * (x + 1)) % 99991));
    }
    c.push(cells.join(',') + '\n');
  }
  return enc.encode(c.toString());
}

export function makeMarkdown(sections: number): Uint8Array {
  const c = new Chunks();
  c.push('# 基准文档\n\n');
  for (let s = 1; s <= sections; s++) {
    c.push(`## 第 ${s} 节\n\n`);
    c.push(`这是第 ${s} 节的正文，含 **加粗**、*斜体*、\`行内代码\` 与 [链接](https://example.com/s${s})。\n\n`);
    c.push('- 无序项一\n- 无序项二\n  - 嵌套项\n\n');
    c.push('1. 有序项一\n2. 有序项二\n\n');
    c.push('```js\nconst x = ' + s + ';\nconsole.log(x);\n```\n\n');
    c.push('| 列A | 列B |\n|---|---|\n| a' + s + ' | b' + s + ' |\n\n');
    c.push(`> 引用段落 ${s}\n\n`);
  }
  return enc.encode(c.toString());
}

/* ================================================================== */
/* 落盘                                                                */
/* ================================================================== */

export interface SyntheticFixture {
  path: string;
  bytes: number;
  label: string;
}

/**
 * 生成一组合成夹具并写入 outDir。
 * 规模刻意做到「远超视口与内存舒适区」，这样低内存机制才被真正压到。
 */
export async function makeSyntheticFixtures(outDir: string, options: { xlsxRows?: number; xlsxCols?: number; docxParas?: number } = {}): Promise<SyntheticFixture[]> {
  const xlsxRows = options.xlsxRows ?? 50_000;
  const xlsxCols = options.xlsxCols ?? 20;
  const docxParas = options.docxParas ?? 20_000;

  mkdirSync(outDir, { recursive: true });
  const out: SyntheticFixture[] = [];

  const jobs: Array<[string, string, () => Promise<Uint8Array> | Uint8Array]> = [
    [`大型工作簿.xlsx`, `${xlsxRows} 行 × ${xlsxCols} 列（${(xlsxRows * xlsxCols).toLocaleString('en-US')} 单元格）`, () => makeXlsx({ rows: xlsxRows, cols: xlsxCols })],
    [`长文档.docx`, `${docxParas} 段 + 200 行表格`, () => makeDocx({ paragraphs: docxParas })],
    [`长文档.odt`, `${docxParas / 2} 段 + 16384 列重复陷阱`, () => makeOdt({ paragraphs: Math.floor(docxParas / 2) })],
    [`大文本.txt`, `${docxParas * 2} 行`, () => makeTxt(docxParas * 2)],
    [`大表格.csv`, `${docxParas} 行 × 8 列（含引号/逗号/换行转义）`, () => makeCsv(docxParas, 8)],
    [`长文档.md`, `${docxParas / 20} 节（含代码块/表格/列表）`, () => makeMarkdown(Math.max(1, Math.floor(docxParas / 20)))],
  ];

  for (const [name, label, gen] of jobs) {
    const path = join(outDir, name);
    if (!existsSync(path)) {
      writeFileSync(path, await gen());
    }
    out.push({ path, bytes: statSync(path).size, label });
  }
  return out;
}

/* ================================================================== */
/* 工具                                                                */
/* ================================================================== */

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;'));
}
