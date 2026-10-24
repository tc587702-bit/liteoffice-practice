/**
 * @liteoffice/format-pdf 验证。
 *
 * 分层策略（与 CONVENTIONS 一致）：
 *   A. **自造最小 PDF**（字节级手工拼装，含经典 xref 表）做精确断言 ——
 *      这样失败时能一眼看出是「哪个算子的哪一步算错了」，而不是被真实文件的
 *      复杂性掩盖。夹具用 buildPdf() 生成，偏移量由构造器自己算，不手填。
 *   B. 兜底路径：故意写错 xref、对象流、间接 /Length、损坏输入。
 *   C. **真实 PDF 交叉验证**：7 个工作区外的文件，缺失时 t.skip()。
 *      真实文件是唯一能证明「中文不乱码」的证据，所以要求打印提取文本样本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { deflateSync, deflateRawSync } from 'node:zlib';
import { registerReader } from '../packages/core/src/registry.ts';
import type { FormatReader, ReadContext } from '../packages/core/src/registry.ts';
import { withLimits, LimitGuard, memSnapshot, ReadError } from '../packages/core/src/index.ts';
import type { LiteDocument, PdfTextItem } from '../packages/core/src/index.ts';
import { pdfReader } from '../packages/format-pdf/src/index.ts';

registerReader(pdfReader);

/* ==================================================================== */
/* 最小 PDF 构造器                                                       */
/* ==================================================================== */

/** 流对象标记：{ dict, raw } */
interface StreamObj {
  dict: Record<string, unknown>;
  raw: Uint8Array;
}
function stream(dict: Record<string, unknown>, raw: Uint8Array | string, compress?: 'flate' | 'flate-raw'): StreamObj {
  const bytes = typeof raw === 'string' ? latin1Bytes(raw) : raw;
  const d: Record<string, unknown> = { ...dict };
  if (compress) {
    const packed = compress === 'flate' ? new Uint8Array(deflateSync(bytes)) : new Uint8Array(deflateRawSync(bytes));
    return { dict: { ...d, Filter: '/FlateDecode', Length: packed.length }, raw: packed };
  }
  return { dict: { ...d, Length: bytes.length }, raw: bytes };
}

const encoder = new TextEncoder();

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * 按 PDF 文本字符串的 UTF-16BE 约定编码（带 BOM FEFF）。
 *
 * 不能直接用 latin1Bytes：它按 `charCodeAt & 0xff` 截断，"测" (U+6D4B) 只会
 * 留下 0x4B，得到的根本不是合法的 UTF-16BE。按 ISO 32000-1 §7.9.2.2，
 * 非 ASCII 的文本字符串要么是 PDFDocEncoding，要么是「FEFF + UTF-16BE」。
 */
function utf16beBytes(s: string): Uint8Array {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = (c >> 8) & 0xff;
    out[3 + i * 2] = c & 0xff;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 把任意值编码成 PDF 语法。字符串用十六进制表示，避免括号/反斜杠转义干扰。 */
function enc(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v; // 调用方自己控制（/Name 或裸 token）
  if (v instanceof Uint8Array) return `<${[...v].map((b) => b.toString(16).padStart(2, '0')).join('')}>`;
  if (Array.isArray(v)) return `[${v.map(enc).join(' ')}]`;
  if (isStreamObj(v)) {
    const head = `<<${dictBody(v.dict)}>>\nstream\n`;
    return `${head}${rawToLatin1(v.raw)}\nendstream`;
  }
  const dict = v as Record<string, unknown>;
  return `<<${dictBody(dict)}>>`;
}

function dictBody(d: Record<string, unknown>): string {
  return Object.entries(d)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `/${k} ${enc(v)}`)
    .join(' ');
}

function isStreamObj(v: unknown): v is StreamObj {
  return typeof v === 'object' && v !== null && 'dict' in v && 'raw' in v && (v as StreamObj).raw instanceof Uint8Array;
}

function rawToLatin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode(...b.subarray(i, Math.min(i + 4096, b.length)));
  return s;
}

interface BuiltPdf {
  bytes: Uint8Array;
  /** 对象号 -> 字节偏移 */
  offsets: Map<number, number>;
}

interface BuildOptions {
  version?: string;
  /** 不写 xref/trailer（用于测试兜底路径） */
  noXref?: boolean;
  /** 把 xref 里的偏移统一加上这个值（用于测试偏移错位） */
  xrefShift?: number;
  trailerExtra?: Record<string, unknown>;
}

/**
 * 组装一个合法的 PDF。
 *
 * objects 的**下标就是对象号**（objects[0] 是对象 1）。这样测试里写
 * `offsets[3]` 就能直接拿到对象 3 的偏移，不用心算。
 *
 * `undefined` 表示「保留这个对象号但不写对象体」—— 用于对象流测试里
 * 「对象 3/4 被压缩进对象流」这种情形。此时 xref 第 3/4 条写成空闲条目，
 * 由测试自己另行构造（或走全文扫描）。
 */
