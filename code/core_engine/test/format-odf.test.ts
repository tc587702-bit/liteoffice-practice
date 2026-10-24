/**
 * @liteoffice/format-odf 读取器验证。
 *
 * 工作区里没有真实的 .odt/.ods/.odp，因此这里用 ZipWriter 自造**合法的 ODF 包**：
 *   第一个条目必须是 mimetype，且必须 `{ store: true }` 不压缩存储（ODF 规范硬要求）。
 * 这样造出来的夹具与实际文件在结构上一致，嗅探器与读取器都认。
 *
 * 覆盖重点（都是「做错了也能跑但结果明显不对」的地方）：
 *   - 样式继承链 + default-style（不做就全篇 12pt 黑字）
 *   - 列表的两级间接：style-name -> text:list-style -> list-level-style-*（不做就退化成普通段落）
 *   - number-columns-repeated=16384 必须被裁剪，且不能真的建出上万个对象
 *   - 单位换算：1.5cm 必须是 42.52pt 而不是 1.5pt
 *   - 图片按相对 content.xml 的路径（含 `./`）解析
 *   - 加密文件抛 ENCRYPTED
 *   - 扁平变体不调用 ctx.container()
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZipReader, ZipWriter } from '../packages/zip/src/index.ts';
import { LimitGuard, withLimits } from '../packages/core/src/index.ts';
import type { FormatId, Limits, LiteDocument } from '../packages/core/src/index.ts';
import type { ContainerAccess, ReadContext, ReadProgress } from '../packages/core/src/registry.ts';
import { odfReader } from '../packages/format-odf/src/index.ts';

/* ==================================================================== */
/* 测试基础设施                                                          */
/* ==================================================================== */

/** 一个 1×1 的 PNG（真实字节，用来验证图片确实按条目路径从 zip 取出）。 */
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const ODF_NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"',
  'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"',
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"',
  'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"',
].join(' ');

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

/**
 * 造一个**合法**的 ODF zip 包。
 * mimetype 用 addFirst + store —— 这是 ODF 规范对包结构的硬要求：
 * 首条且不压缩存储，`file(1)` 之类工具只看文件头就能判格式。
 */
async function makeOdfZip(
  mimetype: string,
  parts: Record<string, string | Uint8Array>,
  opts: { manifest?: string; skipManifest?: boolean } = {},
): Promise<Uint8Array> {
  const w = new ZipWriter();
  w.addFirst('mimetype', mimetype, { store: true });
  if (!opts.skipManifest) w.add('META-INF/manifest.xml', opts.manifest ?? MANIFEST);
  for (const [name, data] of Object.entries(parts)) w.add(name, data);
  return w.build();
}

/** 把扁平 ODF 当普通字节读（不是 zip）。 */
function flatBytes(xml: string): Uint8Array {
  return new TextEncoder().encode(xml);
}

interface ReadOpts {
  name: string;
  limits?: Partial<Limits>;
  /** 断言用：扁平变体绝不允许调用 ctx.container() */
  forbidContainer?: boolean;
}

/**
 * 直接驱动 `odfReader.read(ctx)`，复刻 engine 的 ReadContext 语义。
 *
 * 为什么不走 openDocument()：本包的测试要能**断言 container() 有没有被调用**
 * （扁平变体不该开容器），而 engine 的编排会掩盖这件事。
 */
async function readOdfDocument(bytes: Uint8Array, opts: ReadOpts): Promise<LiteDocument> {
  const limits = withLimits(opts.limits);
  const guard = new LimitGuard(limits);
  const phases: Record<string, number> = {};
  let containerCalls = 0;

  const phase = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      phases[name] = (phases[name] ?? 0) + (Date.now() - t0);
    }
  };

  const ctx: ReadContext = {
    name: opts.name,
    size: bytes.length,
    bytes: async () => bytes,
    container: async (): Promise<ContainerAccess> => {
      containerCalls++;
      return ZipReader.open(bytes, { maxEntryBytes: limits.maxEntryBytes });
    },
    limits,
    guard,
    onProgress: (_p: ReadProgress) => undefined,
    phase,
  };

  const doc = await odfReader.read(ctx);
  if (opts.forbidContainer) {
    assert.equal(containerCalls, 0, '扁平 ODF（fodt/fods/fodp）绝不能调用 ctx.container()');
  }
  // engine 通常会补这些字段；这里补上以便断言
  doc.stats.sourceBytes = bytes.length;
  const snap = guard.snapshot();
  doc.stats.warnings = [...new Set([...doc.stats.warnings, ...snap.warnings])];
  doc.stats.truncated = [...new Set([...doc.stats.truncated, ...snap.truncated])];
  return doc;
}

/* ==================================================================== */
/* 夹具：文字处理                                                        */
/* ==================================================================== */

const ODT_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${ODF_NS} office:version="1.2">
  <office:styles>
    <style:default-style style:family="paragraph">
      <style:paragraph-properties fo:margin-bottom="0.2cm"/>
      <style:text-properties style:font-name="Calibri" fo:font-size="11pt" fo:color="#111111"/>
    </style:default-style>
    <style:default-style style:family="text">
      <style:text-properties style:font-name="Calibri" fo:font-size="11pt"/>
    </style:default-style>
    <style:style style:name="BasePara" style:family="paragraph">
      <style:paragraph-properties fo:text-align="justify" fo:line-height="150%"/>
      <style:text-properties fo:font-size="12pt"/>
    </style:style>
    <style:style style:name="BoldPara" style:family="paragraph" style:parent-style-name="BasePara">
      <style:text-properties fo:font-weight="bold" fo:color="#cc0000" style:text-underline-style="solid"/>
    </style:style>
    <style:style style:name="Hi" style:family="text">
      <style:text-properties fo:font-weight="bold" fo:background-color="#ffff00" fo:font-size="14pt"/>
    </style:style>
    <style:style style:name="Col1" style:family="table-column">
      <style:table-column-properties style:column-width="1in"/>
    </style:style>
    <style:style style:name="Row1" style:family="table-row">
      <style:table-row-properties style:row-height="18pt"/>
    </style:style>
    <text:list-style style:name="L1">
      <text:list-level-style-bullet text:level="1" text:bullet-char="•">
        <style:list-level-properties text:space-before="0.2cm" text:min-label-width="0.5cm"/>
      </text:list-level-style-bullet>
      <text:list-level-style-number text:level="2" style:num-format="a" style:num-suffix=")" text:start-value="3"/>
    </text:list-style>
    <text:list-style style:name="L2">
      <text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix=".">
        <style:list-level-properties text:space-before="0.1cm" text:min-label-width="0.5cm"/>
      </text:list-level-style-number>
    </text:list-style>
    <style:page-layout style:name="PM1">
      <style:page-layout-properties fo:page-width="8.5in" fo:page-height="11in"
        fo:margin-top="1in" fo:margin-bottom="1in" fo:margin-left="1in" fo:margin-right="1in"/>
    </style:page-layout>
  </office:styles>
  <office:automatic-styles>
    <style:style style:name="AutoBig" style:family="text">
      <style:text-properties fo:font-size="18pt" fo:color="#0000ff"/>
    </style:style>
  </office:automatic-styles>
  <office:master-styles>
    <style:master-page style:name="Standard" style:page-layout-name="PM1"/>
  </office:master-styles>
