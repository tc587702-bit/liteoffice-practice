/**
 * @liteoffice/engine 嗅探验证。
 *
 * 用**构造的样例**覆盖每种判定分支，再用工作区里的**真实文件**做端到端确认。
 * 嗅探错了会导致派发错读取器并给出莫名错误，所以这里要求判定依据（reason）
 * 也必须是人话，而不只是一个枚举值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ZipWriter } from '../packages/zip/src/index.ts';
import { ZipReader } from '../packages/zip/src/index.ts';
import { sniffFormat, sniffDelimiter, looksBinary } from '../packages/engine/src/sniff.ts';

const enc = new TextEncoder();

async function zipBytes(entries: Record<string, string>, first?: string): Promise<Uint8Array> {
  const w = new ZipWriter();
  if (first) w.addFirst(first, entries[first]);
  for (const [k, v] of Object.entries(entries)) if (k !== first) w.add(k, v);
  return w.build();
}

async function sniff(bytes: Uint8Array, name: string, containerFrom?: Uint8Array) {
  const container = containerFrom ? ZipReader.open(containerFrom) : undefined;
  return sniffFormat(bytes, name, { container });
}

test('OOXML：按内部特征部件判定，忽略错误扩展名', async () => {
  const docx = await zipBytes({ 'word/document.xml': '<w:document/>', '[Content_Types].xml': '<Types/>' }, '[Content_Types].xml');
  // 故意的错误扩展名：应仍判定为 docx
  const r = await sniff(docx, 'foo.zip', docx);
  assert.equal(r.format, 'docx');
  assert.match(r.reason, /word\/document\.xml/);
  assert.equal(r.confidence, 1);

  const xlsx = await zipBytes({ 'xl/workbook.xml': '<workbook/>', '[Content_Types].xml': '<Types/>' }, '[Content_Types].xml');
  assert.equal((await sniff(xlsx, 'x.bin', xlsx)).format, 'xlsx');

  const pptx = await zipBytes({ 'ppt/presentation.xml': '<p:presentation/>', '[Content_Types].xml': '<Types/>' }, '[Content_Types].xml');
  assert.equal((await sniff(pptx, 'x.bin', pptx)).format, 'pptx');

  // 含宏 -> docm
  const docm = await zipBytes({ 'word/document.xml': '<w:document/>', 'word/vbaProject.bin': 'MZ', '[Content_Types].xml': '<Types/>' }, '[Content_Types].xml');
  assert.equal((await sniff(docm, 'x.bin', docm)).format, 'docm');
});

test('ODF：mimetype 条目是权威判据', async () => {
  const cases: Array<[string, string]> = [
    ['application/vnd.oasis.opendocument.text', 'odt'],
    ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
    ['application/vnd.oasis.opendocument.presentation', 'odp'],
    ['application/vnd.oasis.opendocument.graphics', 'odg'],
  ];
  for (const [mime, expected] of cases) {
    const bytes = await zipBytes({ mimetype: mime, 'content.xml': '<office:document-content/>' }, 'mimetype');
    const r = await sniff(bytes, 'wrong.docx', bytes);
    assert.equal(r.format, expected, `${mime} 应判定为 ${expected}`);
    assert.match(r.reason, /mimetype/);
  }
});

test('魔数判定：PDF / OLE2 / RTF', async () => {
  const pdf = enc.encode('%PDF-1.7\n1 0 obj\n');
  const r = await sniff(pdf, 'x.bin');
  assert.equal(r.format, 'pdf');
  assert.equal(r.confidence, 1);

  const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  assert.equal((await sniff(ole2, 'old.xls')).format, 'ole2-xls');
  assert.equal((await sniff(ole2, 'old.doc')).format, 'ole2-doc');
  assert.equal((await sniff(ole2, 'old.ppt')).format, 'ole2-ppt');

  const rtf = enc.encode('{\\rtf1\\ansi hello}');
  assert.equal((await sniff(rtf, 'x.bin')).format, 'rtf');
});

test('文本启发式：HTML / SVG / JSON / CSV / TSV / Markdown', async () => {
  assert.equal((await sniff(enc.encode('<!DOCTYPE html><html><body>hi</body></html>'), 'x.txt')).format, 'html');
  assert.equal((await sniff(enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'), 'x.txt')).format, 'svg');
  assert.equal((await sniff(enc.encode('{"a":[1,2,3],"b":"x"}'), 'x.txt')).format, 'json');
  assert.equal((await sniff(enc.encode('# 标题\n\n- 项目一\n- 项目二\n'), 'x.txt')).format, 'md');

  const csv = 'name,age,city\nAlice,30,Beijing\nBob,25,Shanghai\nCara,41,Guangzhou\n';
  const r = await sniff(enc.encode(csv), 'x.txt');
  assert.equal(r.format, 'csv');
  assert.match(r.reason, /逗号/);

  const tsv = 'a\tb\tc\n1\t2\t3\n4\t5\t6\n';
  assert.equal((await sniff(enc.encode(tsv), 'x.txt')).format, 'tsv');
});

test('CSV 探测不误判散文（列数稳定性才是判据）', () => {
  // 逗号很多但每行分隔符数量不一 -> 不是 CSV
  const prose = '这是一个句子，但不是逗号分隔。\n短句。\n另一个，句子，有逗号，但数量不同。\n';
  assert.equal(sniffDelimiter(prose), null);

  const real = 'a,b,c\n1,2,3\n4,5,6\n7,8,9\n';
  const d = sniffDelimiter(real);
  assert.ok(d, '规整的 CSV 应被识别');
  assert.equal(d.delimiter, ',');
  assert.equal(d.columns, 3);
  assert.equal(d.rows, 4);

  // 引号内的分隔符不应计入列
  const quoted = 'a,b\n"x,with,commas",2\n"y,also",3\n';
  assert.equal(sniffDelimiter(quoted).columns, 2);
});

test('扁平 ODF 靠 office:mimetype 判定', async () => {
  const fodt = '<?xml version="1.0"?><office:document office:mimetype="application/vnd.oasis.opendocument.text"><office:body/></office:document>';
  assert.equal((await sniff(enc.encode(fodt), 'x.fodt')).format, 'fodt');
  const fods = '<?xml version="1.0"?><office:document office:mimetype="application/vnd.oasis.opendocument.spreadsheet"/>';
  assert.equal((await sniff(enc.encode(fods), 'x.fods')).format, 'fods');
});

test('looksBinary 判定', () => {
  assert.equal(looksBinary(enc.encode('普通文本 hello world')), false);
  assert.equal(looksBinary(new Uint8Array([1, 0, 2, 0, 3, 0])), true);
});

test('工作区真实文件的嗅探结果', async (t) => {
  const dir = 'C:\\deepseekharness';
  const files = readdirSync(dir).filter((f) => /\.(docx|docm|xlsx|pptx|pdf|csv|md|txt)$/i.test(f)).slice(0, 40);
  if (files.length === 0) {
    t.skip('工作区没有可用样例');
    return;
  }
  let checked = 0;
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(join(dir, f)));
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const container = isZip ? ZipReader.open(bytes) : undefined;
    const r = await sniffFormat(bytes.subarray(0, 65536), f, { container });
    const ext = f.slice(f.lastIndexOf('.') + 1).toLowerCase();
    // 扩展名与实际格式都应在同一个 family 内
    const extFamily = { docx: 'text', docm: 'text', xlsx: 'sheet', pptx: 'slides', pdf: 'pdf', csv: 'sheet', md: 'text', txt: 'text' }[ext];
    console.log(`  ${f.padEnd(46)} -> ${r.format.padEnd(6)} (${(r.confidence * 100).toFixed(0)}%) ${r.reason}`);
    if (extFamily) {
      assert.equal(r.spec.kind, extFamily, `${f} 判定为 ${r.format}，kind=${r.spec.kind}，期望 ${extFamily}`);
    }
    checked++;
  }
  assert.ok(checked > 0, '应至少检查一个真实文件');
});
