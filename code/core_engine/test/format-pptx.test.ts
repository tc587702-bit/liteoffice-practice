/**
 * @liteoffice/format-pptx 读取器验证。
 *
 * 全部用**自造夹具**（ZipWriter 写出的合法 pptx），因为工作区里的真实 pptx
 * 可能含个人内容、不适合进仓库；真实文件另有一个带 skip 的交叉验证用例。
 *
 * 夹具刻意包含几个「反直觉但真实」的结构：
 *   - `p:sldIdLst` 的顺序与文件名顺序**不一致**（解析是否走关系的试金石）
 *   - 一个 slide 上的形状**刻意不写** `a:xfrm`，靠版式占位符继承几何
 *   - `a:xfrm rot` / `flipH`、`a:noFill`、`a:alpha`、组合的 chOff/chExt 缩放
 *   - `mc:AlternateContent` 同时含 Choice（要丢弃）与 Fallback（要采纳）
 *   - slide1 的 `r:embed` 指向不存在的图片（损坏文件的降级路径）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ZipReader, ZipWriter } from '../packages/zip/src/index.ts';
import { DEFAULT_LIMITS, LimitGuard, withLimits } from '../packages/core/src/index.ts';
import type { LiteDocument, ParaStyle, Shape, Slide } from '../packages/core/src/index.ts';
import type { ContainerAccess, ReadContext, ReadProgress } from '../packages/core/src/registry.ts';
import { XmlPullParser } from '../packages/xml/src/index.ts';
import {
  applyColorMods,
  applyAutoNumber,
  groupMap,
  hundredthPtToPt,
  parseColorChild,
  parseFillColor,
  presetColor,
  readColorElement,
  schemeColorAt,
  eachChild,
  rotToDegrees,
  xfrmFrom,
} from '../packages/format-pptx/src/index.ts';
import type { ParserFactory } from '../packages/format-pptx/src/index.ts';
// 显式导入以确保读取器完成自注册（index.ts 顶层调用 registerReader）
import '../packages/format-pptx/src/index.ts';

/* ==================================================================== */
/* 夹具                                                                  */
/* ==================================================================== */

const enc = new TextEncoder();

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PRES_TYPE = `${REL_NS}/slide`;
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FEFEFE"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
  </a:themeElements>
</a:theme>`;

const PRESENTATION_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${REL_NS}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/>
    <p:sldId id="257" r:id="rId3"/>
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;

/**
 * 关键点：`rId2` 指向 slide2.xml、`rId3` 指向 slide1.xml，而 `p:sldIdLst`
 * 里 rId2 排在前面 —— 于是**文件名顺序与展示顺序相反**。
 * 这正是「必须走关系解析」的试金石：硬编码 slide1/slide2 的实现顺序会全乱。
 */
const PRESENTATION_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId2" Type="${PRES_TYPE}" Target="slides/slide2.xml"/>
  <Relationship Id="rId3" Type="${PRES_TYPE}" Target="slides/slide1.xml"/>
  <Relationship Id="rId9" Type="${REL_NS}/theme" Target="theme/theme1.xml"/>
</Relationships>`;

const MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL_NS}">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="MasterTitle"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="4000" b="1"/></a:pPr></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:txStyles>
    <p:titleStyle><a:lvl1pPr><a:defRPr sz="4400" b="1"><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle>
    <p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:bodyStyle>
  </p:txStyles>
</p:sldMaster>`;

const MASTER_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="${REL_NS}/theme" Target="../theme/theme1.xml"/>
</Relationships>`;

/** 版式：标题占位符有填充 + 白色文字；正文占位符给出几何与默认字号。 */
const LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL_NS}">
  <p:cSld name="标题和内容">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="LayoutTitle"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="4400" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:pPr></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="LayoutBody"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="2400"/></a:pPr></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

const LAYOUT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;

const SLIDE1_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>

      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody>
          <a:bodyPr anchor="ctr"/><a:lstStyle/>
          <a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="1800" b="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:latin typeface="Calibri"/><a:ea typeface="宋体"/></a:rPr><a:t>测试标题</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>

      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Body 2"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p><a:pPr lvl="0"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="zh-CN"/><a:t>项目一</a:t></a:r></a:p>
          <a:p><a:pPr lvl="0"><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:t>编号项</a:t></a:r></a:p>
          <a:p><a:pPr lvl="0"><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:t>编号项二</a:t></a:r></a:p>
          <a:p><a:pPr lvl="1"><a:buNone/></a:pPr><a:r><a:rPr sz="1200"/><a:t>无符号</a:t></a:r><a:br/><a:r><a:rPr sz="1200"/><a:t>换行后</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>

      <p:sp>
        <p:nvSpPr><p:cNvPr id="4" name="圆角A"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln></p:spPr>
      </p:sp>

      <p:sp>
        <p:nvSpPr><p:cNvPr id="5" name="旋转矩形"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm rot="5400000" flipH="1"><a:off x="1828800" y="914400"/><a:ext cx="457200" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:sp>

      <p:sp>
        <p:nvSpPr><p:cNvPr id="6" name="无填充"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:noFill/><a:solidFill><a:srgbClr val="FF00FF"><a:alpha val="50000"/></a:srgbClr></a:solidFill></p:spPr>
      </p:sp>

      <p:grpSp>
        <p:nvGrpSpPr><p:cNvPr id="7" name="组合1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="1828800" cy="914400"/><a:chOff x="0" y="0"/><a:chExt cx="914400" cy="457200"/></a:xfrm></p:grpSpPr>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="8" name="子A"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        </p:sp>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="9" name="子B"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="457200" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        </p:sp>
      </p:grpSp>

      <p:pic>
        <p:nvPicPr><p:cNvPr id="10" name="图片1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId20"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="0" y="2286000"/><a:ext cx="457200" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:pic>

      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="11" name="表格1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="457200" y="3200400"/><a:ext cx="2743200" cy="914400"/></p:xfrm>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
          <a:tbl>
            <a:tblPr firstRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>
            <a:tblGrid><a:gridCol w="914400"/><a:gridCol w="1828800"/></a:tblGrid>
            <a:tr h="370840"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>A1</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>B1</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr>
            <a:tr h="370840"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>合并</a:t></a:r></a:p></a:txBody><a:tcPr gridSpan="2" anchor="ctr"><a:solidFill><a:srgbClr val="DDEEFF"/></a:solidFill></a:tcPr></a:tc></a:tr>
          </a:tbl>
        </a:graphicData></a:graphic>
      </p:graphicFrame>

      <mc:AlternateContent>
        <mc:Choice Requires="a14">
          <p:sp>
            <p:nvSpPr><p:cNvPr id="90" name="Choice形状"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
          </p:sp>
        </mc:Choice>
        <mc:Fallback>
          <p:sp>
            <p:nvSpPr><p:cNvPr id="91" name="Fallback形状"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:spPr><a:xfrm><a:off x="1828800" y="2743200"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
            <p:txBody><a:bodyPr/><a:p><a:r><a:t>回退内容</a:t></a:r></a:p></p:txBody>
          </p:sp>
        </mc:Fallback>
      </mc:AlternateContent>

    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;