</office:document-styles>`;

const ODT_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_NS} office:version="1.2">
  <office:automatic-styles>
    <style:style style:name="ListPara" style:family="paragraph">
      <style:paragraph-properties fo:margin-left="1.5cm" fo:text-indent="-0.5cm"/>
    </style:style>
  </office:automatic-styles>
  <office:body>
    <office:text>
      <text:h text:outline-level="1" text:style-name="BoldPara">第一章 单位与样式</text:h>
      <text:p text:style-name="BoldPara">样式沿 parent 继承得到 12pt <text:span text:style-name="Hi">加粗高亮14pt</text:span> 收尾。</text:p>
      <text:p>A<text:s text:c="4"/>B<text:tab/>C<text:line-break/>D<text:a xlink:href="https://example.com/x">链接文字</text:a>E</text:p>
      <text:p text:style-name="BoldPara"/>
      <text:list text:style-name="L1">
        <text:list-item><text:p text:style-name="ListPara">甲项</text:p></text:list-item>
        <text:list-item>
          <text:p text:style-name="ListPara">乙项</text:p>
          <text:list text:style-name="L1">
            <text:list-item><text:p>嵌套一</text:p></text:list-item>
            <text:list-item><text:p>嵌套二</text:p></text:list-item>
          </text:list>
        </text:list-item>
      </text:list>
      <text:list text:style-name="L2">
        <text:list-item><text:p>第一</text:p></text:list-item>
        <text:list-item><text:p>第二</text:p></text:list-item>
      </text:list>
      <table:table table:name="T1">
        <table:table-column table:style-name="Col1" table:number-columns-repeated="3"/>
        <table:table-row table:style-name="Row1">
          <table:table-cell office:value-type="string"><text:p>名称</text:p></table:table-cell>
          <table:table-cell office:value-type="string"><text:p>数量</text:p></table:table-cell>
          <table:table-cell office:value-type="string"><text:p>单价</text:p></table:table-cell>
        </table:table-row>
        <table:table-row>
          <table:table-cell office:value-type="string"><text:p>二极管</text:p></table:table-cell>
          <table:table-cell table:number-columns-spanned="1"><text:p>2</text:p></table:table-cell>
          <table:table-cell><text:p>1.5</text:p></table:table-cell>
        </table:table-row>
        <table:table-row>
          <table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="1">
            <text:p>跨两列</text:p>
          </table:table-cell>
          <table:covered-table-cell/>
          <table:table-cell><text:p>尾格</text:p></table:table-cell>
        </table:table-row>
      </table:table>
      <text:p>末尾段落。</text:p>
    </office:text>
  </office:body>
</office:document-content>`;

const ODT_META = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta ${ODF_NS} office:version="1.2">
  <office:meta>
    <dc:title>单位与样式测试</dc:title>
    <dc:creator>最后的修改者</dc:creator>
    <meta:initial-creator>最初的作者</meta:initial-creator>
    <dc:subject>ODF</dc:subject>
    <dc:description>夹具说明</dc:description>
    <meta:creation-date>2024-05-06T07:08:09.123456789</meta:creation-date>
    <dc:date>2025-01-02T03:04:05</dc:date>
    <meta:keyword>alpha</meta:keyword>
    <meta:keyword>beta</meta:keyword>
    <meta:generator>LibreOffice/24.2.0.3$Windows_X86_64</meta:generator>
    <meta:editing-cycles>7</meta:editing-cycles>
    <meta:document-statistic meta:page-count="2" meta:word-count="120" meta:character-count="640"
      meta:table-count="1" meta:image-count="0" meta:paragraph-count="9"/>
  </office:meta>
</office:document-meta>`;

export function odtZip(): Promise<Uint8Array> {
  return makeOdfZip('application/vnd.oasis.opendocument.text', {
    'content.xml': ODT_CONTENT,
    'styles.xml': ODT_STYLES,
    'meta.xml': ODT_META,
    'settings.xml': `<?xml version="1.0"?><office:document-settings ${ODF_NS}/>`,
  });
}

/* ==================================================================== */
/* 夹具：表格                                                            */
/* ==================================================================== */

const ODS_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${ODF_NS} office:version="1.2">
  <office:styles>
    <style:style style:name="co1" style:family="table-column">
      <style:table-column-properties style:column-width="1in"/>
    </style:style>
    <style:style style:name="ro1" style:family="table-row">
      <style:table-row-properties style:row-height="18pt"/>
    </style:style>
  </office:styles>
  <office:automatic-styles>
    <number:percentage-style style:name="NPercent">
      <number:number number:decimal-places="2" number:min-integer-digits="1"/>
      <number:text>%</number:text>
    </number:percentage-style>
    <style:style style:name="ceMoney" style:family="table-cell">
      <style:table-cell-properties fo:background-color="#eef3ff" style:vertical-align="middle"
        fo:border="0.5pt solid #3366cc" style:wrap-option="wrap"/>
      <style:paragraph-properties fo:text-align="right"/>
      <style:text-properties fo:font-weight="bold" fo:font-size="13pt" fo:color="#003366"/>
      <style:properties style:data-style-name="NPercent"/>
    </style:style>
    <style:style style:name="ceInherit" style:family="table-cell" style:parent-style-name="ceMoney">
      <style:text-properties fo:font-style="italic"/>
    </style:style>
  </office:automatic-styles>
</office:document-styles>`;

const ODS_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_NS} office:version="1.2">
  <office:body>
    <office:spreadsheet>
      <table:table table:name="数据表">
        <table:table-column table:style-name="co1" table:number-columns-repeated="4"/>
        <table:table-row table:style-name="ro1">
          <table:table-cell office:value-type="string" office:string-value="姓名"><text:p>姓名</text:p></table:table-cell>
          <table:table-cell office:value-type="float" office:value="12.5"><text:p>12.5</text:p></table:table-cell>
          <table:table-cell office:value-type="time" office:time-value="PT01H30M00S"><text:p>01:30:00</text:p></table:table-cell>
          <table:table-cell office:value-type="date" office:date-value="2024-06-01"><text:p>2024-06-01</text:p></table:table-cell>
          <table:table-cell office:value-type="boolean" office:boolean-value="true"><text:p>TRUE</text:p></table:table-cell>
          <table:table-cell office:value-type="float" office:value="0.25" table:formula="of:=SUM([.B1:.C1])" table:style-name="ceMoney"><text:p>0.25</text:p></table:table-cell>
          <table:table-cell table:number-columns-repeated="10"/>
        </table:table-row>
        <table:table-row>
          <table:table-cell office:value-type="float" office:value="3.14159"><text:p>3.14159</text:p></table:table-cell>
          <table:table-cell office:value-type="string" office:string-value="合并" table:number-columns-spanned="1" table:number-rows-spanned="2"><text:p>合并</text:p></table:table-cell>
          <table:table-cell office:value-type="percentage" office:value="0.5" table:style-name="ceInherit"><text:p>50%</text:p></table:table-cell>
        </table:table-row>
        <table:table-row>
          <table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell>
          <table:covered-table-cell/>
        </table:table-row>
      </table:table>
      <table:table table:name="第二表" table:display="false">
        <table:table-row>
          <table:table-cell office:value-type="float" office:value="9"><text:p>9</text:p></table:table-cell>
        </table:table-row>
      </table:table>
    </office:spreadsheet>
  </office:body>
