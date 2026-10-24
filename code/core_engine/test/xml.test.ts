/**
 * @liteoffice/xml 验证。
 *
 * 重点是**跨块边界**：窗口模型最容易在标签被 chunkSize 切开时出错。
 * 因此下面几乎每个用例都用「极小 chunkSize」跑一遍，与整串解析结果对比。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XmlPullParser, decodeEntities, walkXml, xmlTextAt, splitName } from '../packages/xml/src/index.ts';

const enc = new TextEncoder();

/** 用给定 chunkSize 收集全部事件，用于与整串解析做等价对比。 */
function collect(input: string | Uint8Array, chunkSize?: number) {
  const p = new XmlPullParser(input, chunkSize ? { chunkSize } : {});
  const out: string[] = [];
  let e;
  while ((e = p.next()) !== null) {
    out.push(
      e.type === 'start'
        ? `start:${e.name}:${e.selfClosing ? 'self' : 'open'}:${JSON.stringify(e.attrs)}`
        : e.type === 'end'
          ? `end:${e.name}`
          : `${e.type}:${JSON.stringify(e.text)}`,
    );
  }
  return out;
}

const SAMPLE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!-- 顶层注释 -->
<!DOCTYPE doc [ <!ELEMENT doc ANY> ]>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" attr="a&gt;b">
  <w:body>
    <w:p>
      <w:pPr><w:jc w:val="center"/></w:pPr>
      <w:r><w:t xml:space="preserve">Hello &amp; 世界 &#65;&#x42;</w:t></w:r>
    </w:p>
    <w:p><w:r><w:t/></w:r></w:p>
  </w:body>
  <![CDATA[ raw <not-a-tag> & stuff ]]>