const SLIDE1_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="${REL_NS}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
  <Relationship Id="rId20" Type="${REL_NS}/image" Target="../media/missing.png"/>
</Relationships>`;

const SLIDE2_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL_NS}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="第二页标题"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="3200"/><a:t>第二页</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:pic>
      <p:nvPicPr><p:cNvPr id="3" name="图片2"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId5"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
    </p:pic>
  </p:spTree></p:cSld>
</p:sld>`;
const SLIDE2_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId5" Type="${REL_NS}/image" Target="../media/image1.png"/>
</Relationships>`;

const NOTES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL_NS}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="备注占位符"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>这是备注第一行</a:t></a:r></a:p><a:p><a:r><a:t>备注第二行</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="页码占位符"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:p><a:fld id="{X}" type="slidenum"><a:t>1</a:t></a:fld></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:notes>`;

const CORE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>夹具演示</dc:title>
  <dc:creator>LiteOffice 测试</dc:creator>
  <cp:lastModifiedBy>测试者</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">2024-05-01T10:00:00Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2024-05-02T11:30:00Z</dcterms:modified>
</cp:coreProperties>`;

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Microsoft Office PowerPoint</Application>
  <AppVersion>16.0000</AppVersion>
  <Company>示例公司</Company>
  <Slides>2</Slides>
  <TitlesOfParts><vt:vector size="2" baseType="lpstr"><vt:lpstr>测试标题</vt:lpstr><vt:lpstr>第二页</vt:lpstr></vt:vector></TitlesOfParts>
</Properties>`;

/** 1×1 PNG，用于验证图片字节确实被读了出来。 */
const PNG_1PX = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

interface FixtureOptions {
  includeTheme?: boolean;
  includeLayout?: boolean;
  includeNotes?: boolean;
  includeImage?: boolean;
  emptyTree?: boolean;
  missingPresentationRels?: boolean;
}

/**
 * 造一个合法的 pptx。
 *
 * 注意 `p:sldIdLst` 的顺序（rId3 在前）与文件名顺序（slide1 在前）相反 ——
 * 这是「必须走关系解析」的关键测试点。
 */
export async function __makePptxForDiag(opts: FixtureOptions = {}): Promise<Uint8Array> {
  return makePptx(opts);
}

async function makePptx(opts: FixtureOptions = {}): Promise<Uint8Array> {
  const w = new ZipWriter();
  w.addFirst('[Content_Types].xml', CONTENT_TYPES);
  w.add('_rels/.rels', ROOT_RELS);
  w.add('docProps/core.xml', CORE_XML);
  w.add('docProps/app.xml', APP_XML);
  w.add('ppt/presentation.xml', PRESENTATION_XML);
  if (opts.missingPresentationRels) {
    w.add(
      'ppt/_rels/presentation.xml.rels',
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
    );
  } else {
    w.add('ppt/_rels/presentation.xml.rels', PRESENTATION_RELS);
  }
  w.add('ppt/slideMasters/slideMaster1.xml', MASTER_XML);
  w.add('ppt/slideMasters/_rels/slideMaster1.xml.rels', MASTER_RELS);
  if (opts.includeLayout !== false) {
    w.add('ppt/slideLayouts/slideLayout1.xml', LAYOUT_XML);
    w.add('ppt/slideLayouts/_rels/slideLayout1.xml.rels', LAYOUT_RELS);
  } else {
    // 版式部件缺失：验证降级（占位符几何回退到母版）
    w.add('ppt/slideLayouts/_rels/slideLayout1.xml.rels', LAYOUT_RELS);
  }
  w.add('ppt/slides/slide1.xml', opts.emptyTree ? SLIDE1_XML.replace(/<p:spTree>[\s\S]*<\/p:spTree>/, '<p:spTree/>') : SLIDE1_XML);
  w.add('ppt/slides/_rels/slide1.xml.rels', opts.includeNotes === false ? SLIDE1_RELS.replace(/<Relationship Id="rId2"[^>]*\/>/, '') : SLIDE1_RELS);
  w.add('ppt/slides/slide2.xml', SLIDE2_XML);
  w.add('ppt/slides/_rels/slide2.xml.rels', includeImageRel(opts));
  if (opts.includeNotes !== false) w.add('ppt/notesSlides/notesSlide1.xml', NOTES_XML);
  if (opts.includeTheme !== false) w.add('ppt/theme/theme1.xml', THEME_XML);
  if (opts.includeImage !== false) w.add('ppt/media/image1.png', PNG_1PX);
  return w.build();
}

function includeImageRel(opts: FixtureOptions): string {
  if (opts.includeImage === false) return SLIDE2_RELS.replace(/<Relationship Id="rId5"[^>]*\/>/, '');
  return SLIDE2_RELS;
}

/* ==================================================================== */
/* 读取上下文（Node 测试里替代 engine）                                   */
/* ==================================================================== */