function buildPdf(objects: unknown[], options: BuildOptions = {}): BuiltPdf {
  const version = options.version ?? '1.4';
  const parts: string[] = ['%PDF-' + version + '\n%\xE2\xE3\xCF\xD3\n'];
  const offsets = new Map<number, number>();
  let cursor = parts[0].length;

  for (let i = 0; i < objects.length; i++) {
    if (objects[i] === undefined) continue;
    const num = i + 1;
    const body = `${num} 0 obj\n${enc(objects[i])}\nendobj\n`;
    offsets.set(num, cursor);
    parts.push(body);
    cursor += body.length;
  }

  if (options.noXref) {
    return { bytes: latin1Bytes(parts.join('')), offsets };
  }

  const xrefOffset = cursor;
  const lines: string[] = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n'];
  for (let i = 0; i < objects.length; i++) {
    if (objects[i] === undefined) {
      // 该对象号在文件里不存在：写成空闲条目（对象流内的对象就是这样）
      lines.push('0000000000 00000 f \n');
      continue;
    }
    const off = (offsets.get(i + 1) ?? 0) + (options.xrefShift ?? 0);
    lines.push(`${String(off).padStart(10, '0')} 00000 n \n`);
  }
  const trailer = { Size: objects.length + 1, ...(options.trailerExtra ?? {}) };
  const tail = `${lines.join('')}trailer\n${enc(trailer)}\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(tail);
  return { bytes: latin1Bytes(parts.join('')), offsets };
}

/**
 * fixture 构造：参数是「对象体数组」，第 i 个元素的**对象号 = i + 1**。
 * 返回的 offsets 用**对象号**做键（不是偏移值！早期版本用偏移值做键，
 * 结果对象号 2 与对象号 4 的键都是 62，互相覆盖 —— 症状是「对象 2 解析成了字体」）。
 */
function simplePdf(
  content: string,
  fontDict: Record<string, unknown> | undefined,
  pageExtra: Record<string, unknown> = {},
  buildOptions: BuildOptions = {},
  fontResources?: Record<string, unknown>,
): BuiltPdf {
  const resources: Record<string, unknown> = { ...(fontResources ?? {}) };
  if (fontDict) resources.Font = { F1: '3 0 R' };
  else resources.Font = {};

  const objects: unknown[] = [
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    fontDict ? fontDict : { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica' },
    {
      Type: '/Page',
      Parent: '2 0 R',
      MediaBox: [0, 0, 612, 792],
      Resources: resources,
      Contents: '5 0 R',
      ...pageExtra,
    },
    stream({}, content),
  ];
  void encoder;
  return buildPdf(objects, buildOptions);
}

/* ==================================================================== */
/* 读取辅助                                                              */
/* ==================================================================== */

let docCounter = 0;

async function readBytes(bytes: Uint8Array, limits?: Partial<Parameters<typeof withLimits>[0]>, name = 'fixture.pdf'): Promise<LiteDocument> {
  const l = withLimits(limits);
  const guard = new LimitGuard(l);
  const ctx: ReadContext = {
    name,
    size: bytes.length,
    bytes: async () => bytes,
    limits: l,
    guard,
    phase: async (_n, fn) => fn(),
  };
  docCounter++;
  return pdfReader.read(ctx);
}

function textItems(doc: LiteDocument, page = 0): PdfTextItem[] {
  const items = doc.pages?.[page]?.items ?? [];
  return items.filter((i): i is PdfTextItem => i.kind === 'text');
}

/** 把一页的文本项按「阅读顺序」拼起来（y 降序，同 y 按 x 升序） */
function pageText(doc: LiteDocument, page = 0): string {
  const items = textItems(doc, page).slice();
  items.sort((a, b) => (Math.abs(a.y - b.y) > 1 ? b.y - a.y : a.x - b.x));
  return items.map((i) => i.text).join(' ');
}

/* ==================================================================== */
/* A. 自造最小 PDF：精确断言                                             */
/* ==================================================================== */

test('最小 PDF：页面尺寸、旋转、文本坐标与字号', async () => {
  const built = simplePdf('BT /F1 12 Tf 50 700 Td (Hello) Tj ET\n', {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc = await readBytes(built.bytes);

  assert.equal(doc.kind, 'pdf');
  assert.equal(doc.format, 'pdf');
  assert.equal(doc.meta.pageCount, 1);
  assert.equal(doc.pages?.length, 1);
  const page = doc.pages![0];
  assert.equal(page.width, 612);
  assert.equal(page.height, 792);
  assert.equal(page.rotate, undefined, '未声明 /Rotate 时不应写 rotate 字段');

  const items = textItems(doc);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'Hello');
  assert.equal(items[0].x, 50, 'Td 的 x 必须精确落到文本矩阵平移量');
  assert.equal(items[0].y, 700);
  assert.equal(items[0].size, 12, '字号是文本空间单位，不应被 CTM 影响');
  assert.equal(items[0].font, 'Helvetica');
  assert.equal(doc.meta.pageWidth, 612);
  assert.equal(doc.meta.pageHeight, 792);
});

test('页面旋转 90°：/Rotate 归一化 + meta 尺寸互换（横放）', async () => {
  const built = simplePdf('BT /F1 10 Tf 20 30 Td (R) Tj ET\n', undefined, { Rotate: 90 });
  const doc = await readBytes(built.bytes);
  const page = doc.pages![0];
  assert.equal(page.rotate, 90);
  assert.equal(page.width, 612, 'MediaBox 尺寸保持原始值');
  assert.equal(page.height, 792);
  assert.equal(doc.meta.pageWidth, 792, '旋转 90° 后显示宽度应换成 792');
  assert.equal(doc.meta.pageHeight, 612);

  // 负数与超过 360 的 /Rotate 也要归一化
  const built2 = simplePdf('BT /F1 10 Tf 0 0 Td (X) Tj ET\n', undefined, { Rotate: -90 });
  const doc2 = await readBytes(built2.bytes);
  assert.equal(doc2.pages![0].rotate, 270, '-90 应归一化为 270');
});

test('cm 变换 + 旋转矩阵：文本坐标与字号按手算值断言', async () => {
  // 内容流：先把用户空间旋转 90° 并平移 (100, 50)，再画 12pt 文本。
  // 手算：M = [cos90 sin90 -sin90 cos90 100 50] = [0 1 -1 0 100 50]
  //   文本矩阵平移 (0, 200) -> 用户空间点 (0, 200)
  //   设备坐标 = M · (0,200)_t = (0*0 + (-1)*200 + 100, 1*0 + 0*200 + 50) = (-100, 50)？
  // 注意：这里必须按正确定义算 —— PDF 矩阵 [a b c d e f] 作用于点 (x,y)：
  //   x' = a·x + c·y + e, y' = b·x + d·y + f
  // 取 cm = [0 1 -1 0 100 50]（即逆时针 90°）：
  //   (0,200) -> x' = 0*0 + (-1)*200 + 100 = -100 ; y' = 1*0 + 0*200 + 50 = 50
  // 为了得到「页面内」的坐标，这里改用顺时针 90°（cm = [0 -1 1 0 100 50]）：
  //   (0,200) -> x' = 0 + 1*200 + 100 = 300 ; y' = 0 + 0 + 50 = 50
  const content = 'BT 0 -1 1 0 100 50 cm /F1 12 Tf 0 200 Td (Rot) Tj ET\n';
  const built = simplePdf(content, {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc = await readBytes(built.bytes);
  const items = textItems(doc);
  assert.equal(items.length, 1);
  assert.equal(items[0].x, 300, `旋转后基线 x 应为 300，实际 ${items[0].x}`);
  assert.equal(items[0].y, 50, `旋转后基线 y 应为 50，实际 ${items[0].y}`);
  assert.equal(items[0].size, 12, `旋转 90° 后有效字号仍应为 12，实际 ${items[0].size}`);
});

test('cm 缩放：文本坐标与字号按缩放系数换算', async () => {
  // cm = [2 0 0 3 10 20]（x 放大 2 倍、y 放大 3 倍）
  // Td 100 50 -> 用户空间 (100, 50) -> 设备 (2*100+10, 3*50+20) = (210, 170)
  const content = 'BT 2 0 0 3 10 20 cm /F1 10 Tf 100 50 Td (S) Tj ET\n';
  const built = simplePdf(content, {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc = await readBytes(built.bytes);
  const it = textItems(doc)[0];
  assert.equal(it.x, 210);
  assert.equal(it.y, 170);
  // 有效字号 = Tfs × hypot(a, b) = 10 × 2 = 20
  assert.equal(it.size, 20, `x 方向放大 2 倍后有效字号应为 20，实际 ${it.size}`);
});

test('q/Q 矩阵栈：内层 cm 不得泄漏到外层', async () => {
  // 外层画 A（在 (10,10)），内层 q + cm 后画 B，Q 之后再画 C 应回到外层坐标系
  const content = [
    'BT /F1 10 Tf 10 10 Td (A) Tj ET',
    'q 5 0 0 5 100 100 cm',
    'BT /F1 10 Tf 10 10 Td (B) Tj ET',
    'Q',
    'BT /F1 10 Tf 10 10 Td (C) Tj ET',
  ].join('\n');
  const built = simplePdf(content, {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc = await readBytes(built.bytes);
  const items = textItems(doc);
  assert.equal(items.length, 3);
  // A 与 C 必须同坐标；B 必须在缩放后的位置
  assert.equal(items[0].x, 10);
  assert.equal(items[0].y, 10);
  assert.equal(items[1].x, 150, 'B 的 x = 5*10+100');
  assert.equal(items[1].y, 150, 'B 的 y = 5*10+100');
  assert.equal(items[1].size, 50, 'B 的有效字号 = 10*5');
  assert.equal(items[2].x, 10, 'Q 之后必须回到外层坐标系');
  assert.equal(items[2].y, 10);
  assert.equal(items[2].size, 10, 'Q 之后字号也应恢复');
});

test('TJ 字间距：数字按 1/1000 em 推进，<-100 时补空格', async () => {
  // 收尾的 mergeTextItems 会把同一行相邻片段合并，所以这里断言的是
  // 「最终文本里有没有那个空格」，以及「位置有没有被推移」—— 这两条才是
  // 用户能感知的行为（分几个条目是内部表示）。
  const built = simplePdf('BT /F1 10 Tf 1 0 0 1 0 0 Tm [(AB) -200 (CD)] TJ ET\n', {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc = await readBytes(built.bytes);
  const items = textItems(doc);
  assert.equal(items.length, 1, '同一行的片段会被合并成一个条目');
  assert.equal(pageText(doc), 'AB CD', '调整量 < -100 应在断点处补一个空格');

  // 调整量为正（收紧）时不应补空格
  const tight = simplePdf('BT /F1 10 Tf 1 0 0 1 0 0 Tm [(AB) 50 (CD)] TJ ET\n', {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc2 = await readBytes(tight.bytes);
  assert.equal(pageText(doc2), 'ABCD', '正向调整不补空格');

  // 位置：-200 应把后续文本右移 2pt（在合并后的宽度里体现为总宽变大）
  const tightWidth = textItems(doc2)[0].width ?? 0;
  const looseWidth = items[0].width ?? 0;
  assert.ok(
    Math.abs(looseWidth - tightWidth - 2) < 1.0,
    `-200 与 +50 的宽度差应约为 2.0pt（实际 ${(looseWidth - tightWidth).toFixed(2)}）`,
  );
});

test('字符串字面量：转义 ( ) \\ 与八进制 \\101', async () => {
  // 内容流里写 (a\(b\)c\\d\101) —— \101 是八进制 101 = 0x41 = 'A'
  const content = 'BT /F1 12 Tf 10 10 Td (a\\(b\\)c\\\\d\\101) Tj ET\n';
  const built = simplePdf(content, {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc = await readBytes(built.bytes);
  assert.equal(textItems(doc)[0].text, 'a(b)c\\dA');
});

test('字符串字面量：嵌套括号与 \\n \\t', async () => {
  const content = 'BT /F1 12 Tf 10 10 Td (x(y(z)y)x\\nT) Tj ET\n';
  const built = simplePdf(content, {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc = await readBytes(built.bytes);
  assert.equal(textItems(doc)[0].text, 'x(y(z)y)x\nT', '括号嵌套必须按深度匹配');
});

test('十六进制字符串 <...> 解码', async () => {
  // 48 65 6C 6C 6F = "Hello"
  const built = simplePdf('BT /F1 12 Tf 10 10 Td <48656C6C6F> Tj ET\n', {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc = await readBytes(built.bytes);
  assert.equal(textItems(doc)[0].text, 'Hello');

  // 奇数个十六进制位：末位补 0（0x4 -> 0x40 = '@'）
  const odd = simplePdf('BT /F1 12 Tf 10 10 Td <414> Tj ET\n', {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc2 = await readBytes(odd.bytes);
  assert.equal(textItems(doc2)[0].text, 'A@', '奇数位应补 0 后解码');
});

test('Td / TD / T* / TL 的换行定位', async () => {
  // TD 设置 leading=-18；T* 下移 18；Td 是相对定位
  const content = [
    'BT /F1 10 Tf 100 700 Td (L1) Tj',
    '0 -18 TD (L2) Tj', // 下移 18，并设置 leading=18
    'T* (L3) Tj', // 再下移 18
    '50 0 Td (L4) Tj', // 相对当前位置右移 50（y 不变）
    'ET',
  ].join('\n');
  const built = simplePdf(content, {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc = await readBytes(built.bytes);
  const items = textItems(doc);
  assert.equal(items.length, 4);
  assert.equal(items[0].text, 'L1');
  assert.equal(items[0].y, 700);
  assert.equal(items[1].text, 'L2');
  assert.equal(items[1].y, 682);
  assert.equal(items[2].text, 'L3');
  assert.equal(items[2].y, 664, 'T* 应按 leading 下移');
  assert.equal(items[3].text, 'L4');
  assert.equal(items[3].x, 150, 'Td 是相对定位（100+50）');
  assert.equal(items[3].y, 664, '水平 Td 不应改变 y');
});

test('Tj 与 TJ 混用、\' 与 " 隐含换行', async () => {
  // TL=40 而字号 10：行距明显大于「同一行」的容差（0.25em），
  // 这样三行不会被 mergeTextItems 粘成一条
  const content = [
    'BT /F1 10 Tf 40 TL 50 700 Td',
    '(A) Tj [(B)] TJ', // Tj 与 TJ 混用：TJ 必须接在 Tj 推进后的位置，不能退回行首
    "' (C) Tj", // ' 先换行再显示
    '2 1 (D) "', // " 先设置 Tw/Tc，再换行，再显示
    'ET',
  ].join('\n');
  const built = simplePdf(content, {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc = await readBytes(built.bytes);
  const items = textItems(doc);
  assert.equal(items.length, 3);
  assert.equal(items[0].text, 'AB');
  assert.equal(items[0].y, 700);
  // 若 TJ 把位置重置回行首，B 会与 A 重叠，合并宽度只有 5pt 而不是 10pt
  assert.ok(
    Math.abs((items[0].width ?? 0) - 10) < 0.5,
    `TJ 应接在 Tj 的宽度之后（合并宽度应约 10pt，实际 ${items[0].width}）`,
  );
  assert.equal(items[1].text, 'C');
  assert.equal(items[1].y, 660, "' 应隐含一次 T*");
  assert.equal(items[2].text, 'D');
  assert.equal(items[2].y, 620, '" 也应隐含一次 T*');
});

test('/ToUnicode CMap：bfchar 与 bfrange 都要生效', async () => {
  // 码 0x20 -> "A"；0x21..0x23 -> "B".."D"；0x81 -> 欧元符号
  // 注意 bfrange 的目标串是 **UTF-16BE 字符串**，`<21> <23> <0042>` 表示
  // lo=0x21 对应 U+0042，后续码位依次 +1。目标串长度必须是偶数，
  // 早期测试写成 `<0042>` 配 `<21> <24>`（3 个码位）其实是畸形数据。
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin begincmap',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    '2 beginbfchar',
    '<20> <0041>',
    '<81> <20AC>',
    'endbfchar',
    '1 beginbfrange',
    '<21> <23> <0042>',
    'endbfrange',
    'endcmap end end',
  ].join('\n');
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    {
      Type: '/Font',
      Subtype: '/Type1',
      BaseFont: '/Helvetica',
      Encoding: '/WinAnsiEncoding',
      ToUnicode: '6 0 R',
    },
    {
      Type: '/Page',
      Parent: '2 0 R',
      MediaBox: [0, 0, 612, 792],
      Resources: { Font: { F1: '3 0 R' } },
      Contents: '5 0 R',
    },
    stream({}, 'BT /F1 12 Tf 10 10 Td <2021222381> Tj ET\n'),
    stream({}, cmap),
  ]);
  const doc = await readBytes(built.bytes);
  const text = textItems(doc)[0].text;
  assert.equal(text, 'ABCD\u20ac', `ToUnicode 映射结果不符：${JSON.stringify(text)}`);
});

test('ToUnicode 的 bfrange 目标数组形式（真实文件里出现过的非规范写法）', async () => {
  const cmap = [
    '1 begincodespacerange <00> <FF> endcodespacerange',
    '1 beginbfrange',
    '<41> <43> [<0058> <0059> <005A>]',
    'endbfrange',
  ].join('\n');
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    { Type: '/Font', Subtype: '/Type1', BaseFont: '/F', Encoding: '/WinAnsiEncoding', ToUnicode: '6 0 R' },
    {
      Type: '/Page',
      Parent: '2 0 R',
      MediaBox: [0, 0, 612, 792],
      Resources: { Font: { F1: '3 0 R' } },
      Contents: '5 0 R',
    },
    stream({}, 'BT /F1 12 Tf 10 10 Td (ABC) Tj ET\n'),
    stream({}, cmap),
  ]);
  const doc = await readBytes(built.bytes);
  assert.equal(textItems(doc)[0].text, 'XYZ');
});

test('Type0 / Identity-H 双字节中文提取（2 字节 CID + ToUnicode）', async () => {
  // 码位 0x4E2D = 中，0x6587 = 文；内容流用十六进制串表示两个 2 字节码
  const cmap = [
    '2 begincodespacerange <0000> <FFFF> endcodespacerange',
    '1 beginbfchar',
    '<4E2D> <4E2D>',
    'endbfchar',
    '1 beginbfrange',
    '<6587> <6587> <6587>',
    'endbfrange',
  ].join('\n');
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    {
      Type: '/Font',
      Subtype: '/Type0',
      BaseFont: '/SimSun',
      Encoding: '/Identity-H',
      DescendantFonts: ['6 0 R'],
      ToUnicode: '7 0 R',
    },
    {
      Type: '/Page',
      Parent: '2 0 R',
      MediaBox: [0, 0, 595, 842],
      Resources: { Font: { F1: '3 0 R' } },
      Contents: '5 0 R',
    },
    stream({}, 'BT /F1 12 Tf 100 700 Td <4E2D6587> Tj ET\n'),
    {
      Type: '/Font',
      Subtype: '/CIDFontType2',
      BaseFont: '/SimSun',
      CIDSystemInfo: { Registry: '(Adobe)', Ordering: '(Identity)', Supplement: 0 },
      W: [0x4e2d, [1000], 0x6587, [1000]],
    },
    stream({}, cmap),
  ]);
  const doc = await readBytes(built.bytes);
  const items = textItems(doc);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, '中文', `Identity-H 中文提取失败：${JSON.stringify(items[0].text)}`);
  assert.equal(items[0].size, 12);
});

test('Type0 / Identity-H：无 ToUnicode 时按 CID 近似解码并记 warning', async () => {
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    { Type: '/Font', Subtype: '/Type0', BaseFont: '/SimSun', Encoding: '/Identity-H', DescendantFonts: ['6 0 R'] },
    {
      Type: '/Page',
      Parent: '2 0 R',
      MediaBox: [0, 0, 595, 842],
      Resources: { Font: { F1: '3 0 R' } },
      Contents: '5 0 R',
    },
    stream({}, 'BT /F1 12 Tf 10 10 Td <4E2D6587> Tj ET\n'),
    { Type: '/Font', Subtype: '/CIDFontType2', BaseFont: '/SimSun', CIDSystemInfo: { Registry: '(Adobe)', Ordering: '(Identity)', Supplement: 0 } },
  ]);
  const doc = await readBytes(built.bytes);
  assert.equal(textItems(doc)[0].text, '中文', 'Identity-H 下 CID 恰好等于 Unicode 码位时应直接解出');
  assert.ok(
    doc.stats.warnings.some((w) => w.includes('ToUnicode')),
    `应记录「缺少 /ToUnicode」的降级说明，实际 warnings=${JSON.stringify(doc.stats.warnings)}`,
  );
});

test('简单字体：WinAnsi 高区与 /Differences 字形名映射', async () => {
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    {
      Type: '/Font',
      Subtype: '/Type1',
      BaseFont: '/Helvetica',
      Encoding: { Type: '/Encoding', BaseEncoding: '/WinAnsiEncoding', Differences: [65, '/bullet', '/Euro'] },
    },
    {
      Type: '/Page',
      Parent: '2 0 R',
      MediaBox: [0, 0, 300, 300],
      Resources: { Font: { F1: '3 0 R' } },
      Contents: '5 0 R',
    },
    // 41 -> bullet, 42 -> Euro（Differences 覆盖）, E9 -> WinAnsi 的 é
    stream({}, 'BT /F1 12 Tf 10 10 Td <4142E9> Tj ET\n'),
  ]);
  const doc = await readBytes(built.bytes);
  const text = textItems(doc)[0].text;
  assert.deepEqual(
    [...text].map((c) => c.codePointAt(0)),
    [0x2022, 0x20ac, 0xe9],
    `/Differences 映射结果 ${JSON.stringify(text)}`,
  );
});

test('Tm 带缩放时 Td/TD 的位移必须被线性部分缩放（否则整页坐标被放大）', async () => {
  /*
   * 真实案例：WPS 导出的 PDF 用 `0.05 0 0 -0.05 x y Tm` 把文本空间缩到 1/20，
   * 再用 `300 0 TD` 逐字定位。此时 `300 0 TD` 的正确推进是 300 × 0.05 = **15pt**。
   *
   * 早期实现写成 matMul(translate, tlm)，把平移放在「最后应用」，
   * 于是平移跳过了 tlm 的缩放，`300 0 TD` 被当成 300pt —— **放大 20 倍**：
   *   一行字的 x 从 173 一路涨到 3256（页宽只有 595），字符全被甩到页面外，
   *   且在页面内表现为「一字一项 + 中间夹空格」，看起来就是整页乱码。
   *
   * 这个 bug 能潜伏是因为**所有既有测试的 Tm 缩放都是 1**，两种顺序等价。
   * 所以这里刻意用 0.5 的缩放。
   */
  const content = 'BT /F1 20 Tf 0.5 0 0 0.5 100 700 Tm (A) Tj 200 0 TD (B) Tj ET';
  const built = simplePdf(content, { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica' });
  const doc = await readBytes(built.bytes);
  const items = textItems(doc);

  assert.equal(items.length, 2, `应提取到 2 段文字，实际 ${items.length} 段`);
  assert.equal(items[0].text, 'A');
  assert.equal(items[1].text, 'B');

  // 关键断言：位移 200 文本单位 × 缩放 0.5 = 100pt。
  // 若顺序写反，这里会得到 200pt（放大 2 倍）。
  const dx = items[1].x - items[0].x;
  assert.ok(
    Math.abs(dx - 100) < 1,
    `TD 位移应为 200×0.5=100pt，实际 ${dx}pt${Math.abs(dx - 200) < 1 ? '（正是矩阵顺序写反的特征：位移没被缩放）' : ''}`,
  );
  // 字号也要跟着缩放：20 × 0.5 = 10pt
  assert.ok(Math.abs(items[0].size - 10) < 0.5, `字号应为 20×0.5=10pt，实际 ${items[0].size}`);
});

test('裸像素图 → BMP：BGR 顺序与自下而上都必须正确', async () => {
  /*
   * PDF 里「无过滤器 / 仅 FlateDecode」的图片解出来是**原始像素**，没有任何容器格式，
   * 浏览器显示不出来（用户看到的是「图片打不开」）。我们把它们包成 BMP。
   *
   * 这里用已知的 2×2 图像逐字节验证编码结果 —— 因为 BMP 有两个极易搞错的地方：
   *   1. 通道顺序是 **BGR**，不是 RGB
   *   2. 像素行是**自下而上**存的（第一行是图像的最后一行）
   * 搞错了不会报错，只会显示成「颜色通道互换 + 上下颠倒」的图，很难用肉眼归因。
   *
   * 图像（上排 → 下排）：
   *   红 (255,0,0)      绿 (0,255,0)
   *   蓝 (0,0,255)      白 (255,255,255)
   */
  const { rawToBmp } = await import('../packages/format-pdf/src/rawimage.ts');
  const rgb = new Uint8Array([
    255, 0, 0, 0, 255, 0, // 上排：红、绿
    0, 0, 255, 255, 255, 255, // 下排：蓝、白
  ]);
  const dict = { Width: 2, Height: 2, BitsPerComponent: 8, ColorSpace: { name: 'DeviceRGB' } };
  const bmp = rawToBmp(dict, rgb);

  assert.ok(bmp, '应能转换 8 位 DeviceRGB');
  const b = bmp!;
  // 头：'BM'，行长 2×3=6 → 补齐到 8，像素 8×2=16，总 54+16=70
  assert.equal(b.length, 70);
  assert.equal(b[0], 0x42);
  assert.equal(b[1], 0x4d);
  assert.equal(b[10], 54, '像素数据偏移应为 54');
  assert.equal(b[28], 24, '位深应为 24');
  // 像素区：第 0 行是**图像的最后一行**（蓝、白），通道为 BGR
  const px = [...b.slice(54)];
  assert.deepEqual(
    px,
    [
      255, 0, 0, 255, 255, 255, 0, 0, // 蓝 → BGR(255,0,0)；白 → BGR(255,255,255)；行尾 2 字节对齐
      0, 0, 255, 0, 255, 0, 0, 0, // 红 → BGR(0,0,255)；绿 → BGR(0,255,0)；行尾对齐
    ],
    `像素区应为「自下而上 + BGR」，实际 ${JSON.stringify(px)}`,
  );

  // 不支持的情形必须返回 undefined（调用方会显示占位，而不是花屏）
  assert.equal(rawToBmp({ ...dict, BitsPerComponent: 1 }, rgb), undefined, '1 位图暂不转换');
  assert.equal(rawToBmp({ ...dict, ColorSpace: { name: 'DeviceCMYK' } }, rgb), undefined, 'CMYK 不猜');
  assert.equal(rawToBmp(dict, rgb.slice(0, 5)), undefined, '数据不足时不越界读');
});

test('/Resources 与 /Font 为间接引用时仍能取到字体（否则整页变控制字符乱码）', async () => {
  /*
   * 真实案例：WPS 导出的 PDF 把资源写成三层间接引用 ——
   *     页面 /Resources 6 0 R  /  6 号对象 <</Font 7 0 R>>  /  7 号对象 <</F1 5 0 R>>
   *
   * 早期实现只在 /Resources 下按属性名取 `/Font`，**不做解引用**，于是把 `7 0 R`
   * 这个引用对象当成了字体字典 → 按名字查 F1 永远落空 → 落到「Latin-1 直译」兜底
   * → CID 字节被当控制字符原样吐出，整页文本变成 "\u0001 \u0002 \u0003\u0004..."。
   *
   * 症状判据（也是当时发现它的方式）：一份 9 页中文讲义提取出 **0 个汉字**。
   * 同类写法还有 `/XObject` 间接引用，所以 content.ts 里两个都改成了解引用。
   */
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' }, // 1
    { Type: '/Pages', Kids: ['3 0 R'], Count: 1 }, // 2
    {
      // 3 页面：/Resources 是间接引用
      Type: '/Page',
      Parent: '2 0 R',
      MediaBox: [0, 0, 612, 792],
      Resources: '6 0 R',
      Contents: '4 0 R',
    },
    stream({}, 'BT /F1 12 Tf 50 700 Td (Hello) Tj ET'), // 4
    { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' }, // 5
    { Font: '7 0 R' }, // 6 Resources：/Font 又是间接引用
    { F1: '5 0 R' }, // 7 真正的字体映射表
  ]);

  const doc = await readBytes(built.bytes);
  assert.equal(doc.pages?.length, 1);

  const items = textItems(doc);
  assert.equal(items.length, 1, `应提取到 1 段文字，实际 ${items.length} 段`);
  assert.equal(items[0].text, 'Hello');

  // 最关键的一条：绝不能退化成控制字符。字体取不到时的「Latin-1 直译」正是乱码来源。
  assert.ok(
    !/[\u0000-\u0008\u000b\u000e-\u001f]/.test(doc.text),
    `文本里出现控制字符，说明字体没被解析出来：${JSON.stringify(doc.text)}`,
  );
  assert.ok(!doc.stats.warnings.some((w) => /无法解析|Latin-1 直译/.test(w)), '不应出现「字体无法解析」的降级告警');
});

test('/Length 为间接引用时仍能正确切出流边界', async () => {
  const content = 'BT /F1 12 Tf 30 40 Td (IndirectLength) Tj ET\n';
  const cbytes = latin1Bytes(content);
  // 对象 5 是内容流，/Length 指向对象 6（一个整数对象）
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' },
    {
      Type: '/Page',
      Parent: '2 0 R',
      MediaBox: [0, 0, 612, 792],
      Resources: { Font: { F1: '3 0 R' } },
      Contents: '5 0 R',
    },
    stream({ Length: '6 0 R' }, cbytes),
    cbytes.length, // 对象 6：长度值
  ]);
  const doc = await readBytes(built.bytes);
  const items = textItems(doc);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'IndirectLength', '间接 /Length 解析失败会导致流被多切或少切');
  assert.equal(items[0].x, 30);
  assert.equal(items[0].y, 40);
});

test('FlateDecode（zlib）与 raw deflate 两种压缩都要能解', async () => {
  const content = 'BT /F1 14 Tf 11 22 Td (Deflated) Tj ET\n';
  for (const mode of ['flate', 'flate-raw'] as const) {
    const built = buildPdf([
      { Type: '/Catalog', Pages: '2 0 R' },
      { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
      { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' },
      {
        Type: '/Page',
        Parent: '2 0 R',
        MediaBox: [0, 0, 612, 792],
        Resources: { Font: { F1: '3 0 R' } },
        Contents: '5 0 R',
      },
      stream({}, content, mode),
    ]);
    const doc = await readBytes(built.bytes);
    assert.equal(textItems(doc)[0].text, 'Deflated', `${mode} 解压失败`);
    assert.equal(textItems(doc)[0].size, 14);
  }
});

test('/Contents 为流数组时按顺序拼接', async () => {
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' },
    {
      Type: '/Page',
      Parent: '2 0 R',
      MediaBox: [0, 0, 612, 792],
      Resources: { Font: { F1: '3 0 R' } },
      Contents: ['5 0 R', '6 0 R'],
    },
    stream({}, 'BT /F1 10 Tf 10 100 Td (First) Tj ET\n', 'flate'),
    stream({}, 'BT /F1 10 Tf 10 50 Td (Second) Tj ET\n'),
  ]);
  const doc = await readBytes(built.bytes);
  const items = textItems(doc);
  assert.equal(items.length, 2);
  assert.equal(items[0].text, 'First');
  assert.equal(items[1].text, 'Second');
});

test('基础图形：re 填充/描边、m+l 线段、颜色', async () => {
  const content = [
    '1 0 0 rg 0 0 1 RG 2 w',
    '10 10 100 50 re f',
    '200 10 100 50 re S',
    '0 0 1 rg',
    '0 0 0 RG',
    '50 200 m 150 200 l S',
    'ET',
  ].join('\n');
  const built = simplePdf(content, undefined);
  const doc = await readBytes(built.bytes);
  const items = doc.pages![0].items;
  const rects = items.filter((i) => i.kind === 'rect');
  const lines = items.filter((i) => i.kind === 'line');
  assert.equal(rects.length, 2, `应有 2 个矩形，实际 ${rects.length}`);
  assert.equal(lines.length, 1, `应有 1 条线段，实际 ${lines.length}`);
  const fillRect = rects[0];
  assert.deepEqual(
    { x: fillRect.x, y: fillRect.y, w: fillRect.w, h: fillRect.h },
    { x: 10, y: 10, w: 100, h: 50 },
  );
  assert.equal(fillRect.fill, '#ff0000', 'rg 设置的填充色应被记录');
  const strokeRect = rects[1];
  assert.equal(strokeRect.stroke, '#0000ff');
  assert.equal(strokeRect.lw, 2);
  const line = lines[0];
  assert.deepEqual({ x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2 }, { x1: 50, y1: 200, x2: 150, y2: 200 });
});

test('图形：cm 变换后的矩形与线段坐标', async () => {
  const content = ['2 0 0 2 10 20 cm', '0 0 10 10 re f', '0 0 5 0 m 10 0 l S'].join('\n');
  const built = simplePdf(content, undefined);
  const doc = await readBytes(built.bytes);
  const rect = doc.pages![0].items.find((i) => i.kind === 'rect');
  assert.ok(rect && rect.kind === 'rect');
  assert.deepEqual({ x: rect.x, y: rect.y, w: rect.w, h: rect.h }, { x: 10, y: 20, w: 20, h: 20 });
  const line = doc.pages![0].items.find((i) => i.kind === 'line');
  assert.ok(line && line.kind === 'line');
  assert.deepEqual({ x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2 }, { x1: 20, y1: 20, x2: 30, y2: 20 });
});

test('内嵌图片：DCTDecode（JPEG）直接保留字节并给出 mime', async () => {
  // 一段最小的「伪 JPEG」：FFD8 ... FFD9。不真的解码像素，只验证字节抽取与矩形。
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica' },
    {
      Type: '/Page',
      Parent: '2 0 R',
      MediaBox: [0, 0, 200, 200],
      Resources: { XObject: { Im1: '6 0 R' } },
      Contents: '5 0 R',
    },
    // 图片画在 (10,20) 尺寸 100x80
    stream({}, 'q 100 0 0 80 10 20 cm /Im1 Do Q\n'),
    stream({ Type: '/XObject', Subtype: '/Image', Width: 1, Height: 1, ColorSpace: '/DeviceRGB', BitsPerComponent: 8, Filter: '/DCTDecode' }, jpeg),
  ]);
  const doc = await readBytes(built.bytes);
  const img = doc.pages![0].items.find((i) => i.kind === 'image');
  assert.ok(img && img.kind === 'image', '应产出图片条目');
  assert.equal(img.mime, 'image/jpeg');
  assert.deepEqual({ x: img.x, y: img.y, w: img.w, h: img.h }, { x: 10, y: 20, w: 100, h: 80 });
  assert.ok(img.data, 'JPEG 字节应被保留（可直接交给 <img src=blob:>）');
  assert.deepEqual(Array.from(img.data!.subarray(0, 2)), [0xff, 0xd8]);
  assert.equal(doc.stats.imageCount, 1);
  assert.ok(doc.stats.imageBytes! >= jpeg.length);
});

test('内嵌图片：FlateDecode + PNG Predictor 12 的原始位图', async () => {
  // 4x2 灰度图，每行 4 字节；用 PNG Up 预测器编码（每行前加 1 字节 filter type）
  const row0 = [10, 20, 30, 40];
  const row1 = [5, 5, 5, 5];
  const raw = new Uint8Array([0, ...row0, 2, ...row1.map((v, i) => v - row0[i] < 0 ? v - row0[i] + 256 : v - row0[i])]);
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica' },
    { Type: '/Page', Parent: '2 0 R', MediaBox: [0, 0, 100, 100], Resources: { XObject: { Im1: '6 0 R' } }, Contents: '5 0 R' },
    stream({}, 'q 40 0 0 20 0 0 cm /Im1 Do Q\n'),
    stream(
      {
        Type: '/XObject',
        Subtype: '/Image',
        Width: 4,
        Height: 2,
        ColorSpace: '/DeviceGray',
        BitsPerComponent: 8,
        Filter: '/FlateDecode',
        DecodeParms: { Predictor: 12, Colors: 1, BitsPerComponent: 8, Columns: 4 },
      },
      raw,
      'flate',
    ),
  ]);
  const doc = await readBytes(built.bytes);
  const img = doc.pages![0].items.find((i) => i.kind === 'image');
  assert.ok(img && img.kind === 'image');
  /*
   * 裸像素图会被包成 BMP —— 因为浏览器无法直接显示「原始采样」，
   * 这正是用户看到「图片打不开」的原因。所以这里不再断言 image/x-raw-gray。
   *
   * 断言同时验证两层：PNG Up 预测器被正确还原 + BMP 是「自下而上 + BGR」。
   */
  assert.equal(img.mime, 'image/bmp', '裸像素图应被包成 BMP，否则浏览器显示不出来');
  const bmp = img.data!;
  assert.equal(bmp[0], 0x42);
  assert.equal(bmp[1], 0x4d);
  // 4×2 灰度：行 4×3=12 字节已对齐；像素区 = 24 字节
  assert.equal(bmp.length, 54 + 24);
  assert.deepEqual(
    Array.from(bmp.slice(54)),
    [
      5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, // 下排 = 图像第 2 行（自下而上）
      10, 10, 10, 20, 20, 20, 30, 30, 30, 40, 40, 40, // 上排 = 图像第 1 行
    ],
    'PNG Up 预测器应被还原，且 BMP 像素应为「自下而上、灰度展成三通道」',
  );
});

test('内联图片 BI/ID/EI（含 DCTDecode）', async () => {
  const jpegBytes = [0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22, 0xff, 0xd9];
  const jpegLatin = jpegBytes.map((b) => String.fromCharCode(b)).join('');
  const content = `q 30 0 0 30 5 5 cm\nBI /W 1 /H 1 /CS /RGB /BPC 8 /F /DCT ID ${jpegLatin} EI\nQ\nBT /F1 10 Tf 0 60 Td (After) Tj ET\n`;
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' },
    { Type: '/Page', Parent: '2 0 R', MediaBox: [0, 0, 100, 100], Resources: { Font: { F1: '3 0 R' } }, Contents: '5 0 R' },
    stream({}, content),
  ]);
  const doc = await readBytes(built.bytes);
  const items = doc.pages![0].items;
  const img = items.find((i) => i.kind === 'image');
  assert.ok(img && img.kind === 'image', '内联图片应被识别');
  assert.equal(img.mime, 'image/jpeg');
  // 关键：跳过内联图片后，后面的文字仍必须被正确解析（EI 定位错了就会丢文字）
  const after = items.find((i) => i.kind === 'text');
  assert.ok(after && after.kind === 'text', '内联图片之后的文本必须仍能解析');
  assert.equal(after.text, 'After');
});

/* ==================================================================== */
/* B. 兜底与错误路径                                                     */
/* ==================================================================== */

test('兜底路径：xref 偏移全部写错时，全文扫描仍能打开', async () => {
  const content = 'BT /F1 12 Tf 77 88 Td (Fallback) Tj ET\n';
  const built = simplePdf(content, {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  // 把所有偏移整体 +7，xref 就完全错了（指向每个对象中间的字节）
  const broken = buildPdf(
    [
      { Type: '/Catalog', Pages: '2 0 R' },
      { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
      { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' },
      { Type: '/Page', Parent: '2 0 R', MediaBox: [0, 0, 612, 792], Resources: { Font: { F1: '3 0 R' } }, Contents: '5 0 R' },
      stream({}, content),
    ],
    { xrefShift: 7 },
  );
  assert.equal(broken.bytes.length, built.bytes.length);
  const doc = await readBytes(broken.bytes);
  assert.equal(doc.pages?.length, 1, 'xref 错位也必须能扫出页面');
  assert.equal(textItems(doc)[0].text, 'Fallback');
  assert.ok(
    doc.stats.warnings.some((w) => w.includes('扫描')),
    `应记录走了全文扫描兜底，实际 warnings=${JSON.stringify(doc.stats.warnings)}`,
  );
});

test('兜底路径：完全没有 xref（没有 trailer/startxref）时也能打开', async () => {
  const built = buildPdf(
    [
      { Type: '/Catalog', Pages: '2 0 R' },
      { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
      { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' },
      { Type: '/Page', Parent: '2 0 R', MediaBox: [0, 0, 300, 400], Resources: { Font: { F1: '3 0 R' } }, Contents: '5 0 R' },
      stream({}, 'BT /F1 9 Tf 5 6 Td (NoXref) Tj ET\n'),
    ],
    { noXref: true },
  );
  const doc = await readBytes(built.bytes);
  assert.equal(textItems(doc)[0].text, 'NoXref');
  assert.equal(doc.pages![0].width, 300);
});

test('对象流 /ObjStm：压缩进对象流的对象也能取到', async () => {
  // 对象流内含对象 3（字体）与 4（内容流）；对象 4 内部再引用对象 3 —— 
  // 这能同时验证「对象流内的对象」与「对象流内的间接引用」两条路径。
  const inner3 = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  const inner4raw = 'BT /F1 12 Tf 42 43 Td (ObjStm) Tj ET\n';
  const inner4 = `<< /Length ${inner4raw.length} >>\nstream\n${inner4raw}\nendstream`;
  const h1 = `${inner3}\n`;
  const h2 = `${inner3}\n${inner4}\n`;
  const header = `3 0 4 ${h1.length} `;
  const objStmData = header + h2;
  const packed = new Uint8Array(deflateSync(latin1Bytes(objStmData)));

  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['5 0 R'], Count: 1 },
    undefined, // 对象 3 在对象流里
    undefined, // 对象 4 在对象流里
    { Type: '/Page', Parent: '2 0 R', MediaBox: [0, 0, 500, 600], Resources: { Font: { F1: '3 0 R' } }, Contents: '4 0 R' },
    // 数据是 deflate 压过的，字典必须同时声明 /Filter /FlateDecode ——
    // 少了它，读取器只能按「未压缩」拿字节，对象流头部自然是二进制乱码。
    stream({ Type: '/ObjStm', N: 2, First: header.length, Filter: '/FlateDecode' }, packed),
  ]);
  const doc = await readBytes(built.bytes);
  assert.equal(doc.pages?.length, 1);
  const items = textItems(doc);
  assert.equal(items.length, 1, `对象流内的内容流应被解出，warnings=${JSON.stringify(doc.stats.warnings)}`);
  assert.equal(items[0].text, 'ObjStm');
  assert.equal(items[0].x, 42);
  assert.equal(items[0].y, 43);
  assert.equal(doc.pages![0].width, 500, '对象流外的页对象也要正常');
});

test('交叉引用流 /XRef（PDF 1.5+）：type 1 与 type 2 条目混合', async () => {
  // 对象 3、4 放在对象流（对象 6）里，由 xref 流的 type=2 条目指向
  const inner3 = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  const inner4raw = 'BT /F1 11 Tf 21 22 Td (XRefStream) Tj ET\n';
  const inner4 = `<< /Length ${inner4raw.length} >>\nstream\n${inner4raw}\nendstream`;
  const header = `3 0 4 ${inner3.length + 1} `;
  const objStmData = header + inner3 + '\n' + inner4 + '\n';
  const objStmPacked = new Uint8Array(deflateSync(latin1Bytes(objStmData)));

  // 先手工构造除了 xref 流以外的部分，记下每个对象的偏移
  const head = '%PDF-1.5\n%\xE2\xE3\xCF\xD3\n';
  const objTexts: Array<{ num: number; text: string }> = [
    { num: 1, text: `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` },
    { num: 2, text: `2 0 obj\n<< /Type /Pages /Kids [5 0 R] /Count 1 >>\nendobj\n` },
    { num: 5, text: `5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>\nendobj\n` },
    { num: 6, text: `6 0 obj\n<< /Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode /Length ${objStmPacked.length} >>\nstream\n${rawToLatin1(objStmPacked)}\nendstream\nendobj\n` },
  ];
  const offsets = new Map<number, number>();
  let cursor = head.length;
  const chunks = [head];
  for (const o of objTexts) {
    offsets.set(o.num, cursor);
    chunks.push(o.text);
    cursor += o.text.length;
  }
  // 交叉引用流：对象 7。/W [1 2 2]，type=1 的普通对象 + type=2 的对象流条目
  const xrefNum = 7;
  const xrefOffset = cursor;
  const entries: Array<[number, number, number]> = [];
  // 对象 0..7 共 8 条
  entries.push([0, 0, 65535]); // 0: 空闲
  entries.push([1, offsets.get(1)!, 0]);
  entries.push([1, offsets.get(2)!, 0]);
  entries.push([2, 6, 0]); // 对象 3 -> 对象流 6 的第 0 个
  entries.push([2, 6, 1]); // 对象 4 -> 对象流 6 的第 1 个
  entries.push([1, offsets.get(5)!, 0]);
  entries.push([1, offsets.get(6)!, 0]);
  entries.push([1, xrefOffset, 0]); // 对象 7 是 xref 流自己
  const rows = new Uint8Array(entries.length * 5);
  entries.forEach(([t, f2, f3], i) => {
    rows[i * 5] = t;
    rows[i * 5 + 1] = (f2 >> 8) & 0xff;
    rows[i * 5 + 2] = f2 & 0xff;
    rows[i * 5 + 3] = (f3 >> 8) & 0xff;
    rows[i * 5 + 4] = f3 & 0xff;
  });
  const xrefStream = new Uint8Array(deflateSync(rows));
  const xrefText =
    `${xrefNum} 0 obj\n<< /Type /XRef /Size 8 /W [1 2 2] /Root 1 0 R /Filter /FlateDecode /Length ${xrefStream.length} >>\nstream\n${rawToLatin1(xrefStream)}\nendstream\nendobj\n`;
  chunks.push(xrefText);
  const tail = `startxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(tail);

  const bytes = latin1Bytes(chunks.join(''));
  const doc = await readBytes(bytes);
  assert.equal(doc.pages?.length, 1, `交叉引用流应能建立对象表，warnings=${JSON.stringify(doc.stats.warnings)}`);
  const items = textItems(doc);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'XRefStream', 'type=2 条目指向的对象流内容应被解出');
  assert.equal(doc.pages![0].width, 400);
});