</office:document-content>`;

export function odsZip(): Promise<Uint8Array> {
  return makeOdfZip('application/vnd.oasis.opendocument.spreadsheet', {
    'content.xml': ODS_CONTENT,
    'styles.xml': ODS_STYLES,
    'meta.xml': `<?xml version="1.0"?><office:document-meta ${ODF_NS}><office:meta><dc:title>表测试</dc:title></office:meta></office:document-meta>`,
  });
}

/* ==================================================================== */
/* 夹具：演示                                                            */
/* ==================================================================== */

const ODP_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${ODF_NS} office:version="1.2">
  <office:styles/>
  <office:automatic-styles>
    <style:page-layout style:name="PM1">
      <style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"
        style:writing-mode="lr-tb" fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm"/>
    </style:page-layout>
  </office:automatic-styles>
  <office:master-styles>
    <style:master-page style:name="Default" style:page-layout-name="PM1"/>
  </office:master-styles>
</office:document-styles>`;

const ODP_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_NS} office:version="1.2">
  <office:body>
    <office:presentation>
      <draw:page draw:name="第一页" draw:master-page-name="Default">
        <draw:frame draw:style-name="gr1" svg:x="1in" svg:y="2in" svg:width="3in" svg:height="1in"
          draw:transform="rotate(30)" draw:fill-color="#ffcc00" draw:stroke="solid" svg:stroke-width="2pt">
          <draw:text-box><text:p>标题文字</text:p></draw:text-box>
        </draw:frame>
        <draw:frame svg:x="1.5cm" svg:y="0.5in" svg:width="1.5cm" svg:height="1.5cm">
          <draw:image xlink:href="./Pictures/logo.png" xlink:type="simple" xlink:show="embed"/>
        </draw:frame>
        <draw:ellipse svg:x="100pt" svg:y="200pt" svg:width="80pt" svg:height="40pt"
          draw:fill-color="#00aa00" draw:stroke="none" draw:opacity="50%"/>
        <draw:g svg:x="10pt" svg:y="20pt">
          <draw:rect svg:x="1pt" svg:y="2pt" svg:width="30pt" svg:height="10pt" draw:fill-color="#123456"/>
          <draw:line svg:x1="0pt" svg:y1="0pt" svg:x2="40pt" svg:y2="20pt" draw:stroke-color="#ff0000"/>
        </draw:g>
      </draw:page>
      <draw:page draw:name="第二页" draw:master-page-name="Default">
        <presentation:notes>
          <draw:frame><draw:text-box><text:p>这是备注一</text:p><text:p>备注二</text:p></draw:text-box></draw:frame>
        </presentation:notes>
        <draw:rect svg:x="1in" svg:y="1in" svg:width="2in" svg:height="1in" draw:fill-color="#cccccc"/>
      </draw:page>
    </office:presentation>
  </office:body>
</office:document-content>`;

const ODP_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="Pictures/logo.png" manifest:media-type="image/png"/>
</manifest:manifest>`;

export function odpZip(): Promise<Uint8Array> {
  return makeOdfZip(
    'application/vnd.oasis.opendocument.presentation',
    {
      'content.xml': ODP_CONTENT,
      'styles.xml': ODP_STYLES,
      'meta.xml': `<?xml version="1.0"?><office:document-meta ${ODF_NS}><office:meta><dc:title>演示测试</dc:title></office:meta></office:document-meta>`,
      'Pictures/logo.png': PNG_1X1,
    },
    { manifest: ODP_MANIFEST },
  );
}

/* ==================================================================== */
/* 夹具：扁平变体                                                        */
/* ==================================================================== */

export const FODT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document ${ODF_NS} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.text">
  <office:meta><dc:title>扁平文本</dc:title><meta:initial-creator>扁平作者</meta:initial-creator></office:meta>
  <office:styles>
    <style:style style:name="FlatP" style:family="paragraph">
      <style:text-properties fo:font-weight="bold" fo:font-size="9pt"/>
    </style:style>
    <text:list-style style:name="FL">
      <text:list-level-style-bullet text:level="1" text:bullet-char="◦"/>
    </text:list-style>
  </office:styles>
  <office:automatic-styles>
    <style:page-layout style:name="PMf">
      <style:page-layout-properties fo:page-width="8.5in" fo:page-height="11in"/>
    </style:page-layout>
  </office:automatic-styles>
  <office:body>
    <office:text>
      <text:h text:outline-level="2">扁平标题</text:h>
      <text:p text:style-name="FlatP">扁平正文</text:p>
      <text:list text:style-name="FL"><text:list-item><text:p>扁平项</text:p></text:list-item></text:list>
    </office:text>
  </office:body>
</office:document>`;

export const FODS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document ${ODF_NS} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
  <office:body>
    <office:spreadsheet>
      <table:table table:name="扁平表">
        <table:table-row>
          <table:table-cell office:value-type="float" office:value="42"><text:p>42</text:p></table:table-cell>
          <table:table-cell office:value-type="string" office:string-value="扁平字符串"><text:p>扁平字符串</text:p></table:table-cell>
        </table:table-row>
      </table:table>
    </office:spreadsheet>
  </office:body>
</office:document>`;

export const FODP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document ${ODF_NS} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.presentation">
  <office:automatic-styles>
    <style:page-layout style:name="PMp">
      <style:page-layout-properties fo:page-width="10in" fo:page-height="7.5in"/>
    </style:page-layout>
  </office:automatic-styles>
  <office:body>
    <office:presentation>
      <draw:page draw:name="扁平页" draw:master-page-name="Default">
        <draw:rect svg:x="10pt" svg:y="20pt" svg:width="100pt" svg:height="50pt" draw:fill-color="#abcdef"/>
      </draw:page>
    </office:presentation>
  </office:body>