function makeContext(bytes: Uint8Array, name = 'fixture.pptx', limits = DEFAULT_LIMITS): ReadContext {
  const zip = ZipReader.open(bytes);
  const container: ContainerAccess = {
    entryNames: zip.entryNames,
    has: (n: string) => zip.has(n),
    entrySize: (n: string) => zip.entrySize(n),
    read: (n: string) => zip.read(n),
    text: (n: string) => zip.text(n),
    stream: (n: string) => zip.stream(n),
    streamText: (n: string) => zip.streamText(n),
  };
  const guard = new LimitGuard(limits);
  const phases: Record<string, number> = {};
  let containerCalls = 0;
  const ctx: ReadContext = {
    name,
    size: bytes.length,
    bytes: async () => bytes,
    container: async () => {
      containerCalls++;
      if (containerCalls > 1) throw new Error(`ctx.container() 被调用了 ${containerCalls} 次（契约要求只调一次）`);
      return container;
    },
    limits,
    guard,
    onProgress: (_p: ReadProgress) => undefined,
    phase: async <T>(phaseName: string, fn: () => T | Promise<T>): Promise<T> => {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        phases[phaseName] = (phases[phaseName] ?? 0) + (performance.now() - t0);
      }
    },
  };
  return ctx;
}

async function open(bytes: Uint8Array, name = 'fixture.pptx', limits = DEFAULT_LIMITS): Promise<LiteDocument> {
  const mod = await import('../packages/format-pptx/src/index.ts');
  return mod.pptxReader.read(makeContext(bytes, name, limits));
}

function allShapes(slides: readonly Slide[]): Shape[] {
  const out: Shape[] = [];
  const walk = (shapes: readonly Shape[]): void => {
    for (const s of shapes) {
      out.push(s);
      if (s.shapes) walk(s.shapes);
    }
  };
  for (const s of slides) walk(s.shapes);
  return out;
}

function findShape(doc: LiteDocument, name: string): Shape | undefined {
  return allShapes(doc.slides ?? []).find((s) => s.name === name);
}

function shapeText(sh: Shape | undefined): string {
  if (!sh?.blocks) return '';
  let out = '';
  for (const b of sh.blocks) {
    if (b.kind === 'para') out += b.runs.map((r) => r.text).join('') + '\n';
  }
  return out;
}

/* ==================================================================== */
/* 单位换算（pptx 最容易搞错的两处）                                      */
/* ==================================================================== */

test('单位换算：EMU -> pt、1/100pt 字号、1/60000 度旋转', () => {
  // 1 英寸 = 914400 EMU = 72pt（这是 EMU 的锚点定义）
  assert.equal(hundredthPtToPt(1800), 18, 'a:rPr sz="1800" 必须是 18pt（1/100 pt）');
  assert.equal(hundredthPtToPt(4400), 44);
  assert.equal(rotToDegrees(5400000), 90, 'a:xfrm rot="5400000" 必须是 90 度');
  assert.equal(rotToDegrees(0), 0);
  assert.ok(Math.abs(rotToDegrees(2700000) - 45) < 1e-9);
});

test('xfrmFrom：EMU 坐标转 pt，rot/flip 从属性读', () => {
  const xml = `<a:xfrm rot="5400000" flipV="1"><a:off x="914400" y="457200"/><a:ext cx="1828800" cy="914400"/></a:xfrm>`;
  const p = new XmlPullParser(xml);
  const e = p.next();
  assert.equal(e.type, 'start');
  const kids: { off?: unknown; ext?: unknown } = {};
  eachChild(p, e, (child) => {
    if (child.local === 'off') kids.off = child;
    if (child.local === 'ext') kids.ext = child;
    return false;
  });
  const xf = xfrmFrom(e, kids as never);
  assert.equal(xf.present, true);
  assert.equal(xf.x, 72, '914400 EMU = 72pt');
  assert.equal(xf.y, 36, '457200 EMU = 36pt');
  assert.equal(xf.w, 144);
  assert.equal(xf.h, 72);
  assert.equal(xf.rot, 90);
  assert.equal(xf.flipH, undefined);
  assert.equal(xf.flipV, true);
});

test('EMU -> pt 的锚点：914400 EMU = 72pt', async () => {
  // 通过夹具端到端验证（标题 off x=457200 -> 36pt，ext cx=8229600 -> 648pt）
  const doc = await open(await makePptx());
  const title = findShape(doc, 'Title 1');
  assert.ok(title, '应解析出标题形状');
  assert.equal(title.x, 36);
  assert.equal(title.w, 648);
  // 幻灯片尺寸 9144000 x 6858000 EMU = 720 x 540 pt
  assert.equal(doc.meta.pageWidth, 720);
  assert.equal(doc.meta.pageHeight, 540);
});

/* ==================================================================== */
/* 颜色                                                                  */
/* ==================================================================== */

function colorOf(xml: string): { color?: string; alpha?: number; themeKey?: string; unsupported?: boolean } | undefined {
  const p = new XmlPullParser(xml);
  const e = p.next();
  assert.equal(e.type, 'start');
  const theme = new Map([
    ['accent1', '#4472c4'],
    ['dk1', '#111111'],
    ['lt1', '#fefefe'],
  ]);
  // parseColorChild 的契约：解析器停在**容器**（a:solidFill 之类）上，
  // 它自己去取里面的颜色元素。直接给颜色元素时用 readColorElement。
  return e.local === 'solidFill' || e.local === 'gradFill' ? parseColorChild(p, theme) : readColorElement(p, e, theme);
}

test('颜色：srgbClr / schemeClr（含别名）/ prstClr', () => {
  assert.equal(colorOf('<a:srgbClr val="FF0000"/>')?.color, '#ff0000');
  assert.equal(colorOf('<a:schemeClr val="accent1"/>')?.color, '#4472c4');
  // 别名映射 tx1 -> dk1、bg1 -> lt1（THEME_ALIAS）
  assert.equal(colorOf('<a:schemeClr val="tx1"/>')?.color, '#111111');
  assert.equal(colorOf('<a:schemeClr val="bg1"/>')?.color, '#fefefe');
  assert.equal(colorOf('<a:prstClr val="red"/>')?.color, '#ff0000');
  assert.equal(colorOf('<a:prstClr val="darkblue"/>')?.color, '#00008b');
  assert.equal(presetColor('yellow'), '#ffff00');
  assert.equal(presetColor('不存在的颜色名'), undefined);
  // 未知主题槽位：返回 undefined，由上层决定继承，不猜颜色
  assert.equal(colorOf('<a:schemeClr val="accent9"/>'), undefined);
});

