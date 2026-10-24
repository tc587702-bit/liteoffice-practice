/**
 * @liteoffice/format-docx 读取器验证。
 *
 * A. 自造夹具（ZipWriter）—— 覆盖精确断言：样式继承、编号计数递增、表格合并、
 *    超链接、修订、xml:space 保留、主题色、页边距单位换算、字段、图片、页眉页脚、脚注。
 *    自造夹具的好处是可以把每个子特性单独摆出来断言到具体数值，而且不依赖外部文件。
 * B. 工作区里**真实 Word 生成的文件** —— 交叉验证保真度（这些文件才是真正的裁判）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ZipWriter } from '../packages/zip/src/index.ts';
import { ZipReader } from '../packages/zip/src/index.ts';
import {
  LimitGuard,
  blocksToText,
  countWords,
  formatSpec,
  paraText,
  readerForFormat,
  withLimits,
} from '../packages/core/src/index.ts';
import type { Block, LiteDocument, Limits, Paragraph, Run, Table } from '../packages/core/src/index.ts';
import type { ContainerAccess, ReadContext } from '../packages/core/src/registry.ts';
// 导入即自注册（本包的 src/index.ts 顶层调用 registerReader）
import { docxReader, hyperlinkTargetOf, fieldPlaceholder, imageSizePx } from '../packages/format-docx/src/index.ts';

const WORKSPACE = 'C:\\deepseekharness';

/* ==================================================================== */
/* 夹具                                                                  */
/* ==================================================================== */

/** 1x1 的合法 PNG（内禀尺寸 1x1），用来验证图片字节/MIME/内禀尺寸兜底。 */
const PNG_1x1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const MAIN_CT = {
  document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  macro: 'application/vnd.ms-word.document.macroEnabled.main+xml',
  template: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
};

/** ctKind='none' 时故意不给主部件写 Override：用于验证「扩展名兜底」路径。 */
const CONTENT_TYPES = (main: 'document' | 'macro' | 'template' | 'none' = 'document') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
${main === 'none' ? '' : `  <Override PartName="/word/document.xml" ContentType="${MAIN_CT[main]}"/>\n`}  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
  <!-- 故意放在非约定目录：验证「绝不硬编码 word/media」 -->
  <Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="embeddings/pic-a.bin"/>
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image3.png"/>
  <Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
  <Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/文档" TargetMode="External"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体"/><w:sz w:val="21"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/><w:color w:themeColor="accent1"/></w:rPr>
  </w:style>
  <w:style w:type="character" w:styleId="Hyperlink">
    <w:name w:val="Hyperlink"/><w:rPr><w:u w:val="single"/><w:color w:val="0000FF"/></w:rPr>
  </w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#61623;"/><w:rFonts w:ascii="Symbol"/>
      <w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>
      <w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Office">
  <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
  <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
  <a:dk2><a:srgbClr val="44546A"/></a:dk2>
  <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
  <a:accent1><a:srgbClr val="1F9E5A"/></a:accent1>
  <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
  <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
  <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
  <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
  <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
  <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
  <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme></a:themeElements></a:theme>`;

const CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
  <dcterms:created>2024-01-02T03:04:05Z</dcterms:created>
  <dc:creator>夹具作者</dc:creator>
  <cp:lastModifiedBy>最后修改者</cp:lastModifiedBy>
  <dcterms:modified>2024-05-06T07:08:09Z</dcterms:modified>
  <cp:keywords>轻办公,docx</cp:keywords>
  <dc:description>这是一个自造夹具</dc:description>
  <dc:subject>单元测试</dc:subject>
  <dc:title>夹具标题</dc:title>
</cp:coreProperties>`;

const APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>LiteOffice-Test</Application><AppVersion>1.2.3</AppVersion>
  <Pages>2</Pages><Words>33</Words><Characters>99</Characters>
  <Company>轻办公</Company><TotalTime>7</TotalTime>
</Properties>`;

const HEADER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页眉文字</w:t></w:r></w:p></w:hdr>`;

const FOOTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页脚文字</w:t></w:r></w:p></w:ftr>`;

const FOOTNOTES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="-1"><w:p><w:r><w:t>分隔符</w:t></w:r></w:p></w:footnote>
  <w:footnote w:id="0"><w:p><w:r><w:t>延续分隔符</w:t></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p><w:r><w:t>脚注正文内容</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;

const COMMENTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="1" w:author="审阅者"><w:p><w:r><w:t>批注内容</w:t></w:r></w:p></w:comment>
</w:comments>`;

const W_NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:v="urn:schemas-microsoft-com:vml"`;

/** DrawingML 内联图片（wp:extent 给 EMU 尺寸） */
function drawing(relId: string, cx: number, cy: number, name = '图片'): string {
  return `<w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="${name}" descr="替代文字"/>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
      <pic:nvPicPr><pic:cNvPr id="1" name="${name}"/></pic:nvPicPr>
      <pic:blipFill><a:blip r:embed="${relId}"/></pic:blipFill>
      <pic:spPr><a:xfrm><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr>
    </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}>
