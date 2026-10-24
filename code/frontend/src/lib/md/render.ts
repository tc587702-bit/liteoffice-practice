/**
 * UDM 块 → Vue VNode。
 *
 * 为什么不用 `v-html` 拼 HTML 字符串：
 *   就当前解析器而言，行内 HTML 标签会被映射成样式、未知标签整段抹掉，
 *   所以「没有逃逸路径」；但这条安全性依赖解析器的实现细节，解析器一改就可能失守。
 *   用 VNode 渲染时文本一律由 Vue 转义，安全性不依赖解析器的行为。
 *
 * 为什么列表不做成真正的 <ul>/<ol> 嵌套：
 *   解析器输出的是**扁平的段落流**（每段带 listLevel / listMarker），
 *   要还原成嵌套 <ul> 需要在这里重建层级栈，并且要处理「列表项里混段落/代码块」
 *   这类情况；课程周期内收益不匹配风险。这里按 level 缩进 + 显示 marker，
 *   视觉上与列表一致，语义上不是列表 —— 这是有意取舍，不是遗漏。
 */
import { h, type VNode } from 'vue';
import type { Block, ParaStyle, Run, RunStyle, TableCell } from './udm';
import { sanitizeUrl } from './mdparse';

/** pt → px。模型里的长度单位一律 pt，只在最后渲染这一步换算 */
const PT_TO_PX = 4 / 3;

/**
 * 等宽字体名。解析器标记「行内代码」的方式不是加一个 code 布尔，
 * 而是把 RunStyle.font 设成 'Consolas'（与 format-text 的 json/xml 读取器同一约定）。
 * 所以这里靠字体名反推，而不是假设一个不存在的字段。
 */
const MONO_FONT = 'Consolas';

/** 列表每级缩进 */
const LIST_INDENT_EM = 1.6;

function cssLength(pt: number | undefined): string | undefined {
  return pt === undefined ? undefined : `${(pt * PT_TO_PX).toFixed(2)}px`;
}

function alignOf(align: ParaStyle['align']): string | undefined {
  switch (align) {
    case 'start':
      return 'left';
    case 'end':
      return 'right';
    case 'justify':
      return 'justify';
    default:
      return align;
  }
}

/** 把一个 Run 包成带样式的节点（文本由 Vue 转义） */
function runToNode(run: Run): VNode | string {
  if (run.image) {
    // md 里的图片通常是本地路径，浏览器读不到（安全限制），所以只给占位说明
    const alt = run.image.alt || run.image.partPath || '图片';
    return h('span', { class: 'md-img', title: '本地图片无法在浏览器中读取' }, `🖼 ${alt}`);
  }

  const st: RunStyle | undefined = run.style;
  if (!st) return run.text;

  const isMono = st.font === MONO_FONT;
  let node: VNode | string = isMono ? h('code', run.text) : run.text;

  const inlineStyle: Record<string, string> = {};
  if (st.color) inlineStyle.color = st.color;
  if (st.highlight) inlineStyle.background = st.highlight;
  if (st.font) inlineStyle.fontFamily = `${st.font}, Consolas, monospace`;
  if (st.size) inlineStyle.fontSize = cssLength(st.size) ?? '';
  if (st.letterSpacing) inlineStyle.letterSpacing = cssLength(st.letterSpacing) ?? '';
  if (st.caps === 'all') inlineStyle.textTransform = 'uppercase';
  else if (st.caps === 'small') inlineStyle.fontVariant = 'small-caps';

  // 从内到外包裹：先内联样式，再语义标签，最后链接（链接需要在最外层才可点）
  if (Object.keys(inlineStyle).length > 0) node = h('span', { style: inlineStyle }, [node]);
  if (st.underline) node = h('u', [node]);
  if (st.strike) node = h('s', [node]);
  if (st.italic) node = h('em', [node]);
  if (st.bold) node = h('strong', [node]);
  if (st.link) {
    const href = sanitizeUrl(st.link);
    node = href
      ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, [node])
      : h('span', [node]);
  }

  return node;
}

function runsToChildren(runs: Run[]): (VNode | string)[] {
  const out: (VNode | string)[] = [];
  for (const run of runs) {
    if (run.breakBefore) out.push(h('br'));
    const node = runToNode(run);
    // 空文本直接跳过，避免生成一堆空 span
    if (typeof node === 'string' && node === '') continue;
    out.push(node);
  }
  return out;
}