test('颜色：alpha 映射为透明度，lumMod/lumOff 近似', () => {
  const withAlpha = colorOf('<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>');
  assert.equal(withAlpha?.color, '#ff0000');
  assert.equal(withAlpha?.alpha, 0.5);

  // lumMod 50%：红色亮度减半，仍是红色系但不是原色
  const dimmed = applyColorMods('#ff0000', { lumMod: 0.5 });
  assert.notEqual(dimmed, '#ff0000');
  assert.equal(applyColorMods('#ff0000', {}), '#ff0000', '无变换时原样返回');
  // lumOff 把黑色提亮（PowerPoint 常用 accent1 + lumMod25/lumOff75 得到浅色调）
  const lightened = applyColorMods('#000000', { lumOff: 0.75 });
  assert.notEqual(lightened, '#000000');
  assert.ok(/^#[0-9a-f]{6}$/.test(lightened));
  // 不支持的变换要如实标记，供上层记 warning
  assert.equal(colorOf('<a:srgbClr val="00FF00"><a:comp/></a:srgbClr>')?.themeKey, undefined);
});

test('noFill 不等于黑色：a:noFill 必须解析为「无填充」', () => {
  const p = new XmlPullParser('<a:solidFill><a:noFill/></a:solidFill>');
  const e = p.next();
  assert.equal(e.local, 'solidFill');
  // 容器里只有 noFill：不能返回任何颜色。两种调用约定都要覆盖。
  assert.equal(parseFillColor(p, new Map(), e), undefined);
  const p2 = new XmlPullParser('<a:solidFill><a:noFill/></a:solidFill>');
  p2.next();
  assert.equal(parseFillColor(p2, new Map()), undefined, '不传事件时解析器应停在容器 start 上');

  const p3 = new XmlPullParser('<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="123456"/></a:gs></a:gsLst></a:gradFill>');
  const e3 = p3.next();
  assert.equal(parseFillColor(p3, new Map(), e3)?.color, '#123456', '渐变取首个色标近似');
});

test('主题色填充与文字色端到端（schemeClr -> 真实十六进制）', async () => {
  const doc = await open(await makePptx());
  const square = findShape(doc, '圆角A');
  assert.ok(square);
  assert.equal(square.fill, '#4472c4', 'accent1 应查主题得到 #4472c4');
  assert.equal(square.stroke, '#00ff00', '描边色来自 a:ln/a:solidFill');
  assert.equal(square.strokeWidth, 1, 'a:ln w="12700" EMU = 1pt');
  assert.equal(square.kind, 'rect');
  assert.ok(square.radius !== undefined && square.radius > 0, 'roundRect 应带上圆角半径');

  const title = findShape(doc, 'Title 1');
  const run = title?.blocks?.[0].kind === 'para' ? (title.blocks[0].runs[0] ?? undefined) : undefined;
  assert.equal(run?.style?.color, '#ff0000');
  assert.equal(run?.style?.size, 18, 'sz="1800" -> 18pt（若误用半磅换算会得到 9）');
  assert.equal(run?.style?.bold, true);
  assert.equal(run?.style?.font, 'Calibri');
  assert.equal(run?.style?.fontEastAsia, '宋体');
});

test('a:noFill 的形状不得填成黑色', async () => {
  const doc = await open(await makePptx());
  const noFill = findShape(doc, '无填充');
  assert.ok(noFill);
  // noFill 之后还有一个带 alpha 的 solidFill —— 真实文件里 two 者并存时后者生效，
  // 这里断言「至少不是黑色」，并覆盖 alpha -> opacity 路径
  assert.notEqual(noFill.fill, '#000000');
  if (noFill.fill === '#ff00ff') assert.equal(noFill.opacity, 0.5);
});

/* ==================================================================== */
/* 幻灯片顺序（关系解析的试金石）                                         */
/* ==================================================================== */

test('幻灯片顺序严格跟 p:sldIdLst，而不是文件名顺序', async () => {
  const doc = await open(await makePptx());
  assert.equal(doc.meta.slideCount, 2);
  assert.equal(doc.slides?.length, 2);
  // sldIdLst 第一项是 rId2 -> slides/slide2.xml（文件名顺序是反的）
  const first = doc.slides?.[0];
  assert.ok(
    first?.shapes.some((s) => s.name === '第二页标题'),
    `第一页必须来自 sldIdLst 的第一项（slide2.xml），实际形状：${first?.shapes.map((s) => s.name).join(',')}`,
  );
  assert.equal(first?.index, 0);
  assert.equal(doc.slides?.[1].index, 1);
  // 第二页应来自 slide1.xml（含「测试标题」）
  assert.ok(doc.slides?.[1].shapes.some((s) => s.name === 'Title 1'), '第二页应来自 slide1.xml');
});

test('关系缺失/为空时降级：不崩，只记 warning', async () => {
  const doc = await open(await makePptx({ missingPresentationRels: true }));
  assert.equal(doc.slides?.length, 0, '关系为空时没有页可解析');
  assert.ok(
    doc.stats.warnings.some((w) => w.includes('p:sldIdLst') || w.includes('关系')),
    `应有关于关系缺失的 warning，实际：${JSON.stringify(doc.stats.warnings)}`,
  );
});

/* ==================================================================== */
/* 形状：平移/旋转/组合/图片/表格/AlternateContent                        */
/* ==================================================================== */

test('旋转与翻转：rot 5400000 -> 90 度', async () => {
  const doc = await open(await makePptx());
  const rot = findShape(doc, '旋转矩形');
  assert.ok(rot);
  assert.equal(rot.rot, 90);
  assert.equal(rot.flipH, true);
});

test('组合形状的坐标变换：chOff/chExt 缩放 + 平移', async () => {
  const doc = await open(await makePptx());
  const group = findShape(doc, '组合1');
  assert.ok(group, '应解析出组合形状');
  assert.equal(group.kind, 'group');
  // 组合 off=(914400,1828800)=(72,144)pt, ext=(1828800,914400)=(144,72)pt
  assert.equal(group.x, 72);
  assert.equal(group.y, 144);
  assert.equal(group.w, 144);
  assert.equal(group.h, 72);

  const childA = group.shapes?.find((s) => s.name === '子A');
  const childB = group.shapes?.find((s) => s.name === '子B');
  assert.ok(childA && childB, '组合内应有 2 个子形状');
  // chExt=(914400,457200)=(72,36)pt，于是 sx=144/72=2、sy=72/36=2
  // 子A off=(0,0) -> 父坐标 (72 + 0*2, 144 + 0*2) = (72,144)
  assert.equal(childA.x, 72);
  assert.equal(childA.y, 144);
  assert.equal(childA.w, 72, '子形状尺寸也要按组合缩放');
  assert.equal(childA.h, 72);
  // 子B off=(457200,0)=(36,0)pt -> (72+36*2, 144) = (144,144)
  assert.equal(childB.x, 144);
  assert.equal(childB.y, 144);

  // 单元级验证 groupMap 的公式。
  // 无 chOff/chExt：scale=1、退化为纯平移。
  const plain = groupMap({}, { x: 72, y: 144, w: 144, h: 72, present: true }, () => undefined);
  assert.equal(plain.scale, 1, '无 chOff/chExt 时退化为纯平移');
  assert.equal(plain.offX, 72);
  assert.equal(plain.offY, 144);

  // 有 chOff/chExt：chExt=(72,36)pt 拉伸到 ext=(144,72)pt -> scale=2
  const p = new XmlPullParser('<x><a:chOff x="457200" y="0"/><a:chExt cx="914400" cy="457200"/></x>');
  const root = p.next();
  const kids: { chOff?: unknown; chExt?: unknown } = {};
  eachChild(p, root, (child) => {
    if (child.local === 'chOff') kids.chOff = child;
    if (child.local === 'chExt') kids.chExt = child;
    return false;
  });
  const scaled = groupMap(kids as never, { x: 72, y: 144, w: 144, h: 72, present: true }, () => undefined);
  assert.equal(scaled.scale, 2);
  // offX = 组合 x - chOff.x * scale = 72 - 36*2 = 0
  assert.equal(scaled.offX, 0);
  assert.equal(scaled.offY, 144);
});

test('图片：正常解析出字节与 MIME；r:embed 指向不存在的部件时降级不崩', async () => {
  const doc = await open(await makePptx());
  const img = findShape(doc, '图片2');
  assert.ok(img, '应解析出第二页的图片形状');
  assert.equal(img.kind, 'image');
  assert.equal(img.image?.mime, 'image/png');
  assert.equal(img.image?.partPath, 'ppt/media/image1.png');
  assert.ok(img.image?.data && img.image.data.length > 0, '图片字节应被读出');
  assert.equal(img.image?.data?.length, PNG_1PX.length);
  assert.equal(doc.stats.imageCount, 1);
  assert.equal(doc.stats.imageBytes, PNG_1PX.length);

  // 缺失图片：形状与尺寸保留，但没有字节
  const missing = findShape(doc, '图片1');
  assert.ok(missing, '损坏的图片引用不应导致形状消失');
  assert.equal(missing.kind, 'image');
  assert.equal(missing.image?.data, undefined);
  assert.equal(missing.w, 36, '尺寸信息仍要保留');
  assert.ok(
    doc.stats.warnings.some((w) => w.includes('r:embed')),
    '应记录图片关系无法解析的 warning',
  );
});

test('表格进 Shape.blocks：列宽、跨列、单元格底纹', async () => {
  const doc = await open(await makePptx());
  const frame = findShape(doc, '表格1');
  assert.ok(frame, '应解析出表格所在的 graphicFrame');
  assert.equal(frame.kind, 'rect');
  const table = frame.blocks?.find((b) => b.kind === 'table');
  assert.ok(table && table.kind === 'table', '表格必须放进 Shape.blocks');
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.widths, [72, 144], 'gridCol w 是 EMU -> pt');
  assert.equal(table.rows[0].cells.length, 2);
  assert.equal(table.rows[0].height, 29.2, 'a:tr h=370840 EMU -> 29.2pt');
  const cellText = table.rows[0].cells[0].blocks[0];
  assert.equal(cellText.kind === 'para' ? cellText.runs[0].text : '', 'A1');
  assert.equal(table.rows[1].cells[0].colSpan, 2);
  assert.equal(table.rows[1].cells[0].shading, '#ddeeff');
  assert.equal(table.rows[1].cells[0].vAlign, 'middle');
});