<w:body>
  <!-- 1. 样式继承：只写 pStyle，字号/粗体/大纲级别都来自 styles.xml -->
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题一</w:t></w:r></w:p>

  <!-- 2. xml:space="preserve" 的空格 + 制表符 + 换行 -->
  <w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">前 </w:t></w:r><w:r><w:t>后</w:t></w:r><w:r><w:tab/><w:t>制表</w:t></w:r><w:r><w:t>甲</w:t><w:br/><w:t>乙</w:t></w:r></w:p>

  <!-- 3. 有序列表：模板 %1. 必须按计数器递增 -->
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>有序一</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>有序二</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>有序三</w:t></w:r></w:p>
  <!-- 另一种 numId 的计数器必须独立 -->
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>符号项</w:t></w:r></w:p>

  <!-- 4. 主题色（只写 themeColor，真实值在 theme1.xml） -->
  <w:p><w:r><w:rPr><w:color w:themeColor="accent1"/></w:rPr><w:t>主题色文字</w:t></w:r></w:p>

  <!-- 5. 修订：w:del 丢弃，w:ins 保留 -->
  <w:p><w:r><w:t>前段</w:t></w:r><w:del><w:r><w:delText>这段已删除</w:delText></w:r></w:del><w:ins><w:r><w:t>插入的</w:t></w:r></w:ins><w:r><w:t>后段</w:t></w:r></w:p>

  <!-- 6. 关系式超链接 -->
  <w:p><w:hyperlink r:id="rIdLink"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>外部链接</w:t></w:r></w:hyperlink></w:p>

  <!-- 7. 复杂字段：PAGE 有结果，NUMPAGES 没有结果（需占位而不是漏出域代码） -->
  <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
  <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
  <w:p><w:fldSimple w:instr=" AUTHOR "><w:r><w:t>作者名</w:t></w:r></w:fldSimple></w:p>

  <!-- 8. 图片：DrawingML + VML + AlternateContent（同一对象两份描述，只算一次） -->
  <w:p><w:r>${drawing('rId7', 914400, 457200, '第一张')}</w:r></w:p>
  <w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps">${drawing('rId8', 1270000, 635000, '第二张')}</mc:Choice>
    <mc:Fallback><w:pict><v:shape id="s1" style="width:100pt;height:50pt"><v:imagedata r:id="rId8"/></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>
  <w:p><w:r><w:pict><v:shape id="s2"><v:imagedata r:id="rId9"/></v:shape></w:pict></w:r></w:p>

  <!-- 9. 脚注引用 -->
  <w:p><w:r><w:t>正文带脚注</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>

  <!-- 10. 表格：colSpan / rowSpan / 表头 / 行高 / 底纹 / 嵌套表格 -->
  <w:tbl>
    <w:tblPr><w:tblW w:w="5000" w:type="pct"/>
      <w:tblBorders><w:top w:val="single" w:sz="8" w:color="CC0000"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>
    <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/></w:tblGrid>
    <w:tr><w:trPr><w:tblHeader/><w:trHeight w:val="400"/></w:trPr>
      <w:tc><w:tcPr><w:gridSpan w:val="2"/><w:shd w:fill="EEEEEE"/></w:tcPr><w:p><w:r><w:t>跨两列</w:t></w:r></w:p></w:tc>
    </w:tr>
    <w:tr>
      <w:tc><w:tcPr><w:vMerge w:val="restart"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:r><w:t>竖合并</w:t></w:r></w:p></w:tc>
      <w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:tcMar><w:left w:w="100"/></w:tcMar></w:tcPr><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc>
    </w:tr>
    <w:tr>
      <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
      <w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p>
        <w:tbl><w:tblGrid><w:gridCol w:w="1000"/></w:tblGrid>
          <w:tr><w:tc><w:p><w:r><w:t>嵌套格</w:t></w:r></w:p></w:tc></w:tr>
        </w:tbl>
      </w:tc>
    </w:tr>
  </w:tbl>

  <!-- 11. 未知元素必须被跳过而不是让读取失败 -->
  <w:p><w:r><w:unsupportedThing w:val="x"><w:r><w:t>不该出现</w:t></w:r></w:unsupportedThing><w:t>正常文字</w:t></w:r></w:p>
  <w:p/>

  <!-- 12. 段落级属性（jc/pBdr/shd/pageBreakBefore/tabs）+ 符号/不换行连字符/软换行 + 批注锚点 -->
  <w:p><w:pPr><w:jc w:val="center"/>
      <w:pBdr><w:top w:val="single" w:sz="12" w:color="0000FF"/></w:pBdr>
      <w:shd w:fill="FFF2CC"/><w:pageBreakBefore/>
      <w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="clear" w:pos="1440"/></w:tabs>
    </w:pPr>
    <w:r><w:t>居中的</w:t></w:r>
    <w:r><w:t>符号</w:t><w:sym w:font="Wingdings" w:char="F0FC"/><w:noBreakHyphen/><w:cr/><w:t>续行</w:t></w:r>
    <w:commentRangeStart w:id="1"/><w:r><w:t>被批注文字</w:t></w:r><w:commentRangeEnd w:id="1"/>
    <w:r><w:commentReference w:id="1"/></w:r></w:p>

  <!-- 13. HYPERLINK 域（真实文件里超链接基本都是这种形式，而不是 w:hyperlink） -->
  <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.org/a?b=1" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>域链接文字</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>

  <w:sectPr>
    <w:headerReference w:type="default" r:id="rId4"/>
    <w:footerReference w:type="default" r:id="rId5"/>
    <w:pgSz w:w="11906" w:h="16838"/>
    <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>
  </w:sectPr>