function paraCss(style: ParaStyle | undefined): Record<string, string> {
  const css: Record<string, string> = {};
  if (!style) return css;

  const align = alignOf(style.align);
  if (align) css.textAlign = align;
  if (style.indentStart) css.paddingLeft = cssLength(style.indentStart) ?? '';
  if (style.indentEnd) css.paddingRight = cssLength(style.indentEnd) ?? '';
  if (style.indentFirst) css.textIndent = cssLength(style.indentFirst) ?? '';
  if (style.spaceBefore) css.marginTop = cssLength(style.spaceBefore) ?? '';
  if (style.spaceAfter) css.marginBottom = cssLength(style.spaceAfter) ?? '';
  if (style.lineHeight) css.lineHeight = String(style.lineHeight);
  else if (style.lineHeightExact) css.lineHeight = cssLength(style.lineHeightExact) ?? '';
  if (style.shading) css.background = style.shading;

  return css;
}

/** 「Heading 1..6」 → 标签名；不是标题返回 null */
function headingTag(styleName: string | undefined): string | null {
  if (!styleName) return null;
  const m = /^heading\s*([1-6])$/i.exec(styleName.trim());
  return m ? `h${m[1]}` : null;
}

function blockToNode(block: Block): VNode | null {
  switch (block.kind) {
    case 'rule':
      return h('hr', { class: 'md-rule' });

    case 'pagebreak':
      return h('hr', { class: 'md-pagebreak' });

    case 'image': {
      const alt = block.image.alt || '图片';
      return h('p', { class: 'md-img-block' }, `🖼 ${alt}（本地图片无法读取）`);
    }

    case 'raw':
      return h('p', { class: 'md-raw' }, block.text);

    case 'table': {
      const head: VNode[] = [];
      const body: VNode[] = [];

      block.rows.forEach((row, rowIndex) => {
        const cells: VNode[] = row.cells
          .filter((cell) => !cell.merged)
          .map((cell: TableCell) =>
            h(
              row.header ? 'th' : 'td',
              {
                colspan: cell.colSpan && cell.colSpan > 1 ? cell.colSpan : undefined,
                rowspan: cell.rowSpan && cell.rowSpan > 1 ? cell.rowSpan : undefined,
                style: cell.vAlign ? { verticalAlign: cell.vAlign } : undefined,
              },
              cell.blocks.map((b) => blockToNode(b)).filter((n): n is VNode => n !== null),
            ),
          );

        const tr = h('tr', cells);
        if (row.header || rowIndex === 0) head.push(tr);
        else body.push(tr);
      });

      return h('table', { class: 'md-table' }, [
        head.length ? h('thead', head) : null,
        h('tbody', body),
      ]);
    }

    case 'para': {
      const style = block.style;
      const children = runsToChildren(block.runs);
      const css = paraCss(style);

      // 标题
      const tag = headingTag(style?.styleName);
      if (tag) return h(tag, { style: css, class: 'md-heading' }, children);

      /*
       * 围栏/缩进代码块：解析器用 styleName 标记，
       * 带语言时是 "Code js"（不只是 "Code"），所以必须按前缀匹配。
       * 踩过的坑：先写成 === 'Code'，结果所有带语言的代码块都退化成了普通段落。
       */
      const codeMatch = style?.styleName ? /^code(?:\s+(.+))?$/i.exec(style.styleName.trim()) : null;
      if (codeMatch) {
        const lang = codeMatch[1];
        return h('pre', { class: 'md-code', 'data-lang': lang || undefined }, [h('code', children)]);
      }

      // 引用块：解析器用 border.left 标记（applyQuote）
      const left = style?.border?.left;
      if (left) {
        return h(
          'blockquote',
          {
            style: {
              borderLeft: `${(left.width * PT_TO_PX).toFixed(2)}px ${left.style ?? 'solid'} ${left.color ?? '#d0d5dd'}`,
              ...css,
            },
          },
          children,
        );
      }

      // 列表项：解析器给出 listLevel（0 起）+ listMarker
      if (style?.listLevel !== undefined) {
        const marker = style.listMarker ?? (style.listOrdered ? '1.' : '•');
        return h(
          'div',
          {
            class: 'md-li',
            style: {
              ...css,
              paddingLeft: `${((style.listLevel + 1) * LIST_INDENT_EM).toFixed(2)}em`,
            },
          },
          [h('span', { class: 'md-marker', 'aria-hidden': 'true' }, marker), h('span', children)],
        );
      }

      return h('p', { style: css }, children);
    }

    default:
      return null;
  }
}

/** 渲染整篇文档的块列表 */
export function renderBlocks(blocks: Block[]): VNode[] {
  const out: VNode[] = [];
  for (const block of blocks) {
    const node = blockToNode(block);
    if (node) out.push(node);
  }
  return out;
}