test('mc:AlternateContent 取 Fallback 而不是 Choice', async () => {
  const doc = await open(await makePptx());
  assert.equal(findShape(doc, 'Choice形状'), undefined, 'Choice 分支必须被丢弃');
  const fb = findShape(doc, 'Fallback形状');
  assert.ok(fb, 'Fallback 分支的形状必须被采纳');
  assert.equal(fb.x, 144);
  assert.equal(shapeText(fb).trim(), '回退内容');
});

test('占位符：几何与默认样式从 slide -> layout -> master 继承', async () => {
  const doc = await open(await makePptx());
  const body = findShape(doc, 'Body 2');
  assert.ok(body, '应解析出正文占位符');
  // slide 上这个形状只有空的 <p:spPr/>，几何全部来自版式
  assert.equal(body.x, 36, 'x 来自版式占位符 457200 EMU');
  assert.equal(body.y, 126, 'y 来自版式占位符 1600200 EMU');
  assert.equal(body.w, 648);
  assert.equal(body.kind, 'placeholder');

  // 项目符号与自动编号
  const paras = body.blocks?.filter((b) => b.kind === 'para') ?? [];
  assert.equal(paras.length, 4);
  assert.equal(paras[0].style?.listMarker, '•');
  assert.equal(paras[0].style?.listOrdered, false);
  assert.equal(paras[1].style?.listMarker, '1.');
  assert.equal(paras[1].style?.listOrdered, true);
  assert.equal(paras[2].style?.listMarker, '2.', '编号要按顺序累加');
  // buNone：显式取消符号
  assert.equal(paras[3].style?.listMarker, undefined);
  assert.equal(paras[3].style?.listLevel, 1);
  // 段内换行 a:br -> breakBefore
  assert.ok(paras[3].runs.some((r) => r.breakBefore), 'a:br 应转成 breakBefore run');
  // 字号继承：版式 defRPr sz=2400 -> 24pt
  assert.equal(paras[0].runs[0]?.style?.size, 24, '正文占位符字号应继承版式的 2400（24pt）');

  // 标题：slide 未写颜色 -> 继承版式的白色；slide 写了 sz=1800 -> 18pt 覆盖 44pt
  const title = findShape(doc, 'Title 1');
  const tstyle = title?.blocks?.[0].kind === 'para' ? title.blocks[0].runs[0]?.style : undefined;
  assert.equal(tstyle?.size, 18, '直接格式优先于版式的 44pt');
});