</w:document>`;

test('基本事件序列正确', () => {
  const events = collect(SAMPLE);
  assert.equal(events[0], 'pi:"xml version=\\"1.0\\" encoding=\\"UTF-8\\" standalone=\\"yes\\""');
  assert.ok(events.includes('comment:" 顶层注释 "'));
  assert.ok(events.some((e) => e.startsWith('doctype:')));
  assert.ok(events.includes('start:w:document:open:{"xmlns:w":"http://schemas.openxmlformats.org/wordprocessingml/2006/main","attr":"a>b"}'), '引号内的 > 不应截断标签');
  assert.ok(events.includes('text:"Hello & 世界 AB"'), '命名实体与数字实体都要解码');
  assert.ok(events.includes('start:w:t:self:null'), '自闭合空元素');
  assert.ok(events.includes('cdata:" raw <not-a-tag> & stuff "'), 'CDATA 内容不应被当作标签');
  assert.equal(events.at(-1), 'end:w:document');
});

test('前缀/本地名拆分正确', () => {
  assert.deepEqual(splitName('w:p'), { prefix: 'w', local: 'p' });
  assert.deepEqual(splitName('p'), { prefix: '', local: 'p' });
  assert.deepEqual(splitName('a:b:c'), { prefix: 'a', local: 'b:c' });
});

test('跨块边界：任意 chunkSize 都与整串解析等价', () => {
  const baseline = collect(SAMPLE);
  const bytes = enc.encode(SAMPLE);
  // 从 1 字节到整篇，逐一验证 —— 这能覆盖标签、属性、实体、CDATA 全部被切开的边界
  for (let cs = 1; cs <= bytes.length + 4; cs++) {
    const got = collect(bytes, cs);
    assert.deepEqual(got, baseline, `chunkSize=${cs} 时事件序列与整串解析不一致`);
  }
  // 字符串输入的小 chunkSize 同样要一致（字符串路径不补料，仅确认不崩）
  assert.deepEqual(collect(SAMPLE, 8), baseline);
});

test('纯空白文本节点默认丢弃，keepWhitespace 可保留', () => {
  const xml = '<a>\n   <b>x</b>\n</a>';
  const dropped = collect(xml);
  assert.ok(!dropped.some((e) => e.startsWith('text:"\\n')), '默认应丢弃纯空白文本');
  const kept = new XmlPullParser(xml, { keepWhitespace: true });
  let sawWhitespace = false;
  let e;
  while ((e = kept.next()) !== null) if (e.type === 'text' && e.text.trim() === '') sawWhitespace = true;
  assert.equal(sawWhitespace, true, 'keepWhitespace 应保留空白文本');
});

test('skipElement 跳过整棵子树，且不产出子树事件', () => {
  const p = new XmlPullParser(SAMPLE);
  const seen: string[] = [];
  let e;
  while ((e = p.next()) !== null) {
    if (e.type === 'start') {
      if (e.name === 'w:body') {
        seen.push('body-start');
        p.skipElement();
        seen.push('body-skipped');
        continue;
      }
      seen.push(`start:${e.name}`);
    } else if (e.type === 'end') {
      seen.push(`end:${e.name}`);
    }
  }
  // w:body 的整棵子树（2 个 w:p 及其所有子元素）必须一个事件都不产出
  assert.deepEqual(seen, ['start:w:document', 'body-start', 'body-skipped', 'end:w:document']);
  assert.ok(!seen.some((s) => s.includes('w:p')), '子树事件不应出现');
});

test('xmlTextAt 按路径取文本', () => {
  assert.equal(xmlTextAt(SAMPLE, 'document/body/p/t'), 'Hello & 世界 AB');
  assert.equal(xmlTextAt(SAMPLE, 'w:document/w:body/w:p/w:r/w:t'), 'Hello & 世界 AB');
  assert.equal(xmlTextAt(SAMPLE, 'document/body/p/pPr/jc'), '');
  assert.equal(xmlTextAt(SAMPLE, 'document/nope/missing'), null);
});

test('walkXml 访问器模式', () => {
  const texts: string[] = [];
  walkXml(SAMPLE, (e) => {
    if (e.type === 'text') texts.push(e.text);
  });
  assert.ok(texts.includes('Hello & 世界 AB'));
});

test('实体解码边界', () => {
  assert.equal(decodeEntities('a&amp;b'), 'a&b');
  assert.equal(decodeEntities('&#x4e2d;&#25991;'), '中文');
  assert.equal(decodeEntities('&unknown;'), '&unknown;', '未知实体保持原样而不是抛错');
  assert.equal(decodeEntities('100% & more'), '100% & more', '裸 & 不应被破坏');
  assert.equal(decodeEntities('no entities here'), 'no entities here');
  assert.equal(decodeEntities('&amp;amp;'), '&amp;', '只解码一层');
});

test('回归：skipElement 不得吞掉紧随其后的兄弟元素', () => {
  // 这是本项目踩过的最隐蔽的一个坑：
  // 旧实现里 next() 在跳过模式中把 skipDepth 减到 0 之后仍会 `continue` 去读下一个事件，
  // 而 skipElement() 拿到那个事件后直接丢弃 —— 于是「跳过 <c> 时把 </b> 也吃掉」，
  // 调用方的层级计数随之错乱，后续兄弟元素被整棵跳过。
  //
  // 真实后果：Word 文档 numbering.xml 里的 9 个编号定义只解析出 5 个，
  // styles.xml 的 164 个样式只解析出 144 个。
  const xml = '<root><a><b><c>x</c></b><d>keep1</d></a><e>keep2</e></root>';
  const p = new XmlPullParser(xml);
  const seen: string[] = [];
  let e;
  while ((e = p.next()) !== null) {
    if (e.type === 'start') {
      if (e.name === 'b') {
        seen.push('b-start');
        p.skipElement();
        seen.push('b-skipped');
        continue;
      }
      seen.push(`start:${e.name}`);
    } else if (e.type === 'end') {
      seen.push(`end:${e.name}`);
    } else if (e.type === 'text') {
      seen.push(`text:${e.text}`);
    }
  }
  assert.deepEqual(
    seen,
    ['start:root', 'start:a', 'b-start', 'b-skipped', 'start:d', 'text:keep1', 'end:d', 'end:a', 'start:e', 'text:keep2', 'end:e', 'end:root'],
    '跳过 <b> 之后必须能正常看到兄弟 <d> 与祖先的结束标签',
  );
  assert.ok(!seen.some((s) => s.includes('c')), '被跳过子树内的事件不应出现');
});

test('回归：skipElement 连续多次调用后层级仍然正确', () => {
  // 贴近真实场景：readRunProps / readParaProps 会对每个属性容器调用 skipElement，
  // 一份文档里累计上万次。任何一次多吞一个事件都会在深层累积成结构性错误。
  const xml = `<n><abs id="0"><lvl><rPr><rFonts/></rPr></lvl></abs><abs id="1"><lvl><pStyle/><rPr><rFonts/></rPr></lvl></abs><abs id="2"><lvl><rPr><rFonts/></rPr></lvl></abs></n>`;
  const p = new XmlPullParser(xml);
  const ids: string[] = [];
  let e;
  while ((e = p.next()) !== null) {
    if (e.type === 'start' && e.name === 'abs') {
      ids.push(e.attrs.id);
      if (!e.selfClosing) {
        // 模拟「只读关心的子元素，其余跳过」的读取器模式
        let inner;
        while ((inner = p.next()) !== null) {
          if (inner.type === 'end') break;
          if (inner.type !== 'start') continue;
          if (!inner.selfClosing) p.skipElement();
        }
      }
    }
  }
  assert.deepEqual(ids, ['0', '1', '2'], '每个 abs 都必须被看到，一个都不能丢');
});

test('回归：对自闭合元素调用 skipElement 不得吞掉后续内容', () => {
  // 这是第二个由 skipElement 引起的严重 bug，症状比第一个更迷惑：
  // 自闭合元素没有结束标签，深度计数永远回不到 0，于是跳过模式一路吞到文档末尾 ——
  // 表现为「文档后半部分凭空消失」，完全看不出与那一次 skipElement 调用有关。
  //
  // 真实案例：HTML 读取器对 `<img/>` 调 skipElement 后，
  // `<p>a<img1><img2></p>` 里 img1 之后的内容全部消失。
  //
  // 契约上 skipElement 只应在**非**自闭合 start 之后调用，但把「错误用法」做成
  // 安全 no-op 比依赖调用方自觉可靠得多 —— 这是解析器该承担的责任。
  const xml = '<p>a<img src="1"/><img src="2"/>b</p><after>x</after>';
  const p = new XmlPullParser(xml);
  const seen: string[] = [];
  let e;
  while ((e = p.next()) !== null) {
    if (e.type === 'start') {
      seen.push(`start:${e.name}`);
      if (e.selfClosing) {
        p.skipElement(); // 错误用法：必须是安全 no-op
        seen.push(`skip-noop:${e.name}`);
      }
    } else if (e.type === 'text') {
      seen.push(`text:${e.text}`);
    } else if (e.type === 'end') {
      seen.push(`end:${e.name}`);
    }
  }
  assert.deepEqual(
    seen,
    [
      'start:p',
      'text:a',
      'start:img',
      'skip-noop:img',
      'start:img',
      'skip-noop:img',
      'text:b',
      'end:p',
      'start:after',
      'text:x',
      'end:after',
    ],
    '自闭合元素之后的兄弟、文本与祖先结束标签都必须完好',
  );
});

test('真实 docx 的 document.xml 能被解析且结构完整', async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ZipReader } = await import('../packages/zip/src/index.ts');

  const hit = ['二极管伏安特性实验报告.docx', '实验报告-1N4001伏安特性.docx', 'testF_del25.docx']
    .map((f) => join('C:\\deepseekharness', f))
    .find((p) => existsSync(p));
  if (!hit) return;

  const r = ZipReader.open(new Uint8Array(readFileSync(hit)));
  const bytes = await r.read('word/document.xml');

  let paragraphs = 0;
  let texts = 0;
  let chars = 0;
  let maxDepth = 0;
  let depth = 0;
  let starts = 0;
  let ends = 0;
  let selfClosing = 0;
  let others = 0; // pi / comment / doctype / cdata —— 同样以 '<' 开头

  // 全字节输入 + 小窗口，验证在真实文件上跨块解析依然正确。
  // 注意：自闭合元素只有 start 事件、没有 end 事件，深度统计必须排除它们。
  const p = new XmlPullParser(bytes, { chunkSize: 4096 });
  let e;
  while ((e = p.next()) !== null) {
    if (e.type === 'start') {
      starts++;
      if (e.selfClosing) {
        selfClosing++;
      } else {
        depth++;
        if (depth > maxDepth) maxDepth = depth;
      }
      if (e.local === 'p') paragraphs++;
    } else if (e.type === 'end') {
      ends++;
      depth--;
    } else if (e.type === 'text') {
      texts++;
      chars += e.text.length;
    } else {
      others++;
    }
  }
  console.log(
    `  [真实 document.xml] ${(bytes.length / 1024).toFixed(0)} KiB -> ${paragraphs} 段, ${texts} 个文本节点, ${chars} 字, ` +
      `start ${starts}（含自闭合 ${selfClosing}）/ end ${ends} / 其他 ${others}, 最大深度 ${maxDepth}`,
  );

  assert.equal(depth, 0, '标签必须完全配平');

  // 与原文做朴素计数交叉核对。
  // 不变式：每个以 '<' 开头的构造恰好对应一个事件 ——
  // start（含自闭合）一个 '<'，end 一个 '<'，pi/comment/doctype/cdata 各一个 '<'。
  const raw = new TextDecoder().decode(bytes);
  assert.equal(ends, (raw.match(/<\//g) ?? []).length, 'end 事件数应与原文 </ 数量一致');
  assert.equal(selfClosing, (raw.match(/\/>/g) ?? []).length, '自闭合元素数应与原文 /> 数量一致');
  assert.equal(starts + ends + others, (raw.match(/</g) ?? []).length, '全部事件应无遗漏无重复地覆盖原文每个 <');

  assert.ok(paragraphs > 0, '应解析出段落');
  assert.ok(chars > 0, '应解析出文本');
  assert.ok(maxDepth < 40, `真实文档嵌套深度应有限，实际 ${maxDepth}`);
});