test('/Prev 链：增量更新时后写的 xref 段覆盖先写的', async () => {
  // 先写一版页面 MediaBox 300x300，再用增量更新把页码对象改写成 500x500。
  // 增量更新后的 trailer 带 /Prev 指回旧 xref；两份 xref 必须被合并。
  const head = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  let cursor = head.length;
  const parts: string[] = [head];
  const off = new Map<number, number>();

  function add(num: number, text: string): void {
    off.set(num, cursor);
    parts.push(text);
    cursor += text.length;
  }

  add(1, `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  add(2, `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  add(3, `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>\nendobj\n`);

  // 第一段 xref
  const xref1Offset = cursor;
  const x1 = [`xref\n0 4\n`, '0000000000 65535 f \n'];
  for (const n of [1, 2, 3]) x1.push(`${String(off.get(n)).padStart(10, '0')} 00000 n \n`);
  const x1text = `${x1.join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref1Offset}\n%%EOF\n`;
  parts.push(x1text);
  cursor += x1text.length;

  // 增量更新：改写对象 3（尺寸 500x500）
  const newOff3 = cursor;
  const upd = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 500] >>\nendobj\n`;
  parts.push(upd);
  cursor += upd.length;

  const xref2Offset = cursor;
  const x2 = [`xref\n3 1\n`, `${String(newOff3).padStart(10, '0')} 00000 n \n`];
  const x2text = `${x2.join('')}trailer\n<< /Size 4 /Root 1 0 R /Prev ${xref1Offset} >>\nstartxref\n${xref2Offset}\n%%EOF\n`;
  parts.push(x2text);

  const bytes = latin1Bytes(parts.join(''));
  const doc = await readBytes(bytes);
  assert.equal(doc.pages?.length, 1);
  assert.equal(
    doc.pages![0].width,
    500,
    '增量更新后应取新版本的对象（/Prev 链必须合并，且后写的覆盖先写的）',
  );
});

test('对象流内的 ToUnicode CMap 也要能生效', async () => {
  const cmap = '1 begincodespacerange <00> <FF> endcodespacerange\n2 beginbfchar\n<41> <0061>\n<42> <0062>\nendbfchar\n';
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    { Type: '/Font', Subtype: '/Type1', BaseFont: '/F', Encoding: '/WinAnsiEncoding', ToUnicode: '6 0 R' },
    { Type: '/Page', Parent: '2 0 R', MediaBox: [0, 0, 100, 100], Resources: { Font: { F1: '3 0 R' } }, Contents: '5 0 R' },
    stream({}, 'BT /F1 12 Tf 1 2 Td (AB) Tj ET\n'),
    stream({}, cmap, 'flate'),
  ]);
  const doc = await readBytes(built.bytes);
  assert.equal(textItems(doc)[0].text, 'ab', '压缩过的 ToUnicode 流也必须先解压再解析');
});

test('加密 PDF：存在 /Encrypt 时抛 ENCRYPTED', async () => {
  const built = buildPdf(
    [
      { Type: '/Catalog', Pages: '2 0 R' },
      { Type: '/Pages', Kids: ['3 0 R'], Count: 1 },
      { Type: '/Page', Parent: '2 0 R', MediaBox: [0, 0, 100, 100] },
    ],
    { trailerExtra: { Encrypt: '4 0 R', ID: ['<0102>', '<0304>'] } },
  );
  await assert.rejects(
    () => readBytes(built.bytes),
    (err: unknown) => {
      assert.ok(err instanceof ReadError, '必须是 ReadError');
      assert.equal((err as ReadError).code, 'ENCRYPTED');
      return true;
    },
  );
});

test('损坏输入：%PDF- 后面全是垃圾字节也不崩', async () => {
  const junk = new Uint8Array(4096);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 131) & 0xff;
  const head = latin1Bytes('%PDF-1.7\n');
  const bytes = concat([head, junk]);
  await assert.rejects(
    () => readBytes(bytes),
    (err: unknown) => {
      assert.ok(err instanceof ReadError, `应抛 ReadError，实际 ${String(err)}`);
      assert.equal((err as ReadError).code, 'CORRUPT');
      return true;
    },
  );
});

test('损坏输入：非 PDF 字节直接抛 CORRUPT（不是崩溃或超时）', async () => {
  const notPdf = encoder.encode('这不是 PDF，只是一段中文文本。'.repeat(50));
  await assert.rejects(() => readBytes(notPdf), /CORRUPT|不是有效/);
});

test('损坏输入：对象结构被截断（无 endobj、流无 endstream）不崩', async () => {
  const built = simplePdf('BT /F1 12 Tf 10 10 Td (Truncated) Tj ET\n', {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  // 砍掉后 40% 的字节：xref/startxref 与部分对象都会缺失
  const cut = built.bytes.subarray(0, Math.floor(built.bytes.length * 0.6));
  const doc = await readBytes(cut);
  // 允许内容不全，但绝不能崩：页面数要么 1 要么 0（抛 CORRUPT 也算合格）
  assert.ok(doc.pages !== undefined);
});

test('maxPages 截断：超限时写进 stats.truncated 而不是抛错', async () => {
  const objects: unknown[] = [{ Type: '/Catalog', Pages: '2 0 R' }];
  const kids: string[] = [];
  for (let i = 0; i < 5; i++) kids.push(`${4 + i} 0 R`);
  objects.push({ Type: '/Pages', Kids: kids, Count: 5 });
  objects.push({ Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' });
  for (let i = 0; i < 5; i++) {
    objects.push({
      Type: '/Page',
      Parent: '2 0 R',
      MediaBox: [0, 0, 200, 200],
      Resources: { Font: { F1: '3 0 R' } },
      Contents: `${9 + i} 0 R`,
    });
  }
  for (let i = 0; i < 5; i++) objects.push(stream({}, `BT /F1 10 Tf 1 1 Td (P${i}) Tj ET\n`));
  const built = buildPdf(objects);
  const doc = await readBytes(built.bytes, { maxPages: 2 });
  assert.equal(doc.pages?.length, 2, '应只解析前 2 页');
  assert.ok(doc.truncated, 'truncated 必须为 true');
  assert.ok(doc.stats.truncated.includes('maxPages'), `truncated 应含 maxPages，实际 ${JSON.stringify(doc.stats.truncated)}`);
  assert.equal(doc.meta.pageCount, 2);
});

test('maxImages 截断：超限的图片保留位置但不再保留字节', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const content = 'q 10 0 0 10 0 0 cm /A Do Q q 10 0 0 10 20 0 cm /B Do Q\n';
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica' },
    { Type: '/Page', Parent: '2 0 R', MediaBox: [0, 0, 100, 100], Resources: { XObject: { A: '6 0 R', B: '7 0 R' } }, Contents: '5 0 R' },
    stream({}, content),
    stream({ Type: '/XObject', Subtype: '/Image', Width: 1, Height: 1, Filter: '/DCTDecode' }, jpeg),
    stream({ Type: '/XObject', Subtype: '/Image', Width: 1, Height: 1, Filter: '/DCTDecode' }, jpeg),
  ]);
  const doc = await readBytes(built.bytes, { maxImages: 1 });
  const imgs = doc.pages![0].items.filter((i) => i.kind === 'image');
  assert.equal(imgs.length, 2, '两处图片引用都应产出条目（位置不能丢）');
  assert.ok(imgs[0].kind === 'image' && imgs[0].data, '第一张应有字节');
  assert.ok(imgs[1].kind === 'image' && !imgs[1].data, '超限的第二张应只保留位置');
  assert.ok(doc.truncated);
  assert.ok(doc.stats.truncated.includes('maxImages'));
});

test('未知算子与不支持特性：降级记 warning，不抛错', async () => {
  const content = [
    'BT /F1 12 Tf 10 10 Td (OK) Tj ET',
    '100 100 m 200 200 l 300 100 l h f', // 多边形 -> 包围盒近似
    '0 0 m 10 0 20 10 30 0 c S', // 曲线 -> 包围盒近似
    'q 1 0 0 1 0 0 cm 10 10 50 50 re W n Q', // 裁剪
    '/P1 cs 0.5 scn', // 特殊色空间
    '0 0 m 5 5 l 10 0 l h 0 g sh', // 渐变
    'NONEXISTENT_OP',
    'BT /F1 12 Tf 5 5 Td (StillHere) Tj ET',
  ].join('\n');
  const built = simplePdf(content, {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc = await readBytes(built.bytes);
  const texts = textItems(doc).map((i) => i.text);
  assert.deepEqual(texts, ['OK', 'StillHere'], '不支持的特性不得吃掉后续文本');
  const w = doc.stats.warnings.join(' | ');
  assert.match(w, /多边形|包围盒/, `应记录多边形降级，实际 ${w}`);
  assert.match(w, /贝塞尔|包围盒/, `应记录曲线降级，实际 ${w}`);
  assert.match(w, /裁剪/, `应记录裁剪未还原，实际 ${w}`);
  assert.match(w, /渐变/, `应记录渐变未还原，实际 ${w}`);
  assert.match(w, /NONEXISTENT_OP/, `应记录未知算子，实际 ${w}`);
});

test('页面属性继承：/MediaBox、/Resources、/Rotate 写在 /Pages 上也要生效', async () => {
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    {
      Type: '/Pages',
      Kids: ['3 0 R', '4 0 R'],
      Count: 2,
      MediaBox: [0, 0, 400, 400],
      Rotate: 90,
      Resources: { Font: { F1: '5 0 R' } },
    },
    { Type: '/Page', Parent: '2 0 R', Contents: '6 0 R' },
    { Type: '/Page', Parent: '2 0 R', Contents: '7 0 R' },
    { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' },
    stream({}, 'BT /F1 10 Tf 10 10 Td (Inherited1) Tj ET\n'),
    stream({}, 'BT /F1 10 Tf 20 20 Td (Inherited2) Tj ET\n'),
  ]);
  const doc = await readBytes(built.bytes);
  assert.equal(doc.pages?.length, 2);
  for (const p of doc.pages!) {
    assert.equal(p.width, 400, 'MediaBox 必须从 /Pages 继承');
    assert.equal(p.height, 400);
    assert.equal(p.rotate, 90, 'Rotate 必须从 /Pages 继承');
  }
  assert.equal(textItems(doc, 0)[0].text, 'Inherited1', 'Resources 必须从 /Pages 继承');
  assert.equal(textItems(doc, 1)[0].text, 'Inherited2');
});

test('CropBox 优先于 MediaBox（打印可见区域语义）', async () => {
  const built = simplePdf('BT /F1 10 Tf 1 1 Td (Crop) Tj ET\n', undefined, {
    MediaBox: [0, 0, 612, 792],
    CropBox: [10, 20, 410, 620],
  });
  const doc = await readBytes(built.bytes);
  assert.equal(doc.pages![0].width, 400, 'CropBox 宽 410-10=400');
  assert.equal(doc.pages![0].height, 600, 'CropBox 高 620-20=600');
});

test('文档信息与 PDF 日期解析', async () => {
  const built = buildPdf(
    [
      { Type: '/Catalog', Pages: '2 0 R' },
      { Type: '/Pages', Kids: ['3 0 R'], Count: 1 },
      { Type: '/Page', Parent: '2 0 R', MediaBox: [0, 0, 200, 200] },
    ],
    {
      trailerExtra: {
        Info: '4 0 R',
      },
    },
  );
  // 追加一个 Info 对象（对象 4）需要重新构造，这里直接构造完整的
  void built;
  const info = {
    // 中文字符串按规范写成 UTF-16BE + BOM；PDFDocEncoding 只覆盖拉丁字符集
    Title: utf16beBytes('测试标题'),
    Author: '(Zhang San)',
    // 没有 BOM 的字节按 PDFDocEncoding 解释：0x80 = •（U+2022），0xE9 = é
    Subject: new Uint8Array([0x80, 0xe9]),
    Producer: '(LiteOffice Test)',
    CreationDate: '(D:20240102030405+08\'00\')',
  };
  const built2 = buildPdf(
    [
      { Type: '/Catalog', Pages: '2 0 R', Metadata: '5 0 R' },
      { Type: '/Pages', Kids: ['3 0 R'], Count: 1 },
      { Type: '/Page', Parent: '2 0 R', MediaBox: [0, 0, 200, 200] },
      info,
      stream({ Type: '/Metadata', Subtype: '/XML' }, '<x:xmpmeta><dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP 标题</rdf:li></rdf:Alt></dc:title><xmp:CreatorTool>UnitTestGen</xmp:CreatorTool></x:xmpmeta>'),
    ],
    { trailerExtra: { Info: '4 0 R' } },
  );
  const doc = await readBytes(built2.bytes);
  assert.equal(doc.meta.title, '测试标题', 'UTF-16BE（带 BOM）的还原');
  assert.equal(doc.meta.author, 'Zhang San');
  assert.equal(doc.meta.subject, '•é', 'PDFDocEncoding 高区（0x80 不是 Latin-1 控制字符）的还原');
  assert.equal(doc.meta.application, 'UnitTestGen', 'XMP 的 CreatorTool 应补上');
  assert.equal(doc.meta.appVersion, 'LiteOffice Test');
  assert.equal(doc.meta.created, '2024-01-02T03:04:05');
  assert.equal(doc.meta.pageCount, 1);
});

test('stats 如实填写：parseMs / modelBytes / blockCount / imageCount', async () => {
  const built = simplePdf('BT /F1 12 Tf 10 10 Td (Stats) Tj ET\n0 0 10 10 re f\n', {
    Type: '/Font',
    Subtype: '/Type1',
    BaseFont: '/Helvetica',
    Encoding: '/WinAnsiEncoding',
  });
  const doc = await readBytes(built.bytes);
  assert.ok(doc.stats.parseMs >= 0, 'parseMs 必须被填');
  assert.ok(doc.stats.modelBytes! > 0, 'modelBytes 必须被填');
  assert.equal(doc.stats.sourceBytes, built.bytes.length);
  assert.equal(doc.stats.blockCount, 2, 'blockCount 应等于条目总数（1 文本 + 1 矩形）');
  assert.equal(doc.stats.imageCount, 0);
  assert.equal(doc.stats.imageBytes, 0);
});

test('text 字段：跨页文本被汇总，便于全文检索', async () => {
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['3 0 R', '4 0 R'], Count: 2 },
    { Type: '/Page', Parent: '2 0 R', MediaBox: [0, 0, 200, 200], Resources: {}, Contents: '5 0 R' },
    { Type: '/Page', Parent: '2 0 R', MediaBox: [0, 0, 200, 200], Resources: {}, Contents: '6 0 R' },
    stream({}, 'BT /F1 10 Tf 1 1 Td (PageOne) Tj ET\n'),
    stream({}, 'BT /F1 10 Tf 1 1 Td (PageTwo) Tj ET\n'),
  ]);
  const doc = await readBytes(built.bytes);
  assert.ok(doc.text?.includes('PageOne'));
  assert.ok(doc.text?.includes('PageTwo'));
  assert.equal(doc.meta.charCount, 'PageOnePageTwo'.length);
});

test('dispose() 释放图片字节', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const built = buildPdf([
    { Type: '/Catalog', Pages: '2 0 R' },
    { Type: '/Pages', Kids: ['4 0 R'], Count: 1 },
    { Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica' },
    { Type: '/Page', Parent: '2 0 R', MediaBox: [0, 0, 100, 100], Resources: { XObject: { A: '6 0 R' } }, Contents: '5 0 R' },
    stream({}, 'q 10 0 0 10 0 0 cm /A Do Q\n'),
    stream({ Type: '/XObject', Subtype: '/Image', Width: 1, Height: 1, Filter: '/DCTDecode' }, jpeg),
  ]);
  const doc = await readBytes(built.bytes);
  const img = doc.pages![0].items.find((i) => i.kind === 'image');
  assert.ok(img && img.kind === 'image' && img.data);
  doc.dispose();
  assert.equal(img.data, undefined, 'dispose 后图片字节必须被释放');
});

/* ==================================================================== */
/* C. 真实 PDF 交叉验证                                                  */
/* ==================================================================== */

interface RealCase {
  label: string;
  path: string;
  /** 期望至少有多少页（保守下界，只为拦住「一页都没读到」这种硬错） */
  minPages: number;
  /** 期望至少有多少个文本项（OCR/纯图 PDF 可能为 0，所以按文件特性给） */
  minTextItems: number;
  /** 期望至少有多少张图片（纯图扫描件的判据） */
  minImages?: number;
}

const REAL_PDFS: RealCase[] = [
  {
    label: 'AHL-GEC-IDE 使用教程（图文教程，首选）',
    path: 'C:\\Users\\16595\\Downloads\\AHL-GEC-IDE使用教程.pdf',
    minPages: 5,
    minTextItems: 20,
  },
  {
    label: 'Linux 操作系统第一次上机（代码/表格多）',
    path: 'C:\\Users\\16595\\Downloads\\Linux+操作系统第一次上机 (1).pdf',
    minPages: 1,
    minTextItems: 5,
  },
  {
    label: '非安居区籍考生报考申请（70 KiB，小文件精确断言）',
    path: 'C:\\Users\\16595\\Documents\\非安居区籍考生报考申请.pdf',
    minPages: 1,
    minTextItems: 5,
  },
  {
    label: '相互作用力 练习题1（含公式/图形）',
    path: 'C:\\Users\\16595\\Documents\\相互作用力 练习题1.pdf',
    minPages: 1,
    // 该文件是纯图片扫描件（对象表里只有 /XObject /Image，没有字体），
    // 所以文本项下界只能是 0 —— 但图片必须被抽出来
    minTextItems: 0,
    minImages: 5,
  },
  {
    label: '2023 化学寒假高一讲义（带水印，测旋转/重复文字）',
    path: 'C:\\Users\\16595\\Documents\\WPSDrive\\688054337\\WPS云盘\\2023化学寒假高一讲义_加水印.pdf',
    minPages: 5,
    minTextItems: 20,
  },
  {
    label: '6aa26b24…pdf（4.2 MiB，压力测试首选）',
    path: 'C:\\Users\\16595\\Downloads\\6aa26b24-4a34-4952-b45e-08e3384e73c4.pdf',
    minPages: 1,
    minTextItems: 1,
  },
  {
    label: '2026 年上半年英语四级笔试准考证',
    path: 'C:\\Users\\16595\\Downloads\\2026年上半年英语四级笔试准考证(510903200706279635)(1).pdf',
    minPages: 1,
    minTextItems: 5,
  },
];

/** 判断一段文本里可读汉字的比例，用来一眼看出是否乱码 */
function cjkRatio(s: string): number {
  const cjk = s.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const visible = s.replace(/\s/g, '').length;
  return visible === 0 ? 0 : cjk / visible;
}

for (const rc of REAL_PDFS) {
  test(`真实 PDF：${rc.label}`, async (t) => {
    if (!existsSync(rc.path)) {
      t.skip(`文件不存在：${rc.path}`);
      return;
    }
    const bytes = new Uint8Array(readFileSync(rc.path));
    const heap0 = memSnapshot().heapUsedBytes;
    const t0 = Date.now();
    const doc = await readBytes(bytes, undefined, rc.path.split('\\').pop() ?? 'real.pdf');
    const ms = Date.now() - t0;
    const heap1 = memSnapshot().heapUsedBytes;

    const pages = doc.pages ?? [];
    const allItems = pages.flatMap((p) => p.items);
    const texts = allItems.filter((i): i is PdfTextItem => i.kind === 'text');
    const imgs = allItems.filter((i) => i.kind === 'image');
    const chars = texts.reduce((n, i) => n + i.text.length, 0);
    const perPage = pages.map((p) => p.items.filter((i) => i.kind === 'text').length);
    const maxPerPage = perPage.length ? Math.max(...perPage) : 0;

    console.log(
      `  [真实PDF] ${rc.label}\n` +
        `            文件 ${(bytes.length / 1024).toFixed(0)} KiB / ${pages.length} 页 / ` +
        `文本项 ${texts.length}（每页最多 ${maxPerPage}）/ 字符 ${chars} / 图片 ${imgs.length}` +
        `（${(doc.stats.imageBytes! / 1024).toFixed(0)} KiB）/ 耗时 ${ms} ms / 堆增量 ${((heap1 - heap0) / 1024 / 1024).toFixed(2)} MiB` +
        `\n            模型 ${(doc.stats.modelBytes! / 1024).toFixed(0)} KiB / 条目 ${allItems.length} / ` +
        `warnings ${doc.stats.warnings.length} 条`,
    );
    const sample = (doc.text ?? '').replace(/\s+/g, ' ').slice(0, 200);
    console.log(`            文本样本: ${sample}`);
    if (doc.stats.warnings.length) {
      console.log(`            warnings: ${doc.stats.warnings.slice(0, 5).join(' | ')}`);
    }

    assert.ok(pages.length >= rc.minPages, `页数 ${pages.length} 少于期望下界 ${rc.minPages}`);
    assert.ok(texts.length >= rc.minTextItems, `文本项 ${texts.length} 少于期望下界 ${rc.minTextItems}`);
    if (rc.minImages !== undefined) {
      assert.ok(imgs.length >= rc.minImages, `图片 ${imgs.length} 少于期望下界 ${rc.minImages}`);
    }
    // 字符数下界按文件类型给：有文本项的必须真的提取出字符
    if (rc.minTextItems > 0) assert.ok(chars > 0, '提取字符数必须 > 0');
    assert.ok(doc.stats.parseMs >= 0);
    assert.ok(doc.meta.pageCount === pages.length);
    // 页面尺寸必须合理（0 或 NaN 说明 MediaBox 继承没生效）
    for (const p of pages.slice(0, 3)) {
      assert.ok(p.width > 10 && p.width < 20000, `页宽异常: ${p.width}`);
      assert.ok(p.height > 10 && p.height < 20000, `页高异常: ${p.height}`);
    }
  });
}

test('真实 PDF：小文件（70 KiB）必须提取出可读汉字，不能是乱码', async (t) => {
  const path = 'C:\\Users\\16595\\Documents\\非安居区籍考生报考申请.pdf';
  if (!existsSync(path)) {
    t.skip(`文件不存在：${path}`);
    return;
  }
  const bytes = new Uint8Array(readFileSync(path));
  const doc = await readBytes(bytes, undefined, '非安居区籍考生报考申请.pdf');
  const text = doc.text ?? '';
  const head = text.replace(/\s+/g, ' ').slice(0, 200);
  console.log(`  [可读性检查] 前 200 字: ${head}`);
  console.log(`  [可读性检查] 汉字占比 ${(cjkRatio(text) * 100).toFixed(1)}%，总字符 ${text.length}`);

  assert.ok(text.length > 50, `提取文本过短（${text.length} 字），可能整页文本层没解出来`);
  assert.ok(cjkRatio(text) > 0.3, `汉字占比仅 ${(cjkRatio(text) * 100).toFixed(1)}%，疑似乱码`);
  assert.match(text, /[\u4e00-\u9fff]{2,}/, '必须包含连续汉字');
  // 该文件是「申请」类公文，标题里应当出现这些字之一
  assert.ok(
    /申请|报考|考生|非安居|姓名|身份证/.test(text),
    `提取文本里未出现任何预期关键词，实际样本：${head}`,
  );
});

test('真实 PDF：带水印的讲义 —— 页数与文本量应成比例（不漏页）', async (t) => {
  const path = 'C:\\Users\\16595\\Documents\\WPSDrive\\688054337\\WPS云盘\\2023化学寒假高一讲义_加水印.pdf';
  if (!existsSync(path)) {
    t.skip(`文件不存在：${path}`);
    return;
  }
  const bytes = new Uint8Array(readFileSync(path));
  const doc = await readBytes(bytes, undefined, 'watermark.pdf');
  const pages = doc.pages ?? [];
  const empty = pages.filter((p) => !p.items.some((i) => i.kind === 'text'));
  console.log(`  [水印件] ${pages.length} 页，其中 ${empty.length} 页没有任何文本项`);
  assert.ok(pages.length > 5, `页数偏少：${pages.length}`);
  assert.ok(
    empty.length <= Math.ceil(pages.length * 0.2),
    `超过 20% 的页面完全没有文本（${empty.length}/${pages.length}），可能是内容流解析漏页`,
  );
});

/**
 * 让测试进程拿到强制 GC 的能力（拿不到返回 undefined）。
 *
 * 为什么必须强制 GC：同进程测试里 `heapUsed` 的差值包含**尚未回收的临时对象**，
 * 它衡量的是「净分配」而不是「占用」。同一个 4.2 MiB 文件、同一份解析代码，
 * 只在 `tools/test.mjs format-pdf` 里跑和在整个 363 用例套件里跑，实测堆增量
 * 在 33～59 MiB 之间漂移（前面的用例让 V8 堆水位不同），于是这条断言的结果
 * 取决于跑法而不是解析器 —— 这种断言比没有断言更糟。
 *
 * `tools/test.mjs` 不会传 `--expose-gc`（它要同进程加载所有测试文件），
 * 所以这里用 Node 内置的 v8/vm 在运行时打开它；失败就如实跳过内存断言，
 * 功能断言照常执行（内存基准的权威口径在 bench/bench.mjs，那里是单进程 + --expose-gc）。
 */
function ensureForceGc(): (() => void) | undefined {
  const g = globalThis as unknown as { gc?: () => void };
  if (typeof g.gc === 'function') return () => g.gc?.();
  try {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as (() => void) | undefined;
    return typeof gc === 'function' ? gc : undefined;
  } catch {
    return undefined;
  }
}

test('大文件压力测试：堆增量应远小于按「字符串全文」处理的开销', async (t) => {
  const path = 'C:\\Users\\16595\\Downloads\\6aa26b24-4a34-4952-b45e-08e3384e73c4.pdf';
  if (!existsSync(path)) {
    t.skip(`文件不存在：${path}`);
    return;
  }
  const bytes = new Uint8Array(readFileSync(path));
  const gc = ensureForceGc();
  if (gc) gc();
  const heap0 = memSnapshot().heapUsedBytes;
  const t0 = Date.now();
  const doc = await readBytes(bytes, undefined, 'stress.pdf');
  const ms = Date.now() - t0;
  // 解析期的临时 token 必须先回收：否则量到的是「本轮分配峰值」，不是「文档占用」。
  // 文档本身（doc）仍然被引用，所以回收后剩下的就是它真正占的堆。
  if (gc) gc();
  const heap1 = memSnapshot().heapUsedBytes;
  const deltaMiB = (heap1 - heap0) / 1024 / 1024;
  const srcMiB = bytes.length / 1024 / 1024;
  console.log(
    `  [压力测试] 源文件 ${srcMiB.toFixed(2)} MiB -> ${doc.pages?.length} 页，` +
      `耗时 ${ms} ms，堆增量（GC 后驻留）${deltaMiB.toFixed(2)} MiB，模型 ${(doc.stats.modelBytes! / 1024 / 1024).toFixed(2)} MiB`,
  );
  assert.ok(doc.pages!.length > 0);
  // 关键低内存断言：GC 后的驻留增量不应超过源文件大小的 8 倍（正常人不会接近
  // 这个数，但「先把整个文件 decode 成字符串并留在文档里」这种做法会轻松超过它）。
  // 没有强制 GC 时 heapUsed 差值不可比，如实跳过而不是用噪声数字误报。
  if (gc) {
    assert.ok(
      deltaMiB < srcMiB * 8,
      `堆增量（GC 后）${deltaMiB.toFixed(2)} MiB 超过源文件 ${srcMiB.toFixed(2)} MiB 的 8 倍，可能没有按字节视图解析`,
    );
  } else {
    t.diagnostic('无法启用强制 GC：heapUsed 差值不可比，已跳过内存断言（功能断言仍生效）');
  }
});