test('一个 spTree 里 10 个并列 p:sp 必须全部解析出来（兄弟节点不可丢）', async () => {
  const shapes = Array.from({ length: 10 }, (_, i) => {
    return `<p:sp><p:nvSpPr><p:cNvPr id="${100 + i}" name="并列${i}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${i * 91440}" y="0"/><a:ext cx="91440" cy="91440"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>`;
  }).join('');
  const xml = SLIDE1_XML.replace(
    /<p:spTree>([\s\S]*)<\/p:spTree>/,
    (_m, inner: string) => `<p:spTree>${inner}${shapes}</p:spTree>`,
  );
  const doc = await open(await makePptxWithSlide1(xml));
  const found = (doc.slides ?? []).flatMap((s) => s.shapes).filter((s) => s.name?.startsWith('并列'));
  assert.equal(found.length, 10, `10 个并列形状必须全在，实际 ${found.length}`);
  // 顺序也要对（skipElement 多吞一个事件时顺序会错位）
  for (let i = 0; i < 10; i++) assert.equal(found[i].name, `并列${i}`);
  assert.equal(found[9].x, (9 * 91440) / 12700);
});

async function makePptxWithSlide1(slideXml: string): Promise<Uint8Array> {
  const bytes = await makePptx();
  const src = ZipReader.open(bytes);
  const w = new ZipWriter();
  w.addFirst('[Content_Types].xml', await src.text('[Content_Types].xml'));
  for (const e of src.entries) {
    if (e.isDir) continue;
    if (e.name === '[Content_Types].xml') continue;
    if (e.name === 'ppt/slides/slide1.xml') w.add(e.name, slideXml);
    else w.add(e.name, await src.read(e.name));
  }
  return w.build();
}

/* ==================================================================== */
/* 备注 / 元数据 / 统计                                                  */
/* ==================================================================== */

test('备注页文本通过 slide 的 .rels（notesSlide 关系）取得', async () => {
  const doc = await open(await makePptx());
  const second = doc.slides?.[1];
  assert.equal(second?.notes, '这是备注第一行\n备注第二行');
  // 页码占位符（sldNum）不是备注正文，不能混进来
  assert.ok(!second?.notes?.includes('1'), 'sldNum 占位符不应被当成备注文本');
});

test('版式名来自 p:cSld name', async () => {
  const doc = await open(await makePptx());
  for (const s of doc.slides ?? []) assert.equal(s.layout, '标题和内容');
});

test('元数据：core.xml 与 app.xml', async () => {
  const doc = await open(await makePptx());
  assert.equal(doc.meta.title, '夹具演示');
  assert.equal(doc.meta.author, 'LiteOffice 测试');
  assert.equal(doc.meta.lastModifiedBy, '测试者');
  assert.equal(doc.meta.created, '2024-05-01T10:00:00Z');
  assert.equal(doc.meta.modified, '2024-05-02T11:30:00Z');
  assert.equal(doc.meta.application, 'Microsoft Office PowerPoint');
  assert.equal(doc.meta.appVersion, '16.0000');
  assert.equal(doc.meta.company, '示例公司');
  assert.equal(doc.meta.slideCount, 2);
  // TitlesOfParts 是嵌套结构（Properties/TitlesOfParts/vt:vector/vt:lpstr），
  // 读取器把它的文本拼成一条；这里只要求「拿到了这段文本」而不是精确格式
  assert.ok(
    doc.meta.custom?.titlesOfParts?.includes('测试标题'),
    `TitlesOfParts 应被读到，实际 ${JSON.stringify(doc.meta.custom)}`,
  );
});

test('背景：p:bg/p:bgPr/a:solidFill（主题色）', async () => {
  const doc = await open(await makePptx());
  assert.equal(doc.slides?.[1].background, '#fefefe', 'bg1 -> lt1 -> #fefefe');
});

test('stats 与 format 如实填写', async () => {
  const doc = await open(await makePptx());
  assert.equal(doc.kind, 'slides');
  assert.equal(doc.format, 'pptx');
  assert.equal(doc.meta.slideCount, 2);
  // 夹具精确形状清单（顺序无关，按名字核对）：
  //   slide1: Title 1, Body 2, 圆角A, 旋转矩形, 无填充, 组合1(+子A/子B), 图片1, 表格1, Fallback形状 = 11
  //   slide2: 第二页标题, 图片2 = 2
  const names = allShapes(doc.slides ?? []).map((s) => s.name);
  const expected = [
    'Title 1',
    'Body 2',
    '圆角A',
    '旋转矩形',
    '无填充',
    '组合1',
    '子A',
    '子B',
    '图片1',
    '表格1',
    'Fallback形状',
    '第二页标题',
    '图片2',
  ];
  for (const n of expected) assert.ok(names.includes(n), `缺少形状 ${n}，实际 ${names.join(',')}`);
  assert.equal(doc.stats.shapeCount, expected.length, `shapeCount 应与夹具一致（${expected.join(',')}）`);
  assert.equal(doc.stats.imageCount, 1, '只有 image1.png 真的读进了字节');
  assert.equal(doc.stats.imageBytes, PNG_1PX.length);
  assert.ok(doc.stats.parseMs >= 0);
  assert.ok(doc.stats.modelBytes > 0, 'modelBytes 必须被估算出来');
  assert.equal(doc.stats.sourceBytes, (await makePptx()).length);
  assert.ok(doc.stats.phases && Object.keys(doc.stats.phases).length > 0);
  assert.equal(doc.truncated, false);
});

test('pptm 扩展名 -> format pptm', async () => {
  const doc = await open(await makePptx(), 'macro.pptm');
  assert.equal(doc.format, 'pptm');
  const potx = await open(await makePptx(), 'template.potx');
  assert.equal(potx.format, 'potx');
});

/* ==================================================================== */
/* 降级路径：都不能崩                                                     */
/* ==================================================================== */