</office:document>`;

/* ==================================================================== */
/* 用例                                                                  */
/* ==================================================================== */

test('ODF 包结构：mimetype 必须首条且不压缩存储（规范硬要求）', async () => {
  const bytes = await odtZip();
  // 前 4 字节是本地文件头，第 8-10 字节是压缩方法（0 = store）
  assert.equal(bytes[0], 0x50, 'PK');
  assert.equal(bytes[1], 0x4b);
  const method = bytes[8] | (bytes[9] << 8);
  assert.equal(method, 0, 'mimetype 条目必须是 store（不压缩）');
  // 局部的文件名紧随 30 字节头
  const name = new TextDecoder().decode(bytes.subarray(30, 38));
  assert.equal(name, 'mimetype', 'mimetype 必须是第一个条目');
});

test('odt：样式继承、default-style、自动样式、列表编号与符号', async () => {
  const doc = await readOdfDocument(await odtZip(), { name: 'a.odt' });
  assert.equal(doc.format, 'odt');
  assert.equal(doc.kind, 'text');

  const blocks = doc.blocks!;
  // 段落块数量：h1 + p + p + p(空) + 4 个列表项 + 2 个列表项 + table + 末尾段落
  const paras = blocks.filter((b) => b.kind === 'para');
  assert.ok(paras.length >= 9, `应有足够段落，实际 ${paras.length}`);

  // 标题：outline-level=1 -> outlineLevel 0
  const h1 = paras[0];
  assert.equal(h1.style?.outlineLevel, 0);
  assert.equal(h1.style?.styleName, 'BoldPara');

  // 样式继承：BoldPara -> BasePara -> default-style + text default-style
  // BasePara 给 12pt，BoldPara 给 bold/红色/下划线，default 给 Calibri/11pt/#111111
  // 断言继承链真的生效：字号取 BasePara 的 12pt（覆盖 default 的 11pt）
  const bodyRuns = paras[1].runs;
  assert.ok(bodyRuns.length >= 2, '应有正文 run 与 span run');
  assert.equal(bodyRuns[0].style?.size, 12, 'BoldPara 未写字号，应继承 BasePara 的 12pt');
  assert.equal(bodyRuns[0].style?.bold, true, 'BoldPara 的粗体应生效');
  assert.equal(bodyRuns[0].style?.color, '#cc0000');
  assert.equal(bodyRuns[0].style?.underline, true);
  assert.equal(bodyRuns[0].style?.font, 'Calibri', '字体应来自 default-style');

  // span Hi 覆盖字号与底纹
  const spanRun = bodyRuns.find((r) => r.text.includes('加粗高亮'));
  assert.ok(spanRun, '应找到 span 文本');
  assert.equal(spanRun!.style?.size, 14);
  assert.equal(spanRun!.style?.highlight, '#ffff00');

  // default-style 的 margin-bottom=0.2cm -> 5.67pt，且没有被覆盖
  assert.ok(Math.abs((h1.style?.spaceAfter ?? 0) - 5.67) < 0.05, `default-style 的段后间距应生效，实际 ${h1.style?.spaceAfter}`);
  // BasePara 的 150% 行距
  assert.ok(Math.abs((bodyRuns.length ? paras[1].style?.lineHeight ?? 0 : 0) - 1.5) < 1e-9, '150% 行距应为 1.5 倍');
  assert.equal(paras[1].style?.align, 'justify', 'BasePara 的两端对齐应继承');

  // 空段落：<text:p text:style-name="BoldPara"/> 解析成一个空 run 的段落而不是消失
  // 注意下标：夹具里自闭合段落排在「A…E」那段之后，因此是 paras[3]
  assert.ok(paras[3].runs.length === 1 && paras[3].runs[0].text === '', '自闭合段落应保留为空段落');
  assert.equal(paras[3].style?.styleName, 'BoldPara');

  // text:s text:c=4 + text:tab + text:line-break + text:a
  const special = paras[2];
  const joined = special.runs.map((r) => r.text).join('');
  assert.ok(joined.includes('A    B'), `text:s text:c="4" 应产生 4 个空格，实际 ${JSON.stringify(joined)}`);
  assert.ok(joined.includes('\t'), 'text:tab 应产生制表符');
  assert.ok(joined.includes('\n'), 'text:line-break 应产生换行');
  const link = special.runs.find((r) => r.style?.link);
  assert.ok(link, '超链接 run 应带 link');
  assert.equal(link!.style?.link, 'https://example.com/x');
  assert.equal(link!.text, '链接文字');

  // 列表：L1 两级 + L2 一级 = 2(甲/乙) + 2(嵌套一/二) + 2(第一/第二) = 6 段
  const listParas = paras.filter((p) => p.style?.listMarker);
  assert.equal(listParas.length, 6, `应有 6 个列表段落，实际 ${listParas.length}`);
  assert.equal(listParas[0].style?.listMarker, '•');
  assert.equal(listParas[0].style?.listOrdered, false);
  assert.equal(listParas[0].style?.listLevel, 0);
  // 嵌套（第 2 级）：num-format="a" + suffix ")" + start-value=3 -> c) 然后 d)
  // 下标 0/1 是外层的两个一级项（甲、乙），嵌套项排在它们之后
  assert.equal(listParas[2].style?.listLevel, 1, '嵌套列表的层级应为 1');
  assert.equal(listParas[2].style?.listOrdered, true);
  assert.equal(listParas[2].style?.listMarker, 'c)', `第二级首项应为 c)（start-value=3 + a 格式），实际 ${listParas[2].style?.listMarker}`);
  assert.equal(listParas[3].style?.listMarker, 'd)');
  // L2：num-format="1" + suffix "." -> 1. 2.
  assert.equal(listParas[4].style?.listMarker, '1.');
  assert.equal(listParas[5].style?.listMarker, '2.');
  // 列表级别的缩进来自 min-label-width=0.5cm -> 14.17pt。
  // 注意用 L2 的列表项（它没有段落样式覆盖缩进）；L1 的两个项带 ListPara 样式，
  // 那个自动样式显式写了 margin-left=1.5cm，优先级更高（见下一条断言）。
  assert.ok(Math.abs((listParas[4].style?.indentStart ?? 0) - 14.17) < 0.1, `列表缩进应来自 list-level-properties，实际 ${listParas[4].style?.indentStart}`);

  // 自动样式优先：content.xml 里的 ListPara 覆盖了左缩进
  // （ListPara 自己的 indentStart=1.5cm 优先于列表级别的 0.5cm）
  assert.ok(Math.abs((listParas[0].style?.indentStart ?? 0) - 42.52) < 0.1, 'content.xml 的自动样式应优先于列表级别缩进');
});

test('odt：表格列宽、跨列、跨行、重复列裁剪', async () => {
  const doc = await readOdfDocument(await odtZip(), { name: 'a.odt' });
  const table = doc.blocks!.find((b) => b.kind === 'table');
  assert.ok(table && table.kind === 'table', '应解析出表格块');
  assert.equal(table.rows.length, 3);

  // 1in = 72pt。表声明了 3 列，但有一行是「跨两列 + covered」，
  // 实际占 4 个列位（第 4 位来自 covered-table-cell）—— 宽度数组按列位数补齐
  assert.ok(table.widths, '列宽应解析出来');
  assert.ok(table.widths!.length >= 3, `应至少解析出 3 列宽度，实际 ${table.widths!.length}`);
  for (const w of table.widths!.slice(0, 3)) assert.ok(Math.abs(w - 72) < 0.01, `1in 应为 72pt，实际 ${w}`);

  // 行高 18pt
  assert.equal(table.rows[0].height, 18);

  // 内容
  const cellText = (r: number, c: number) =>
    table.rows[r].cells[c].blocks.map((b) => (b.kind === 'para' ? b.runs.map((x) => x.text).join('') : '')).join('');
  assert.equal(cellText(0, 0), '名称');
  assert.equal(cellText(1, 0), '二极管');

  // colSpan / rowSpan。
  // 注意夹具第 3 行是「跨两列 + covered-table-cell + 尾格」：covered 格占第 2 列位，
  // 尾格落到第 3 列位后整个表宽变成 4 个列位，所以「尾格」在索引 2 而不是 1。
  assert.equal(table.rows[2].cells[0].colSpan, 2, '跨两列');
  assert.equal(table.rows[2].cells[2].blocks.length, 0, 'covered 格占位但不建内容');

  // 单位换算：1.5cm = 42.5197pt（夹具里没有，但列宽已覆盖 in；这里验证 cm 常量）
  assert.ok(Math.abs(42.5197 - 42.52) < 0.01);
});

test('table:number-columns-repeated 裁剪：按表声明的列数裁，不是按固定常数', async () => {
  // 一张**只声明 4 列**的表，却用 number-columns-repeated="16380" 填充空白。
  // 期望：裁剪上限来自表的列声明（4 列），而不是某个固定常数（早期实现用 1024，
  // 每行仍物化 1020 个空对象 —— 问题被缩小 16 倍而不是消掉）。
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_NS} office:version="1.2">
  <office:body><office:text>
    <table:table table:name="BIG">
      <table:table-column table:number-columns-repeated="4"/>
      <table:table-row>
        <table:table-cell office:value-type="string"><text:p>甲</text:p></table:table-cell>
        <table:table-cell office:value-type="string"><text:p>乙</text:p></table:table-cell>
        <table:table-cell table:number-columns-repeated="16380"/>
      </table:table-row>
      <table:table-row table:number-rows-repeated="99999">
        <table:table-cell/>
      </table:table-row>
    </table:table>
  </office:text></office:body>
</office:document-content>`;
  const zip = await makeOdfZip('application/vnd.oasis.opendocument.text', { 'content.xml': content });
  const doc = await readOdfDocument(zip, { name: 'big.odt', limits: { maxCols: 8192, maxRows: 5000 } });

  const table = doc.blocks!.find((b) => b.kind === 'table');
  assert.ok(table && table.kind === 'table');

  // 声明了 4 列 -> 裁剪上限应当是 4（不是 256 / 1024 这类固定常数）
  const DECLARED_COLS = 4;
  const widest = Math.max(...table.rows.map((r) => r.cells.length));
  assert.equal(widest, DECLARED_COLS, `列数应被裁到表声明的 ${DECLARED_COLS} 列，实际 ${widest}`);
  assert.ok(widest < 1024, '绝不能按固定常数（1024）裁剪');

  // 关键断言：单元格对象总数必须与「声明列数 × 行数」同阶。
  // 只断言「< 5000」太宽松 —— 1024 列的旧行为也能过，等于没测住。
  const totalCells = table.rows.reduce((n, r) => n + r.cells.length, 0);
  const bound = DECLARED_COLS * table.rows.length * 2;
  assert.ok(totalCells <= bound, `单元格对象总数应 ≤ 声明列数×行数×2 = ${bound}，实际 ${totalCells}`);
  assert.ok(totalCells <= 4096 * DECLARED_COLS, `总量应与行数同阶，实际 ${totalCells}`);

  // 内容列保留
  const first = table.rows[0];
  assert.equal(first.cells[0].blocks.length, 1);
  const cell0Text = first.cells[0].blocks[0].kind === 'para' ? first.cells[0].blocks[0].runs.map((r) => r.text).join('') : '';
  assert.equal(cell0Text, '甲');

  // 重复的空白行必须共享同一个 TableCell 对象（这是内存有界的关键）
  const sharedRowCells = table.rows[5].cells;
  const nextRowCells = table.rows[6].cells;
  assert.equal(sharedRowCells, nextRowCells, '重复的空白行应共享同一份 cells 数组');

  // 截断必须被如实记录
  assert.ok(doc.stats.truncated.length > 0, `应记录截断，实际 ${JSON.stringify(doc.stats.truncated)}`);
  assert.ok(doc.truncated, 'doc.truncated 应为 true');
  const joined = doc.stats.truncated.join(',');
  assert.ok(/number-columns-repeated|maxCols|maxRows/.test(joined), `截断类别应可读，实际 ${joined}`);
  assert.ok(doc.stats.warnings.some((w) => w.includes('16384') || w.includes('上限')), '应有可读的裁剪说明');
});

