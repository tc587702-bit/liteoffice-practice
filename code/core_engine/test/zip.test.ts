/**
 * @liteoffice/zip 验证。
 *
 * A. 自研写入器 -> 自研读取器 往返（store 与 deflate 两种方式）
 * B. 读取工作区里**真实的 .docx**（由 Word/WPS 生成，不是自研产物）
 * C. 错误路径与安全阀
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZipReader, ZipWriter, crc32 } from '../packages/zip/src/index.ts';

const WORKSPACE = 'C:\\deepseekharness';

test('ZIP 往返：deflate 与 store 都能正确还原', async () => {
  const text = '轻办公 LiteOffice '.repeat(500);
  const binary = new Uint8Array(4096);
  for (let i = 0; i < binary.length; i++) binary[i] = (i * 37) & 0xff;

  const w = new ZipWriter();
  w.addFirst('[Content_Types].xml', '<Types/>');
  w.add('word/document.xml', text);
  w.add('mimetype', 'application/vnd.oasis.opendocument.text', { store: true });
  w.add('word/media/blob.bin', binary);
  const bytes = await w.build();

  const r = ZipReader.open(bytes);
  assert.equal(r.size, 4);
  assert.equal(r.entries[0].name, '[Content_Types].xml', 'addFirst 必须把条目排在第一位');

  assert.equal(await r.text('word/document.xml'), text);
  assert.equal(await r.text('mimetype'), 'application/vnd.oasis.opendocument.text');
  assert.equal(r.find('mimetype').method, 0, 'store 条目应为 method 0');
  assert.equal(r.find('word/document.xml').method, 8, '默认条目应为 deflate');
  assert.deepEqual(await r.read('word/media/blob.bin'), binary);

  assert.equal(r.find('word/document.xml').crc32, crc32(new TextEncoder().encode(text)));
  assert.equal(await r.verify('word/document.xml'), true);
  assert.equal(await r.verify('word/media/blob.bin'), true);
  assert.ok(r.find('word/document.xml').ratio < 0.2, `重复文本压缩率应很低，实际 ${r.find('word/document.xml').ratio}`);

  const streamed = await new Response(r.stream('word/document.xml')).text();
  assert.equal(streamed, text, 'stream() 与 read() 结果必须一致');

  // streamText() 产出的是字符串块，不能喂给 Response（Response 只收字节块）
  let streamedText = '';
  for await (const chunk of r.streamText('word/document.xml')) streamedText += chunk;
  assert.equal(streamedText, text, 'streamText() 与 read() 结果必须一致');
});

test('ZIP 错误处理：非 ZIP 输入、缺失条目、安全阀', async () => {
  assert.throws(() => ZipReader.open(new Uint8Array([1, 2, 3, 4, 5])), /EOCD/);

  const w = new ZipWriter();
  w.add('a.txt', 'hi');
  w.add('big.txt', 'x'.repeat(5000));
  const bytes = await w.build();

  const r = ZipReader.open(bytes);
  assert.equal(r.find('nope.txt'), undefined);
  assert.equal(r.has('a.txt'), true);
  assert.equal(await r.text('a.txt'), 'hi');
  await assert.rejects(() => r.read('nope.txt'), /未找到条目/);

  // 安全阀：把上限压到 1 KiB，big.txt 必须被拒绝而不是静默吃内存
  const guarded = ZipReader.open(bytes, { maxEntryBytes: 1024 });
  await assert.rejects(() => guarded.read('big.txt'), /超过上限|TOO_LARGE/);

  // 条目数上限
  assert.throws(() => ZipReader.open(bytes, { maxEntries: 1 }), /TOO_MANY_ENTRIES|超过上限/);
});

test('读取真实 .docx（Word/WPS 生成的 OOXML 包）', async (t) => {
  const candidates = ['二极管伏安特性实验报告.docx', '实验报告-1N4001伏安特性.docx', 'testF_del25.docx'];
  const hit = candidates.map((f) => join(WORKSPACE, f)).find((p) => existsSync(p));
  if (!hit) {
    t.skip('工作区没有可用的真实 .docx 夹具');
    return;
  }

  const bytes = new Uint8Array(readFileSync(hit));
  const r = ZipReader.open(bytes);
  console.log(`  [真实 docx] ${hit.split('\\').pop()}  ${(bytes.length / 1024).toFixed(0)} KiB, ${r.size} 个条目`);
  console.log(`  [真实 docx] 解压后总计 ${(r.totalUncompressedSize / 1024).toFixed(0)} KiB`);

  assert.ok(r.has('[Content_Types].xml'), 'OOXML 包必须有 [Content_Types].xml');
  assert.ok(r.has('word/document.xml'), 'docx 必须有 word/document.xml');

  const doc = await r.text('word/document.xml');
  assert.ok(doc.length > 1000, `document.xml 过短: ${doc.length}`);
  assert.match(doc, /<\?xml/);
  assert.match(doc, /<w:document[\s>]/);
  assert.match(doc, /<\/w:document>\s*$/);

  const probe = r.entries.filter((e) => !e.isDir).slice(0, 12);
  for (const e of probe) {
    assert.equal(await r.verify(e), true, `CRC 校验失败: ${e.name}`);
  }
  console.log(`  [真实 docx] 前 ${probe.length} 个条目 CRC 全部通过`);

  const parts = r.entries.map((e) => e.name);
  console.log(`  [真实 docx] 部件: ${parts.slice(0, 8).join(', ')}${parts.length > 8 ? ', …' : ''}`);
  assert.ok(parts.some((p) => p.startsWith('word/')), '应包含 word/ 部件');
});