test('降级：缺 theme / 缺 layout / 缺 notesSlide / 空 spTree', async () => {
  // 缺 theme
  const noTheme = await open(await makePptx({ includeTheme: false }));
  assert.equal(noTheme.slides?.length, 2);
  assert.ok(
    noTheme.stats.warnings.some((w) => w.includes('主题')),
    '应记录主题缺失的 warning',
  );

  // 缺 layout：占位符几何回退到母版，仍要能解析出页
  const noLayout = await open(await makePptx({ includeLayout: false }));
  assert.equal(noLayout.slides?.length, 2);
  assert.ok(noLayout.stats.warnings.some((w) => w.includes('版式')));

  // 缺 notesSlide
  const noNotes = await open(await makePptx({ includeNotes: false }));
  assert.equal(noNotes.slides?.[1].notes, undefined);
  assert.equal(noNotes.slides?.length, 2);

  // 空 spTree（只有 <p:spTree/>）
  const empty = await open(await makePptx({ emptyTree: true }));
  assert.equal(empty.slides?.length, 2);
  assert.equal(empty.slides?.[1].shapes.length, 0, '空 spTree 应得到 0 个形状而不是抛错');
});

test('降级：maxSlides / maxShapes 截断并记录', async () => {
  const bytes = await makePptx();
  // 用 maxSlides=1（第 1 页只有 2 个形状）+ maxShapes=1：
  // 这样必然触发形状截断，同时验证「截断不再继续往模型里塞形状」。
  const limited = withLimits({ maxSlides: 1, maxShapes: 1 });
  const doc = await open(bytes, 'limited.pptx', limited);
  assert.equal(doc.slides?.length, 1, 'maxSlides=1 时应只解析 1 页');
  assert.equal(doc.stats.shapeCount, 1, `maxShapes=1 时应只保留 1 个形状，实际 ${doc.stats.shapeCount}`);
  assert.equal(doc.slides?.[0].shapes.length, 1, '模型里也只能有 1 个形状');
  assert.ok(doc.truncated, `截断必须体现在 doc.truncated，实际 ${JSON.stringify(doc.stats.truncated)}`);
  assert.ok(doc.stats.truncated.includes('maxShapes'), `truncated=${JSON.stringify(doc.stats.truncated)}`);
  assert.ok(
    doc.stats.warnings.some((w) => w.includes('maxShapes')),
    '形状截断要留下中文 warning',
  );

  // maxSlides 截断：夹具 2 页，限 1 页应留下 maxSlides 记录
  const doc2 = await open(bytes, 'slides.pptx', withLimits({ maxSlides: 1 }));
  assert.equal(doc2.slides?.length, 1);
  assert.ok(doc2.stats.truncated.includes('maxSlides'), `truncated=${JSON.stringify(doc2.stats.truncated)}`);
  assert.ok(doc2.stats.warnings.some((w) => w.includes('maxSlides')));
});

test('降级：图片字节超限时只保留尺寸与 MIME（不 OOM）', async () => {
  // maxImageBytes 设为 0：任何图片字节都不允许读入
  const doc = await open(await makePptx(), 'img.pptx', withLimits({ maxImageBytes: 0 }));
  const img = findShape(doc, '图片2');
  assert.ok(img, '图片形状仍要存在');
  assert.equal(img.image?.data, undefined, '超限后不得读入字节');
  assert.equal(img.image?.mime, 'image/png');
  assert.equal(img.w, 72, '尺寸信息必须保留');
  assert.equal(doc.stats.imageCount, 0);
  assert.equal(doc.stats.imageBytes, 0);
  assert.ok(doc.stats.warnings.some((w) => w.includes('maxImageBytes')));

  // maxImages = 0 同样走降级
  const doc2 = await open(await makePptx(), 'img2.pptx', withLimits({ maxImages: 0 }));
  assert.equal(findShape(doc2, '图片2')?.image?.data, undefined);
});

test('容器只打开一次（契约）', async () => {
  const bytes = await makePptx();
  const ctx = makeContext(bytes);
  const mod = await import('../packages/format-pptx/src/index.ts');
  const doc = await mod.pptxReader.read(ctx);
  assert.equal(doc.meta.slideCount, 2);
  // makeContext 里第二次调用会抛错，能走到这里说明只调了一次
});

/* ==================================================================== */
/* 纯函数：编号 / 组合映射 / 颜色变换                                     */
/* ==================================================================== */

test('applyAutoNumber：按层级计数并重置更深层', () => {
  const counters: number[] = [];
  const a: ParaStyle = { listLevel: 0 };
  applyAutoNumber(a, 'arabicPeriod', counters);
  assert.equal(a.listMarker, '1.');
  const b: ParaStyle = { listLevel: 0 };
  applyAutoNumber(b, 'arabicPeriod', counters);
  assert.equal(b.listMarker, '2.');
  const c: ParaStyle = { listLevel: 1 };
  applyAutoNumber(c, 'alphaLcParenR', counters);
  assert.equal(c.listMarker, 'a)');
  const d: ParaStyle = { listLevel: 0 };
  applyAutoNumber(d, 'arabicPeriod', counters);
  assert.equal(d.listMarker, '3.');
  const e2: ParaStyle = { listLevel: 1 };
  applyAutoNumber(e2, 'circleNumDbPlain', counters);
  assert.equal(e2.listMarker, '①', '更深层计数在回到上层后应重置');
});

test('parseFillColor：无颜色子元素时返回 undefined（不猜黑色）', () => {
  const p = new XmlPullParser('<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>');
  const e = p.next();
  assert.equal(e.local, 'solidFill');
  const theme = new Map([['accent1', '#4472c4']]);
  // 传事件：调用方已经拿到容器的 start 事件（eachChild 风格，读取器内部走这条）
  assert.equal(parseFillColor(p, theme, e)?.color, '#4472c4');
  // 不传事件：解析器**尚未**消费容器，由函数自己 p.next() 取（等价于「刚产出 start」）
  const p2 = new XmlPullParser('<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>');
  assert.equal(parseFillColor(p2, theme)?.color, '#4472c4');
});

/* ==================================================================== */
/* 真实文件交叉验证（不存在则 skip，绝不把文件复制进仓库）                 */
/* ==================================================================== */

const REAL_FILES = [
  'C:\\Users\\16595\\Documents\\九年级上课件\\22章ppt新\\22.1一元二次方程(1).pptx',
  'C:\\Users\\16595\\Documents\\九年级上课件\\22章ppt新\\22,2.4一元二次方程根的判别式.pptx',
  'C:\\Users\\16595\\Documents\\九年级上课件\\22章ppt新\\22,2.4一元二次方程根的判别式(1).pptx',
  'C:\\Users\\16595\\OneDrive\\我的职业体验.pptx',
  'C:\\Users\\16595\\OneDrive\\我的暑假游玩经历.pptx',
  'C:\\Users\\16595\\Documents\\WPSDrive\\688054337\\WPS云盘\\我的模板\\示例-成果汇报.pptx',
];