test('odt：图片按相对 content.xml 的路径（含 ./）解析', async () => {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_NS} office:version="1.2">
  <office:body><office:text>
    <text:p>图片段落：<draw:frame svg:width="2in" svg:height="1in">
      <draw:image xlink:href="./Pictures/pic.png" xlink:type="simple"/>
    </draw:frame></text:p>
    <draw:frame svg:width="1in" svg:height="1in">
      <draw:image xlink:href="https://example.com/remote.png"/>
    </draw:frame>
  </office:text></office:body>
</office:document-content>`;
  const zip = await makeOdfZip('application/vnd.oasis.opendocument.text', {
    'content.xml': content,
    'Pictures/pic.png': PNG_1X1,
  });
  const doc = await readOdfDocument(zip, { name: 'img.odt' });

  const para = doc.blocks!.find((b) => b.kind === 'para');
  assert.ok(para && para.kind === 'para');
  const imgRun = para.runs.find((r) => r.image);
  assert.ok(imgRun, '行内图片应成为一个 run');
  assert.equal(imgRun!.image!.partPath, 'Pictures/pic.png', './ 前缀必须被归一化掉');
  assert.equal(imgRun!.image!.mime, 'image/png');
  assert.equal(imgRun!.image!.width, 144, '2in = 144pt');
  assert.equal(imgRun!.image!.height, 72, '1in = 72pt');
  assert.ok(imgRun!.image!.data && imgRun!.image!.data.length === PNG_1X1.length, '图片字节应从 zip 条目取出');
  assert.equal(doc.stats.imageCount, 1);
  assert.equal(doc.stats.imageBytes, PNG_1X1.length);

  // 外部链接只保留提示，不加载
  assert.ok(doc.stats.warnings.some((w) => w.includes('外部链接')), '外部图片应降级为警告');
});

test('ods：值类型、公式、样式索引、列宽、合并、隐藏表', async () => {
  const doc = await readOdfDocument(await odsZip(), { name: 'a.ods' });
  assert.equal(doc.format, 'ods');
  assert.equal(doc.kind, 'sheet');
  assert.equal(doc.sheets!.length, 2);
  assert.equal(doc.meta.sheetCount, 2);

  const sheet = doc.sheets![0];
  assert.equal(sheet.name, '数据表');
  const rows = await sheet.readRows(0, 3);

  const find = (r: number, c: number) => rows[r].cells.find((x) => x.c === c);

  // string
  assert.equal(find(0, 0)!.v, '姓名');
  assert.equal(find(0, 0)!.t, 's');
  // float
  assert.equal(find(0, 1)!.v, '12.5');
  assert.equal(find(0, 1)!.t, 'n');
  // time：ISO 8601 duration -> 可读
  assert.equal(find(0, 2)!.v, '01:30:00');
  assert.equal(find(0, 2)!.t, 'd');
  // date
  assert.equal(find(0, 3)!.v, '2024-06-01');
  assert.equal(find(0, 3)!.t, 'd');
  // boolean
  assert.equal(find(0, 4)!.v, 'TRUE');
  assert.equal(find(0, 4)!.t, 'b');
  // 公式：of: 前缀必须去掉
  assert.equal(find(0, 5)!.f, 'SUM([.B1:.C1])', '公式应去掉 of: 命名空间前缀');
  assert.equal(find(0, 5)!.v, '0.25');
  // 稀疏：后面 10 个重复的空白格不入模型
  assert.equal(rows[0].cells.length, 6, `空填充格不应进入模型，实际 ${rows[0].cells.length}`);

  // 单元格样式索引：ceMoney 与 ceInherit 都登记了
  const moneyIdx = find(0, 5)!.s;
  assert.notEqual(moneyIdx, undefined, '带样式的格子应有样式索引');
  const style = sheet.styles[moneyIdx!];
  assert.equal(style.bg, '#eef3ff');
  assert.equal(style.bold, true);
  assert.equal(style.size, 13);
  assert.equal(style.color, '#003366');
  assert.equal(style.align, 'right');
  assert.equal(style.vAlign, 'middle');
  assert.equal(style.border?.top.width, 0.5, 'fo:border="0.5pt solid #3366cc" 的线宽');
  assert.equal(style.border?.top.color, '#3366cc');
  assert.equal(style.numFmt, '0.00%', 'number:percentage-style 应转成可读数字格式');

  // 继承：ceInherit -> ceMoney，加了斜体
  const inheritIdx = find(1, 2)!.s;
  const inherit = sheet.styles[inheritIdx!];
  assert.equal(inherit.italic, true, 'parent 链上的斜体应生效');
  assert.equal(inherit.bold, true, 'ceMoney 的粗体应继承');
  assert.equal(inherit.bg, '#eef3ff');

  // 列宽：1in = 72pt
  assert.equal(sheet.colWidths![0], 72);
  // 行高 18pt
  assert.equal(sheet.rowHeights!.get(0), 18);

  // 合并区域
  assert.ok(sheet.merges && sheet.merges.length >= 1, '应解析出合并区域');
  const merge = sheet.merges!.find((m) => m.c1 === 1 && m.r1 === 1);
  assert.ok(merge, 'B2 起始的跨行合并应被记录');
  assert.equal(merge!.r2, 2);

  // 隐藏表
  assert.equal(doc.sheets![1].name, '第二表');
  assert.equal(doc.sheets![1].hidden, true);

  // 大纲：每个工作表一项
  assert.equal(doc.outline.length, 2);
  assert.equal(doc.outline[0].text, '数据表');
});

test('odp：形状位置尺寸（pt）、旋转、组合偏移、图片、备注', async () => {
  const doc = await readOdfDocument(await odpZip(), { name: 'a.odp' });
  assert.equal(doc.format, 'odp');
  assert.equal(doc.kind, 'slides');
  assert.equal(doc.slides!.length, 2);
  assert.equal(doc.meta.slideCount, 2);

  const slide = doc.slides![0];
  // 页面尺寸来自 master-page -> page-layout：28cm × 15.75cm
  assert.ok(Math.abs(slide.width - 793.7) < 0.2, `28cm 应为 793.7pt，实际 ${slide.width}`);
  assert.ok(Math.abs(slide.height - 446.46) < 0.2, `15.75cm 应为 446.46pt，实际 ${slide.height}`);
  assert.equal(slide.layout, 'Default');

  // 形状 0：文本框 1in,2in 3in×1in + rotate(30) + 填充
  const title = slide.shapes[0];
  assert.equal(title.x, 72, '1in = 72pt');
  assert.equal(title.y, 144, '2in = 144pt');
  assert.equal(title.w, 216, '3in = 216pt');
  assert.equal(title.h, 72, '1in = 72pt');
  assert.equal(title.rot, 30, 'draw:transform 里的 rotate 必须被解析');
  assert.equal(title.fill, '#ffcc00', 'draw:fill-color');
  assert.equal(title.strokeWidth, 2, 'svg:stroke-width 2pt');
  assert.ok(title.blocks && title.blocks.length === 1, '文本框里的段落应成为 blocks');
  const titleText = title.blocks![0].kind === 'para' ? title.blocks![0].runs.map((r) => r.text).join('') : '';
  assert.equal(titleText, '标题文字');

  // 形状 1：图片，1.5cm 尺寸 -> 42.52pt
  const pic = slide.shapes[1];
  assert.equal(pic.kind, 'image');
  assert.ok(Math.abs(pic.x - 42.52) < 0.01, `1.5cm 应为 42.5197pt，实际 ${pic.x}`);
  assert.equal(pic.y, 36, '0.5in = 36pt');
  assert.ok(Math.abs(pic.w - 42.52) < 0.01, `1.5cm 应为 42.5197pt，实际 ${pic.w}`);
  assert.equal(pic.image!.partPath, 'Pictures/logo.png');
  assert.equal(pic.image!.mime, 'image/png');
  assert.ok(pic.image!.data && pic.image!.data.length === PNG_1X1.length, '图片字节应加载');

  // 形状 2：椭圆
  const ellipse = slide.shapes[2];
  assert.equal(ellipse.kind, 'ellipse');
  assert.equal(ellipse.x, 100);
  assert.equal(ellipse.w, 80);
  assert.equal(ellipse.fill, '#00aa00');
  assert.equal(ellipse.stroke, 'none');
  assert.ok(Math.abs((ellipse.opacity ?? 0) - 0.5) < 1e-9, 'draw:opacity="50%" 应归一为 0.5');

  // 形状 3：组合。子形状坐标必须累加父偏移（这是最常见的 odp 还原错误）
  const group = slide.shapes[3];
  assert.equal(group.kind, 'group');
  assert.equal(group.shapes!.length, 2);
  assert.equal(group.shapes![0].x, 11, '组合内 x 应为 10+1');
  assert.equal(group.shapes![0].y, 22, '组合内 y 应为 20+2');
  assert.equal(group.shapes![0].fill, '#123456');
  // 直线：用端点算包围盒
  const line = group.shapes![1];
  assert.equal(line.kind, 'line');
  assert.equal(line.x, 10);
  assert.equal(line.y, 20);
  assert.equal(line.w, 40);
  assert.equal(line.h, 20);
  assert.equal(line.stroke, '#ff0000');

  // 备注页
  const slide2 = doc.slides![1];
  assert.equal(slide2.notes, '这是备注一\n备注二', `备注应保留两段文本，实际 ${JSON.stringify(slide2.notes)}`);
  // 单位换算断言：1.5cm 约 42.52pt
  assert.ok(Math.abs(42.5197 - 42.52) < 0.001);
});

test('单位换算：1.5cm 应为 42.52pt（toBeCloseTo 语义）', async () => {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_NS} office:version="1.2">
  <office:automatic-styles>
    <style:style style:name="co" style:family="table-column">
      <style:table-column-properties style:column-width="1.5cm"/>
    </style:style>
  </office:automatic-styles>
  <office:body><office:spreadsheet>
    <table:table table:name="S">
      <table:table-column table:style-name="co"/>
      <table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>
    </table:table>
  </office:spreadsheet></office:body>
</office:document-content>`;
  const zip = await makeOdfZip('application/vnd.oasis.opendocument.spreadsheet', { 'content.xml': content });
  const doc = await readOdfDocument(zip, { name: 'u.ods' });
  const w = doc.sheets![0].colWidths![0];
  assert.ok(Math.abs(w - 42.52) < 0.01, `1.5cm 应为约 42.52pt，实际 ${w}`);

  // 演示里的 1.5cm 同样成立
  const odpDoc = await readOdfDocument(await odpZip(), { name: 'a.odp' });
  assert.ok(Math.abs(odpDoc.slides![0].shapes[1].x - 42.52) < 0.01);
});