</w:body>
</w:document>`;

interface FixtureOptions {
  /** document 的内容类型：document / macro / template / none（不给主部件 Override） */
  ctKind?: 'document' | 'macro' | 'template' | 'none';
  /** 覆盖正文（用于畸形/流式等特殊用例） */
  documentXml?: string;
}

async function buildDocx(options: FixtureOptions = {}): Promise<Uint8Array> {
  const w = new ZipWriter();
  w.addFirst('[Content_Types].xml', CONTENT_TYPES(options.ctKind));
  w.add('_rels/.rels', ROOT_RELS);
  w.add('word/document.xml', options.documentXml ?? DOCUMENT);
  w.add('word/_rels/document.xml.rels', DOC_RELS);
  w.add('word/styles.xml', STYLES);
  w.add('word/numbering.xml', NUMBERING);
  w.add('word/theme/theme1.xml', THEME);
  w.add('word/header1.xml', HEADER);
  w.add('word/footer1.xml', FOOTER);
  w.add('word/footnotes.xml', FOOTNOTES);
  w.add('word/comments.xml', COMMENTS);
  w.add('docProps/core.xml', CORE);
  w.add('docProps/app.xml', APP);
  w.add('word/media/image1.png', PNG_1x1);
  // 故意用 .bin 扩展名：MIME 必须靠魔数纠正，而不是靠扩展名
  w.add('word/embeddings/pic-a.bin', PNG_1x1);
  w.add('word/media/image3.png', PNG_1x1);
  return await w.build();
}

/** 手搭一个最小的 ReadContext（等价于 engine 在 open.ts 里给读取器的东西）。 */
function makeCtx(name: string, bytes: Uint8Array, limits?: Partial<Limits>): ReadContext {
  const lim = withLimits(limits);
  const guard = new LimitGuard(lim);
  let containerPromise: Promise<ContainerAccess> | null = null;
  return {
    name,
    size: bytes.length,
    bytes: async () => bytes,
    // 契约要求只调用一次：这里同样只 open 一次并复用
    container: () => (containerPromise ??= Promise.resolve(ZipReader.open(bytes, { maxEntryBytes: lim.maxEntryBytes }))),
    limits: lim,
    guard,
    phase: async <T>(_name: string, fn: () => T | Promise<T>): Promise<T> => await fn(),
  };
}

async function readFixture(options: FixtureOptions = {}, limits?: Partial<Limits>): Promise<LiteDocument> {
  const bytes = await buildDocx(options);
  return await docxReader.read(makeCtx('fixture.docx', bytes, limits));
}

let cached: Promise<LiteDocument> | null = null;
function fixtureDoc(): Promise<LiteDocument> {
  return (cached ??= readFixture());
}

/* ------------------------------ 工具 ------------------------------ */

function blocks(doc: LiteDocument): Block[] {
  return doc.blocks ?? [];
}

function paras(list: readonly Block[]): Paragraph[] {
  return list.filter((b): b is Paragraph => b.kind === 'para');
}

function findPara(doc: LiteDocument, contains: string): Paragraph | undefined {
  return paras(blocks(doc)).find((p) => paraText(p).includes(contains));
}

function allRuns(list: readonly Block[]): Run[] {
  const out: Run[] = [];
  for (const b of list) {
    if (b.kind === 'para') out.push(...b.runs);
    else if (b.kind === 'table') for (const row of b.rows) for (const c of row.cells) out.push(...allRuns(c.blocks));
  }
  return out;
}

/** 递归收集所有表格（含单元格里的嵌套表格）。 */
function collectTables(list: readonly Block[]): Table[] {
  const out: Table[] = [];
  for (const b of list) {
    if (b.kind !== 'table') continue;
    out.push(b);
    for (const row of b.rows) for (const c of row.cells) out.push(...collectTables(c.blocks));
  }
  return out;
}

function findTable(list: readonly Block[]): Table {
  const found = list.find((b): b is Table => b.kind === 'table');
  if (!found) throw new Error('夹具里没有表格');
  return found;
}

/* ==================================================================== */
/* A. 自造夹具的精确断言                                                  */
/* ==================================================================== */

test('docx：包顶层自注册，格式覆盖 docx/docm/dotx', () => {
  assert.equal(docxReader.id, 'format-docx');
  assert.deepEqual([...docxReader.formats], ['docx', 'docm', 'dotx']);
  assert.equal(readerForFormat('docx')?.id, 'format-docx');
  assert.equal(readerForFormat('docm')?.id, 'format-docx');
  assert.equal(readerForFormat('dotx')?.id, 'format-docx');
});

test('docx 夹具：样式继承链（pStyle -> Heading1 -> Normal -> docDefaults）', async (t) => {
  const doc = await fixtureDoc();
  const h1 = findPara(doc, '标题一');
  assert.ok(h1, '应能找到标题段落');
  assert.equal(h1.style?.styleName, 'heading 1', 'styleName 应取 styles.xml 里的显示名');
  assert.equal(h1.style?.outlineLevel, 0, 'outlineLvl 来自样式链');
  assert.equal(h1.style?.spaceBefore, 12, '240 twip -> 12pt');
  assert.equal(h1.style?.spaceAfter, 8, '未覆盖时应继承 docDefaults 的 160 twip -> 8pt');

  const run = h1.runs[0];
  assert.equal(run.style?.bold, true, '粗体来自 Heading1');
  assert.equal(run.style?.size, 16, '32 半磅 -> 16pt');
  assert.equal(run.style?.font, 'Calibri', '字体来自 docDefaults');
  assert.equal(run.style?.fontEastAsia, '宋体');
  // 主题色：themeColor=accent1，夹具主题里是 1F9E5A（不是 Office 默认的 4472C4）
  assert.equal(run.style?.color, '#1f9e5a', '主题色必须经 theme1.xml 解析成真实颜色');
  t.diagnostic(`标题样式: ${JSON.stringify(h1.style)}`);
});

test('docx 夹具：xml:space 空格保留、制表符、换行', async (t) => {
  const doc = await fixtureDoc();
  const p = findPara(doc, '前 后');
  assert.ok(p, `含保留空格的段落应存在，实际段落: ${paras(blocks(doc)).map(paraText).slice(0, 6).join(' | ')}`);
  const text = paraText(p);
  assert.match(text, /前 后/, 'xml:space="preserve" 的空格必须保留');
  assert.ok(text.includes('\t'), `w:tab 必须变成制表符，实际 ${JSON.stringify(text)}`);
  // w:br 变成「下一个 run 的 breakBefore」
  const broken = p.runs.find((r) => r.breakBefore);
  assert.ok(broken, 'w:br 应体现为后续 run 的 breakBefore');
  assert.equal(broken?.text, '乙');
  t.diagnostic(`段落: ${JSON.stringify(text)}`);
});

test('docx 夹具：有序列表编号计数递增（1. 2. 3.）与项目符号', async (t) => {
  const doc = await fixtureDoc();
  const ordered = paras(blocks(doc)).filter((p) => p.style?.listOrdered === true);
  assert.equal(ordered.length, 3, `应有 3 个有序列表段落，实际 ${ordered.length}`);
  assert.deepEqual(
    ordered.map((p) => p.style?.listMarker),
    ['1.', '2.', '3.'],
    '编号必须按计数器递增，而不是永远显示 start 值',
  );
  assert.deepEqual(ordered.map((p) => p.style?.listLevel), [0, 0, 0]);
  // 缩进来自 numbering 的 lvl/pPr（720 twip = 36pt）
  assert.equal(ordered[0].style?.indentStart, 36);
  assert.equal(ordered[0].style?.indentFirst, -18, '悬挂 360 twip -> 首行缩进 -18pt');

  const bullet = paras(blocks(doc)).find((p) => p.style?.listOrdered === false);
  assert.ok(bullet, '应有项目符号段落');
  assert.equal(bullet?.style?.listMarker, '•', 'Symbol 私用区字符必须映射成可显示的项目符号');
  t.diagnostic(`有序列表标记: ${ordered.map((p) => p.style?.listMarker).join(' ')}；符号: ${bullet?.style?.listMarker}`);
});

test('docx 夹具：表格 colSpan / rowSpan / merged / 表头 / 列宽 / 嵌套表格', async (t) => {
  const doc = await fixtureDoc();
  const table = findTable(blocks(doc));
  assert.equal(table.rows.length, 3);
  assert.equal(table.rows[0].header, true, 'w:tblHeader 应标记表头行');
  assert.equal(table.rows[0].height, 20, 'trHeight 400 twip -> 20pt');
  assert.deepEqual(table.widths, [100, 150], 'tblGrid 2000/3000 twip -> 100/150pt');
  assert.equal(table.rows[0].cells[0].colSpan, 2, 'gridSpan=2 -> colSpan=2');
  assert.equal(table.rows[0].cells[0].shading, '#eeeeee');
  assert.equal(table.border?.top?.color, '#cc0000');
  assert.equal(table.border?.top?.width, 1, 'sz=8 -> 1pt');
  assert.ok(table.border?.insideV, 'insideV 边框应被解析');

  // 纵向合并
  const origin = table.rows[1].cells[0];
  assert.equal(origin.rowSpan, 2, '起点格 rowSpan 应为 2');
  assert.ok(!origin.merged, '起点格不该标 merged');
  assert.equal(origin.vAlign, 'center');
  const cont = table.rows[2].cells[0];
  assert.equal(cont.merged, true, '延续格必须标 merged 让渲染器跳过');
  assert.equal(cont.rowSpan, undefined);

  // 单元格内边距与嵌套表格
  assert.equal(table.rows[1].cells[1].padding, 5, 'tcMar left=100 twip -> 5pt');
  const nested = table.rows[2].cells[1].blocks.find((b) => b.kind === 'table');
  assert.ok(nested, '单元格内的嵌套表格应被解析成 Table 块');
  assert.equal(blocksToText([nested]), '嵌套格');
  // 表格宽度：tblW type=pct 5000 (=100%) * 内容宽度（595.3 - 72 - 72）
  assert.ok(Math.abs((table.width ?? 0) - (11906 / 20 - 144)) < 0.3, `表格宽度应约等于内容宽度，实际 ${table.width}`);
  t.diagnostic(`表格: ${table.rows.length} 行 / 列宽 ${JSON.stringify(table.widths)} / 宽 ${table.width?.toFixed(1)}pt / rowSpan=${origin.rowSpan}`);
});

test('docx 夹具：超链接关系解析为 RunStyle.link', async () => {
  const doc = await fixtureDoc();
  const linked = allRuns(blocks(doc)).filter((r) => r.style?.link);
  // 一处 w:hyperlink，一处 HYPERLINK 域（见下一个用例）
  assert.equal(linked.length, 2);
  const rel = linked.find((r) => r.text === '外部链接');
  assert.ok(rel, '关系式超链接的 run 应存在');
  assert.equal(rel.style?.link, 'https://example.com/文档', 'target 必须来自 .rels，且外部关系的 URL 不能被包内路径解析破坏');
  // 字符样式 Hyperlink 的字符属性也应生效
  assert.equal(rel.style?.underline, true);
  assert.equal(rel.style?.color, '#0000ff');
});

test('docx 夹具：w:del 丢弃、w:ins 保留并记警告', async (t) => {
  const doc = await fixtureDoc();
  const text = blocksToText(blocks(doc));
  assert.ok(!text.includes('这段已删除'), 'w:del 里的文本必须丢弃（否则用户以为文件坏了）');
  assert.ok(text.includes('插入的'), 'w:ins 里的文本必须保留');
  assert.ok(text.includes('前段') && text.includes('后段'));
  assert.ok(
    doc.stats.warnings.some((w) => w.includes('修订')),
    `应记录修订相关的警告，实际 ${JSON.stringify(doc.stats.warnings)}`,
  );
  t.diagnostic(`警告: ${doc.stats.warnings.filter((w) => w.includes('修订')).join(' / ')}`);
});

test('docx 夹具：字段结果与占位（域代码绝不进正文）', async (t) => {
  const doc = await fixtureDoc();
  const text = blocksToText(blocks(doc));
  assert.ok(!/PAGE|NUMPAGES|instrText|fldChar/.test(text), `域代码不能出现在正文里：${JSON.stringify(text.slice(0, 200))}`);
  assert.ok(text.includes('7'), 'PAGE 的域结果文本应保留');

  const runs = allRuns(blocks(doc));
  const pageRun = runs.find((r) => r.text === '7');
  assert.equal(pageRun?.field, true, '域结果 run 必须标 field=true');
  const placeholder = runs.find((r) => r.field && r.text === '1');
  assert.ok(placeholder, '没有结果的 NUMPAGES 域应给出可读占位「1」');
  const fldSimple = runs.find((r) => r.text === '作者名');
  assert.equal(fldSimple?.field, true, 'w:fldSimple 的结果也应标 field');
  assert.equal(hyperlinkTargetOf(' HYPERLINK "https://a.b" '), 'https://a.b');
  assert.equal(hyperlinkTargetOf(' HYPERLINK \\l "书签" '), '#书签');
  assert.equal(fieldPlaceholder(' PAGE '), '1');
  assert.equal(fieldPlaceholder(' TOC \\o "1-3" '), '');
  t.diagnostic(`field run: ${JSON.stringify(pageRun)}；占位: ${JSON.stringify(placeholder)}`);
});

test('docx 夹具：图片（DrawingML + VML + AlternateContent 去重 + 改名部件靠魔数纠 MIME）', async (t) => {
  const doc = await fixtureDoc();
  const images = allRuns(blocks(doc)).filter((r) => r.image).map((r) => r.image!);
  assert.equal(images.length, 3, `AlternateContent 的 Choice/Fallback 是同一张图，只能算一次；实际 ${images.length}`);
  assert.equal(doc.stats.imageCount, 3);

  const first = images[0];
  assert.equal(first.mime, 'image/png');
  assert.equal(first.width, 72, 'wp:extent 914400 EMU -> 72pt');
  assert.equal(first.height, 36, '457200 EMU -> 36pt');
  assert.equal(first.alt, '替代文字');
  assert.ok(first.data && first.data.length > 0, '图片字节应被解出');
  assert.deepEqual(first.data, PNG_1x1);
  assert.equal(first.partPath, 'word/media/image1.png');

  // 第二张：部件放在 word/embeddings/pic-a.bin 且扩展名是 .bin
  const second = images[1];
  assert.equal(second.partPath, 'word/embeddings/pic-a.bin', '必须走关系拿部件路径（不能硬编码 word/media）');
  assert.equal(second.mime, 'image/png', '.bin 扩展名必须靠魔数纠正为 image/png');
  assert.equal(second.width, 100, '1270000 EMU -> 100pt');

  // 第三张：VML 且没有 style 尺寸 -> 用图片内禀尺寸（1px -> 0.75pt）
  const third = images[2];
  assert.equal(third.mime, 'image/png');
  assert.equal(third.width, 0.75, '缺尺寸时用内禀像素 + 96dpi 换算');
  assert.equal(imageSizePx(PNG_1x1)?.w, 1);

  assert.equal(doc.stats.imageBytes, PNG_1x1.length * 3, '三张图的字节都应计入 imageBytes');
  t.diagnostic(`图片: ${images.map((i) => `${i.partPath} ${i.mime} ${i.width}x${i.height}pt ${i.data?.length ?? 0}B`).join(' | ')}`);
});

test('docx 夹具：图片上限降级（只留尺寸与 MIME + 记 truncated）', async () => {
  const doc = await readFixture({}, { maxImages: 0 });
  const images = allRuns(blocks(doc)).filter((r) => r.image).map((r) => r.image!);
  assert.equal(images.length, 3, '图片项本身不应消失');
  assert.equal(images[0].data, undefined, '超限时不得加载字节');
  assert.equal(images[0].mime, 'image/png', 'MIME 必须保留');
  assert.equal(images[0].width, 72, '尺寸必须保留');
  assert.equal(doc.stats.imageBytes, 0);
  assert.ok(doc.stats.truncated.includes('maxImages'), `truncated 应含 maxImages，实际 ${JSON.stringify(doc.stats.truncated)}`);
  assert.ok(doc.truncated);
});

test('docx 夹具：maxPartBytes 触发 streamText 流式路径', async (t) => {
  // document.xml 解压后远大于 64 字节 -> 必须走流式扫描
  const doc = await readFixture({}, { maxPartBytes: 64 });
  assert.ok(blocks(doc).length > 5, '流式路径也必须解析出完整内容');
  const hit = doc.stats.warnings.find((w) => w.includes('streamText'));
  assert.ok(hit, `应记录走流式分支的警告，实际 ${JSON.stringify(doc.stats.warnings)}`);
  t.diagnostic(`流式分支警告: ${hit}`);
});

test('docx 夹具：页面设置 twip -> pt，页眉页脚与脚注不丢', async (t) => {
  const doc = await fixtureDoc();
  assert.equal(doc.meta.pageWidth, 595.3, 'pgSz w=11906 twip -> 595.3pt');
  assert.equal(doc.meta.pageHeight, 841.9, 'pgSz h=16838 twip -> 841.9pt');
  assert.deepEqual(doc.meta.margin, { top: 72, right: 72, bottom: 72, left: 72 }, 'pgMar 1440 twip -> 72pt');

  assert.equal(doc.meta.custom?.['页眉(default)'], '页眉文字', '页眉文字必须能取到（放在 meta.custom）');
  assert.equal(doc.meta.custom?.['页脚(default)'], '页脚文字');
  assert.ok(doc.stats.warnings.some((w) => w.includes('页眉')), '页眉页脚的降级方式要记警告');

  // 脚注：正文里留 noteRef，正文追加到文档末尾
  const refs = allRuns(blocks(doc)).filter((r) => r.noteRef);
  assert.equal(refs.length, 1, 'w:footnoteReference 应变成 Run.noteRef');
  assert.deepEqual(refs[0].noteRef, { kind: 'footnote', id: '1' });
  const tail = blocksToText(blocks(doc));
  assert.ok(tail.includes('脚注正文内容'), '脚注正文必须追加到文档末尾（不能静默丢弃）');
  assert.ok(!tail.includes('分隔符'), 'id<=0 的分隔符条目不是注释，不该出现');
  t.diagnostic(`页面 ${doc.meta.pageWidth}x${doc.meta.pageHeight}pt 边距 ${JSON.stringify(doc.meta.margin)}`);
});

test('docx 夹具：段落级属性（jc/pBdr/shd/pageBreakBefore/tabs）与符号类 run', async (t) => {
  const doc = await fixtureDoc();
  const p = findPara(doc, '居中的');
  assert.ok(p, '应能找到居中段落');
  assert.equal(p.style?.align, 'center');
  assert.equal(p.style?.shading, '#fff2cc');
  assert.equal(p.style?.pageBreakBefore, true);
  assert.equal(p.style?.border?.top?.width, 1.5, 'pBdr sz=12 -> 12/8 = 1.5pt');
  assert.equal(p.style?.border?.top?.color, '#0000ff');
  assert.deepEqual(p.style?.tabs, [36], 'w:tab pos=720 twip -> 36pt，且 clear 的制表位必须排除');

  const symbolRun = p.runs.find((r) => r.text.includes('符号'));
  assert.ok(symbolRun, '符号 run 应存在');
  assert.equal(symbolRun.text, '符号✓\u2011', `w:sym(F0FC) 应映射为 ✓，w:noBreakHyphen 应为 U+2011；实际 ${JSON.stringify(symbolRun?.text)}`);
  const continued = p.runs.find((r) => r.text === '续行');
  assert.equal(continued?.breakBefore, true, 'w:cr 应让后续 run 带 breakBefore');
  t.diagnostic(`段落属性: ${JSON.stringify(p.style)}；符号 run: ${JSON.stringify(symbolRun?.text)}`);
});

test('docx 夹具：HYPERLINK 域的结果文字变成可点击链接', async () => {
  const doc = await fixtureDoc();
  const run = allRuns(blocks(doc)).find((r) => r.text === '域链接文字');
  assert.ok(run, 'HYPERLINK 域的结果文字应保留');
  assert.equal(run.field, true);
  assert.equal(run.style?.link, 'https://example.org/a?b=1', 'HYPERLINK 域的 URL 应写进 RunStyle.link');
  // 域代码本身不能出现在正文里
  assert.ok(!blocksToText(blocks(doc)).includes('HYPERLINK "'));
});

test('docx 夹具：批注锚点只记警告，批注正文收进 meta.custom', async (t) => {
  const doc = await fixtureDoc();
  assert.equal(doc.meta.custom?.['批注1'], '批注内容', '批注正文应能从 comments.xml 取到');
  assert.ok(doc.stats.warnings.some((w) => w.includes('批注')), '批注应留下警告（未插入正文流）');
  assert.ok(blocksToText(blocks(doc)).includes('被批注文字'), '被批注的正文本身必须保留');
  t.diagnostic(`批注: ${JSON.stringify(doc.meta.custom?.['批注1'])}`);
});

test('docx 夹具：元数据按名字取（core + app，不依赖元素顺序）', async (t) => {
  const doc = await fixtureDoc();
  assert.equal(doc.meta.title, '夹具标题');
  assert.equal(doc.meta.author, '夹具作者');
  assert.equal(doc.meta.lastModifiedBy, '最后修改者');
  assert.equal(doc.meta.created, '2024-01-02T03:04:05Z');
  assert.equal(doc.meta.modified, '2024-05-06T07:08:09Z');
  assert.equal(doc.meta.keywords, '轻办公,docx');
  assert.equal(doc.meta.description, '这是一个自造夹具');
  assert.equal(doc.meta.subject, '单元测试');
  assert.equal(doc.meta.application, 'LiteOffice-Test');
  assert.equal(doc.meta.appVersion, '1.2.3');
  assert.equal(doc.meta.pageCount, 2);
  assert.equal(doc.meta.wordCount, 33, 'app.xml 的 Words 优先于本地估算');
  assert.equal(doc.meta.charCount, 99);
  assert.equal(doc.meta.company, '轻办公');
  assert.equal(doc.meta.custom?.['totalTimeMinutes'], '7');
  t.diagnostic(`元数据: ${doc.meta.title} / ${doc.meta.author} / ${doc.meta.application}`);
});

test('docx 夹具：大纲来自 outlineLevel 与本地化样式名', async () => {
  const doc = await fixtureDoc();
  assert.equal(doc.outline.length, 1);
  assert.equal(doc.outline[0].text, '标题一');
  assert.equal(doc.outline[0].level, 1);
});

test('docx 夹具：不支持的子元素只跳过并记 warning，绝不抛错', async (t) => {
  const doc = await fixtureDoc();
  const text = blocksToText(blocks(doc));
  assert.ok(text.includes('正常文字'), '未知包装元素里的 w:r 被跳过是对的，但外层正常文字必须保留');
  assert.ok(!text.includes('不该出现'));
  assert.ok(
    doc.stats.warnings.some((w) => w.includes('不认识的元素')),
    `应记录跳过的未知元素，实际 ${JSON.stringify(doc.stats.warnings)}`,
  );
  // 空段落 <w:p/> 必须保留（Word 里它就是空一行）
  assert.ok(paras(blocks(doc)).some((p) => p.runs.length === 0), '空段落应保留');
  t.diagnostic(`警告共 ${doc.stats.warnings.length} 条: ${doc.stats.warnings.join(' | ')}`);
});

test('docx 夹具：stats 如实填写', async (t) => {
  const doc = await fixtureDoc();
  assert.equal(doc.kind, 'text');
  assert.equal(doc.format, 'docx');
  assert.equal(doc.formatLabel, formatSpec('docx').label);
  assert.equal(doc.name, 'fixture.docx');
  assert.ok(doc.stats.parseMs >= 0);
  assert.ok(doc.stats.modelBytes > 0, 'modelBytes 必须是估算出来的真实值');
  assert.equal(doc.stats.sourceBytes, (await buildDocx()).length);
  assert.equal(doc.stats.blockCount, blocks(doc).length);
  assert.ok(doc.stats.cellCount >= 6, `cellCount 应统计到表格单元格，实际 ${doc.stats.cellCount}`);
  assert.equal(doc.stats.imageCount, 3);
  assert.equal(doc.stats.shapeCount, 0);
  assert.ok(doc.stats.phases && Object.keys(doc.stats.phases).length > 0);
  // dispose 后图片字节必须被释放
  const img = allRuns(blocks(doc)).find((r) => r.image)?.image;
  doc.dispose();
  assert.equal(img?.data, undefined, 'dispose() 应释放图片字节');
  cached = null; // 后续用例重新读一份（上面对 doc 调了 dispose）
  t.diagnostic(
    `stats: parseMs=${doc.stats.parseMs.toFixed(1)} modelBytes=${doc.stats.modelBytes} blockCount=${doc.stats.blockCount} imageBytes=${doc.stats.imageBytes}`,
  );
});

test('docx 夹具：格式判定（docm / dotx 走同一条读取路径）', async () => {
  const docm = await readFixture({ ctKind: 'macro' });
  assert.equal(docm.format, 'docm', '内容类型含 macroEnabled 应判为 docm');
  assert.equal(docm.formatLabel, formatSpec('docm').label);
  const dotx = await readFixture({ ctKind: 'template' });
  assert.equal(dotx.format, 'dotx');
  assert.equal(dotx.formatLabel, formatSpec('dotx').label);
  // 扩展名兜底（内容类型里没有主部件 Override 时）
  const bytes = await buildDocx({ ctKind: 'none' });
  const byExt = await docxReader.read(makeCtx('模板.dotx', bytes));
  assert.equal(byExt.format, 'dotx', '内容类型未给出时应按扩展名判定');
  const byExtDocm = await docxReader.read(makeCtx('宏.docm', bytes));
  assert.equal(byExtDocm.format, 'docm');
});

test('docx：畸形/截断的 XML 也要尽量打开（保留已解析内容 + 记警告）', async () => {
  const truncated = DOCUMENT.slice(0, DOCUMENT.indexOf('<w:tbl>') + 40).replace('</w:body></w:document>', '');
  const doc = await readFixture({ documentXml: truncated });
  assert.ok(blocks(doc).length > 5, `截断文件也应保留已解析的块，实际 ${blocks(doc).length}`);
  assert.ok(doc.stats.warnings.length > 0, '截断必须留下警告');
});

test('docx：完全不是 docx 的 zip 应抛 ReadError 而不是崩溃', async () => {
  const w = new ZipWriter();
  w.addFirst('[Content_Types].xml', '<Types/>');
  w.add('hello.txt', 'hi');
  const bytes = await w.build();
  await assert.rejects(
    () => docxReader.read(makeCtx('fake.docx', bytes)),
    (err: unknown) => (err as { code?: string }).code === 'CORRUPT',
  );
});

test('docx：ctx.container() 只被调用一次（重复 open 会重复解析中央目录）', async () => {
  const bytes = await buildDocx();
  let opens = 0;
  const lim = withLimits();
  const guard = new LimitGuard(lim);
  const ctx: ReadContext = {
    name: 'once.docx',
    size: bytes.length,
    bytes: async () => bytes,
    container: async () => {
      opens++;
      return ZipReader.open(bytes);
    },
    limits: lim,
    guard,
    phase: async <T>(_n: string, fn: () => T | Promise<T>) => await fn(),
  };
  const doc = await docxReader.read(ctx);
  assert.ok(blocks(doc).length > 10);
  assert.equal(opens, 1, '读取器必须只调用一次 ctx.container()');
});

/* ==================================================================== */
/* B. 真实 Word 文件交叉验证                                              */
/* ==================================================================== */

function realDocxFiles(): string[] {
  if (!existsSync(WORKSPACE)) return [];
  return readdirSync(WORKSPACE)
    .filter((n) => n.toLowerCase().endsWith('.docx'))
    .map((n) => join(WORKSPACE, n))
    .filter((p) => existsSync(p))
    .sort();
}

test('真实 docx：能打开、统计合理、图片能解出字节、表格与大纲可用', async (t) => {
  const files = realDocxFiles();
  if (!files.length) {
    t.skip('工作区没有真实 .docx 夹具');
    return;
  }

  let totalImages = 0;
  let totalCells = 0;
  for (const path of files) {
    const name = path.slice(WORKSPACE.length + 1);
    const bytes = new Uint8Array(readFileSync(path));
    const doc = await docxReader.read(makeCtx(name, bytes));

    // 1. 能打开
    assert.equal(doc.format, 'docx', `${name}: 格式判定`);
    assert.equal(doc.kind, 'text');
    const list = blocks(doc);
    assert.ok(list.length > 3, `${name}: 段落数太少（${list.length}）`);

    // 2. 文本量与字数合理（用文件名区分「实验报告」型与「testX」型夹具）
    const text = blocksToText(list);
    const chars = text.replace(/\s/g, '').length;
    assert.ok(chars > 200, `${name}: 文本量过少（${chars} 字）`);
    const counted = countWords(list);
    assert.ok(counted.words > 50, `${name}: 估算字数过少（${counted.words}）`);

    // 3. 图片：能解出字节与 MIME（真实文件里图片是主要内容）
    const images = allRuns(list).filter((r) => r.image).map((r) => r.image!);
    let loaded = 0;
    for (const im of images) {
      assert.match(im.mime, /^image\//, `${name}: 图片 MIME 异常 ${im.mime}`);
      assert.ok(im.width > 0 && im.height > 0, `${name}: 图片尺寸缺失`);
      assert.ok(im.partPath, `${name}: 图片应有 partPath`);
      if (im.data && im.data.length > 0) loaded++;
    }
    assert.equal(loaded, images.length, `${name}: 所有图片都应解出字节（${loaded}/${images.length}）`);
    assert.ok(doc.stats.imageBytes > 0, `${name}: imageBytes 应 > 0`);
    totalImages += images.length;

    // 4. 表格：能解析出结构，单元格里的文字不丢
    const tables = collectTables(list);
    let cells = 0;
    for (const tb of tables) {
      assert.ok(tb.rows.length >= 1, `${name}: 表格应至少 1 行`);
      for (const row of tb.rows) cells += row.cells.length;
    }
    totalCells += cells;

    // 5. 大纲：标题段落能进 outline（真实文件用 pStyle 引用标题样式）
    assert.ok(doc.outline.length >= 1, `${name}: 应至少提取到一个大纲项`);
    for (const o of doc.outline) {
      assert.ok(o.level >= 1 && o.level <= 9, `${name}: 大纲级别异常 ${o.level}`);
      assert.ok(o.text.length > 0);
    }

    // 6. 元数据 / 页面设置
    assert.ok(doc.meta.pageWidth && doc.meta.pageHeight, `${name}: 应有页面尺寸`);
    assert.ok(doc.meta.margin, `${name}: 应有页边距`);
    assert.ok((doc.meta.wordCount ?? 0) > 0, `${name}: 字数统计必须有值（app.xml 为 0 时要本地兜底）`);
    assert.ok((doc.meta.paragraphCount ?? 0) > 0, `${name}: 段落数统计必须有值`);

    // 7. 域代码不能漏进正文
    assert.ok(!/instrText|fldChar|HYPERLINK\s"/.test(text), `${name}: 正文里出现了域代码`);
    // 8. 绝不因为任何原因产生截断（这些文件都在默认上限之内）
    assert.deepEqual(doc.stats.truncated, [], `${name}: 不应发生截断`);

    t.diagnostic(
      `${name.padEnd(30)} ${(bytes.length / 1024).toFixed(0).padStart(4)}KiB  块 ${String(list.length).padStart(4)}` +
        `  段落 ${String(doc.meta.paragraphCount ?? 0).padStart(4)}  表格 ${String(tables.length).padStart(2)}  单元格 ${String(cells).padStart(4)}` +
        `  图片 ${String(images.length).padStart(3)}(${(doc.stats.imageBytes / 1024).toFixed(0)}KiB)` +
        `  大纲 ${String(doc.outline.length).padStart(2)}  字数 ${String(counted.words).padStart(5)}  字符 ${String(counted.chars).padStart(5)}` +
        `  ${doc.stats.parseMs.toFixed(0)}ms  模型 ${(doc.stats.modelBytes / 1024).toFixed(0)}KiB  警告 ${doc.stats.warnings.length}`,
    );
  }

  assert.ok(totalImages > 0, '真实文件里应当有图片被解析出来');
  assert.ok(totalCells > 0, '真实文件里应当有表格单元格');
  t.diagnostic(`真实 docx 汇总: ${files.length} 个文件 / 图片 ${totalImages} 张 / 表格单元格 ${totalCells} 个`);
});

test('真实 docx：警告清单里不应出现「解析失败/中断」这类硬错误', async (t) => {
  const files = realDocxFiles();
  if (!files.length) {
    t.skip('工作区没有真实 .docx 夹具');
    return;
  }
  for (const path of files) {
    const name = path.slice(WORKSPACE.length + 1);
    const doc = await docxReader.read(makeCtx(name, new Uint8Array(readFileSync(path))));
    const bad = doc.stats.warnings.filter((w) => /解析失败|解析中断|不存在|未找到 styles|没有解析出/.test(w));
    assert.deepEqual(bad, [], `${name}: 出现了硬错误级警告 ${JSON.stringify(bad)}`);
    for (const w of doc.stats.warnings) t.diagnostic(`${name}: ${w}`);
  }
});