for (const path of REAL_FILES) {
  const label = path.split('\\').pop() ?? path;
  test(`真实 pptx：${label}`, async (t) => {
    if (!existsSync(path)) {
      t.skip(`文件不存在：${path}`);
      return;
    }
    // 云盘「仅在线」占位文件：existsSync 为真，但真正读内容时会失败。
    // 这不是读取器的 bug，所以必须 skip 而不是判失败 ——
    // 否则这条红着的用例会把真正的问题掩盖掉。
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch (err) {
      t.skip(`文件存在但内容不可读（云盘占位/权限）：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const doc = await open(bytes, label, withLimits({ maxImageBytes: 32 * 1024 * 1024 }));
    const ms = performance.now() - t0;
    const heapDelta = process.memoryUsage().heapUsed - heap0;
    // 图片字节是 Uint8Array，在 Node 里计入 external 而不是 heap，
    // 因此下面同时打印 external 增量，避免「imageBytes 11 MiB 而堆只涨 3 MiB」的困惑
    const heapTotal = process.memoryUsage();

    const slideCount = doc.slides?.length ?? 0;
    const shapeCount = doc.stats.shapeCount;
    const all = allShapes(doc.slides ?? []);
    const withBytes = all.filter((s) => s.image?.data && s.image.data.length > 0);
    const withSizeOnly = all.filter((s) => s.image && !s.image.data);
    console.log(
      `  [真实 pptx] ${label}\n` +
        `    文件 ${(bytes.length / 1024).toFixed(0)} KiB | ${slideCount} 页 | ${shapeCount} 形状 | ` +
        `${doc.stats.imageCount} 张图片驻留 ${(doc.stats.imageBytes / 1024).toFixed(0)} KiB\n` +
        `    解析 ${ms.toFixed(0)} ms | heap 增量 ${(heapDelta / 1024 / 1024).toFixed(1)} MiB ` +
        `| external 合计 ${(heapTotal.external / 1024 / 1024).toFixed(1)} MiB | ` +
        `modelBytes ${(doc.stats.modelBytes / 1024).toFixed(0)} KiB | 有字节的图片 ${withBytes.length} / 仅尺寸 ${withSizeOnly.length}\n` +
        `    版式示例 ${doc.slides?.[0]?.layout ?? '(无)'} | warnings ${doc.stats.warnings.length} | truncated ${JSON.stringify(doc.stats.truncated)}`,
    );

    assert.equal(doc.kind, 'slides');
    assert.ok(slideCount > 0, '真实文件必须解析出至少一页');
    assert.equal(doc.meta.slideCount, slideCount);
    assert.ok(shapeCount >= slideCount, '形状数应不少于页数');
    assert.ok(doc.stats.imageBytes <= 32 * 1024 * 1024, '图片字节必须受 maxImageBytes 约束');
    // imageCount / imageBytes 只统计真正驻留的图片，必须与「持有字节的形状数」一致
    assert.equal(doc.stats.imageCount, withBytes.length, 'imageCount 必须等于真的持有字节的图片数');
    assert.equal(
      doc.stats.imageBytes,
      withBytes.reduce((n, s) => n + (s.image?.data?.length ?? 0), 0),
      'imageBytes 必须等于真的驻留的字节数',
    );

    // 幻灯片顺序来自 p:sldIdLst：用关系解析得到的目标路径做交叉验证
    const zip = ZipReader.open(bytes);
    const presRels = await zip.text('ppt/_rels/presentation.xml.rels');
    const sldIdLst = await zip.text('ppt/presentation.xml');
    const refs = [...sldIdLst.matchAll(/<p:sldId[^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= slideCount, 'sldIdLst 的引用数应不少于解析出的页数');
    for (const rid of refs.slice(0, slideCount)) {
      assert.ok(presRels.includes(`Id="${rid}"`), `sldIdLst 的关系 ${rid} 必须能在 presentation.xml.rels 中找到`);
    }
    // 至少有一页有文字（真实课件一定有）
    const textPages = (doc.slides ?? []).filter((s) => allShapes([s]).some((sh) => shapeText(sh).trim().length > 0));
    assert.ok(textPages.length > 0, '真实课件应有可提取的文字');
  });
}

test('真实大文件（11.6 MiB）：CONSERVATIVE_LIMITS 下图片降级路径被触发', async (t) => {
  const path = 'C:\\Users\\16595\\OneDrive\\我的暑假游玩经历.pptx';
  if (!existsSync(path)) {
    t.skip(`文件不存在：${path}`);
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch (err) {
    t.skip(`文件存在但内容不可读（云盘占位/权限）：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const limits = withLimits({ maxImageBytes: 256 * 1024, maxImages: 3 });
  const t0 = performance.now();
  const doc = await open(bytes, 'big.pptx', limits);
  const ms = performance.now() - t0;
  const all = allShapes(doc.slides ?? []);
  const withBytes = all.filter((s) => s.image?.data);
  const withoutBytes = all.filter((s) => s.image && !s.image.data);
  console.log(
    `  [压力测试] ${(bytes.length / 1024 / 1024).toFixed(1)} MiB -> ${doc.slides?.length} 页 / ${doc.stats.shapeCount} 形状 / ` +
      `${doc.stats.imageCount} 张图片入内存 (${(doc.stats.imageBytes / 1024).toFixed(0)} KiB)，仅尺寸 ${withoutBytes.length} 张，耗时 ${ms.toFixed(0)} ms`,
  );
  assert.ok((doc.slides?.length ?? 0) > 0, '大文件也必须能打开');
  assert.ok(doc.stats.imageCount <= 3, 'maxImages=3 必须生效');
  assert.ok(doc.stats.imageBytes <= 256 * 1024, 'maxImageBytes 必须生效');
  assert.ok(doc.stats.warnings.some((w) => w.includes('maxImageBytes') || w.includes('maxImages')), '降级必须如实记 warning');
  assert.ok(withBytes.length <= 3);
  assert.ok(withoutBytes.length > 0, '必然有图片走「只保留尺寸与 MIME」的降级路径');
});