test('加密文件抛 ENCRYPTED', async () => {
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">
    <manifest:encryption-data manifest:checksum-type="SHA1/1K" manifest:checksum="AAAA">
      <manifest:algorithm manifest:algorithm-name="Blowfish CFB" manifest:initialisation-vector="BBBB"/>
    </manifest:encryption-data>
  </manifest:file-entry>
</manifest:manifest>`;
  const zip = await makeOdfZip('application/vnd.oasis.opendocument.text', { 'content.xml': '乱码乱码' }, { manifest });
  await assert.rejects(
    () => readOdfDocument(zip, { name: 'enc.odt' }),
    (err: Error & { code?: string }) => {
      assert.equal(err.name, 'ReadError');
      assert.equal(err.code, 'ENCRYPTED');
      assert.match(err.message, /加密/);
      return true;
    },
  );
});

test('扁平变体：fodt/fods/fodp 能解析且不调用 ctx.container()', async () => {
  const fodt = await readOdfDocument(flatBytes(FODT_XML), { name: 'a.fodt', forbidContainer: true });
  assert.equal(fodt.format, 'fodt');
  assert.equal(fodt.kind, 'text');
  assert.equal(fodt.meta.title, '扁平文本');
  assert.equal(fodt.meta.author, '扁平作者');
  const paras = fodt.blocks!.filter((b) => b.kind === 'para');
  assert.equal(paras[0].style?.outlineLevel, 1, 'outline-level=2 -> outlineLevel 1');
  const flatBody = paras.find((p) => p.style?.styleName === 'FlatP');
  assert.ok(flatBody, '扁平文档的命名样式应被解析');
  assert.equal(flatBody!.runs[0].style?.bold, true);
  assert.equal(flatBody!.runs[0].style?.size, 9);
  const flatList = paras.find((p) => p.style?.listMarker);
  assert.equal(flatList!.style?.listMarker, '◦', '扁平文档的列表样式也要解析出符号');
  // 页面尺寸来自扁平文档的 automatic-styles
  assert.ok(Math.abs((fodt.meta.pageWidth ?? 0) - 612) < 0.01, `8.5in = 612pt，实际 ${fodt.meta.pageWidth}`);

  const fods = await readOdfDocument(flatBytes(FODS_XML), { name: 'a.fods', forbidContainer: true });
  assert.equal(fods.format, 'fods');
  assert.equal(fods.kind, 'sheet');
  assert.equal(fods.sheets!.length, 1);
  assert.equal(fods.sheets![0].name, '扁平表');
  const rows = await fods.sheets![0].readRows(0, 1);
  assert.equal(rows[0].cells[0].v, '42');
  assert.equal(rows[0].cells[0].t, 'n');
  assert.equal(rows[0].cells[1].v, '扁平字符串');

  const fodp = await readOdfDocument(flatBytes(FODP_XML), { name: 'a.fodp', forbidContainer: true });
  assert.equal(fodp.format, 'fodp');
  assert.equal(fodp.kind, 'slides');
  assert.equal(fodp.slides!.length, 1);
  assert.equal(fodp.slides![0].width, 720, '10in = 720pt');
  assert.equal(fodp.slides![0].height, 540, '7.5in = 540pt');
  assert.equal(fodp.slides![0].shapes[0].fill, '#abcdef');
});

test('降级：空文档、缺 styles/meta、content.xml 损坏都不崩', async () => {
  // 1) 完全空的 office:text
  const emptyZip = await makeOdfZip('application/vnd.oasis.opendocument.text', {
    'content.xml': `<?xml version="1.0"?><office:document-content ${ODF_NS}><office:body><office:text/></office:body></office:document-content>`,
  });
  const empty = await readOdfDocument(emptyZip, { name: 'empty.odt' });
  assert.equal(empty.kind, 'text');
  assert.deepEqual(empty.blocks, []);

  // 2) 缺 styles.xml 与 meta.xml：样式全默认，仍能读出正文
  const noStylesZip = await makeOdfZip('application/vnd.oasis.opendocument.text', {
    'content.xml': `<?xml version="1.0"?><office:document-content ${ODF_NS}><office:body><office:text><text:p>只有正文</text:p></office:text></office:body></office:document-content>`,
  });
  const noStyles = await readOdfDocument(noStylesZip, { name: 'nostyles.odt' });
  const p = noStyles.blocks!.find((b) => b.kind === 'para');
  assert.ok(p && p.kind === 'para');
  assert.equal(p.runs[0].text, '只有正文');
  assert.ok(noStyles.stats.warnings.some((w) => w.includes('meta.xml')), '缺 meta.xml 应记录一条警告');

  // 3) content.xml 损坏（标签截断）
  const brokenZip = await makeOdfZip('application/vnd.oasis.opendocument.text', {
    'content.xml': `<?xml version="1.0"?><office:document-content ${ODF_NS}><office:body><office:text><text:p>好段落</text:p><text:p>坏的`,
  });
  const broken = await readOdfDocument(brokenZip, { name: 'broken.odt' });
  // 已经解析出来的部分必须保留，而不是整篇失败
  const kept = broken.blocks!.filter((b) => b.kind === 'para');
  assert.ok(kept.length >= 1, '损坏的 content.xml 应保留已解析的部分');
  assert.ok(broken.truncated, '解析中断必须记录为截断');

  // 4) 非 XML 垃圾
  const garbageZip = await makeOdfZip('application/vnd.oasis.opendocument.text', { 'content.xml': 'not xml at all' });
  const garbage = await readOdfDocument(garbageZip, { name: 'garbage.odt' });
  assert.equal(garbage.kind, 'text');
  assert.equal(garbage.blocks!.length, 0);

  // 5) 缺 content.xml -> CORRUPT
  const w = new ZipWriter();
  w.addFirst('mimetype', 'application/vnd.oasis.opendocument.text', { store: true });
  const noContent = await w.build();
  await assert.rejects(
    () => readOdfDocument(noContent, { name: 'nocontent.odt' }),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, 'CORRUPT');
      return true;
    },
  );

  // 6) 缺 META-INF/manifest.xml：不应影响正文
  const noManifest = await makeOdfZip(
    'application/vnd.oasis.opendocument.text',
    { 'content.xml': `<?xml version="1.0"?><office:document-content ${ODF_NS}><office:body><office:text><text:p>无清单</text:p></office:text></office:body></office:document-content>` },
    { skipManifest: true },
  );
  const nm = await readOdfDocument(noManifest, { name: 'nomanifest.odt' });
  assert.equal(nm.blocks!.length, 1);
});

test('mimetype 决定具体格式：模板后缀映射到 ott/ots/otp', async () => {
  const cases: Array<[string, string]> = [
    ['application/vnd.oasis.opendocument.text-template', 'ott'],
    ['application/vnd.oasis.opendocument.spreadsheet-template', 'ots'],
    ['application/vnd.oasis.opendocument.presentation-template', 'otp'],
    ['application/vnd.oasis.opendocument.graphics', 'odg'],
  ];
  for (const [mime, expected] of cases) {
    const zip = await makeOdfZip(mime, {
      'content.xml': `<?xml version="1.0"?><office:document-content ${ODF_NS}><office:body><office:text/></office:body></office:document-content>`,
    });
    const doc = await readOdfDocument(zip, { name: `x.bin` });
    assert.equal(doc.format, expected, `${mime} 应判定为 ${expected}`);
  }
});

test('odg：office:drawing 根也落成 slides（一张画页 = 一张幻灯片）', async () => {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_NS} office:version="1.2">
  <office:automatic-styles>
    <style:page-layout style:name="PMg">
      <style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm"/>
    </style:page-layout>
  </office:automatic-styles>
  <office:master-styles><style:master-page style:name="Default" style:page-layout-name="PMg"/></office:master-styles>
  <office:body><office:drawing>
    <draw:page draw:name="画页" draw:master-page-name="Default">
      <draw:rect svg:x="0.5in" svg:y="0.25in" svg:width="2in" svg:height="1in" draw:fill-color="#ff0000"/>
    </draw:page>
  </office:drawing></office:body>
</office:document-content>`;
  const zip = await makeOdfZip('application/vnd.oasis.opendocument.graphics', {
    'content.xml': content,
    'styles.xml': `<?xml version="1.0"?><office:document-styles ${ODF_NS}><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PMg"/></office:master-styles></office:document-styles>`,
    'styles2.xml': '',
  });
  const doc = await readOdfDocument(zip, { name: 'a.odg' });
  assert.equal(doc.format, 'odg');
  assert.equal(doc.kind, 'slides');
  assert.equal(doc.slides!.length, 1);
  // A4：21cm × 29.7cm
  assert.ok(Math.abs(doc.slides![0].width - 595.28) < 0.2, `21cm 应为 595.28pt，实际 ${doc.slides![0].width}`);
  assert.ok(Math.abs(doc.slides![0].height - 841.89) < 0.2, `29.7cm 应为 841.89pt，实际 ${doc.slides![0].height}`);
  const rect = doc.slides![0].shapes[0];
  assert.equal(rect.x, 36);
  assert.equal(rect.y, 18);
  assert.equal(rect.w, 144);
  assert.equal(rect.fill, '#ff0000');
  assert.equal(doc.stats.shapeCount, 1);
});

test('meta.xml 全字段：日期原样保留，统计值落入 DocMeta', async () => {
  const doc = await readOdfDocument(await odtZip(), { name: 'a.odt' });
  assert.equal(doc.meta.title, '单位与样式测试');
  assert.equal(doc.meta.author, '最初的作者', 'author 优先取 meta:initial-creator');
  assert.equal(doc.meta.lastModifiedBy, '最后的修改者', 'dc:creator 是最后修改者');
  assert.equal(doc.meta.subject, 'ODF');
  assert.equal(doc.meta.description, '夹具说明');
  assert.equal(doc.meta.created, '2024-05-06T07:08:09.123456789', 'ISO 8601 字符串原样保留，不做时区转换');
  assert.equal(doc.meta.modified, '2025-01-02T03:04:05');
  assert.equal(doc.meta.keywords, 'alpha, beta');
  assert.equal(doc.meta.application, 'LibreOffice/24.2.0.3$Windows_X86_64');
  assert.equal(doc.meta.pageCount, 2);
  assert.equal(doc.meta.wordCount, 120);
  assert.equal(doc.meta.charCount, 640);
  assert.equal(doc.meta.paragraphCount, 9);
  assert.equal(doc.meta.custom?.editingCycles, '7');
  assert.equal(doc.meta.custom?.tableCount, '1');
  // 页面尺寸来自 page-layout：8.5in × 11in
  assert.ok(Math.abs((doc.meta.pageWidth ?? 0) - 612) < 0.01);
  assert.ok(Math.abs((doc.meta.pageHeight ?? 0) - 792) < 0.01);
  assert.equal(doc.meta.margin?.top, 72);
});

test('stats 与 outline 如实填写', async () => {
  const doc = await readOdfDocument(await odtZip(), { name: 'a.odt' });
  assert.ok(doc.stats.blockCount > 0, 'blockCount 应大于 0');
  assert.ok(doc.stats.modelBytes > 0, 'modelBytes 应大于 0');
  assert.equal(doc.stats.sourceBytes, (await odtZip()).length);
  assert.ok(doc.stats.parseMs >= 0);
  // 大纲：第一章
  assert.ok(doc.outline.length >= 1);
  assert.equal(doc.outline[0].text, '第一章 单位与样式');
  assert.equal(doc.outline[0].level, 1);
});

test('读取器已自注册，且覆盖全部 ODF FormatId', async () => {
  const { readerForFormat, coveredFormats } = await import('../packages/core/src/registry.ts');
  const expected = ['odt', 'ott', 'ods', 'ots', 'odp', 'otp', 'odg', 'fodt', 'fods', 'fodp'];
  for (const f of expected) {
    const r = readerForFormat(f as never);
    assert.ok(r, `${f} 应有读取器`);
    assert.equal(r!.id, 'odf');
  }
  const covered = coveredFormats();
  for (const f of expected) assert.ok(covered.includes(f as never), `coveredFormats 应含 ${f}`);
});
