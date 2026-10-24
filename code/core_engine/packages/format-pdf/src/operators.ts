/**
 * 内容流算子表。
 *
 * 为什么单独一张表：内容流里 90% 以上的 token 是操作数，识别算子必须**极快**。
 * 表驱动（名字 -> 操作数个数）比一长串 if/else 更可维护，而且顺带解决了
 * 「怎么知道要退多少个操作数」这个问题 —— 这是解析内容流最容易错的地方：
 * 若某个算子的操作数个数记错，栈会整体错位，后面所有图形都会画错位置。
 *
 * 注意几个反直觉的点：
 *   - `re` 也是 4 个操作数，但它构造的是矩形而不是路径点
 *   - `"`（双引号）是 3 个操作数：aw ac string
 *   - `'`（单引号）只有 1 个操作数：string
 *   - `d0` / `d1` 出现在 Type3 字体的字形描述里，参数个数是 2 / 6
 */

/** 算子 -> 操作数个数。只登记**本包会用**的算子。 */
export const OPERATOR_ARITY: Record<string, number> = {
  /* 图形状态 */
  q: 0,
  Q: 0,
  cm: 6,
  w: 1,
  J: 1,
  j: 1,
  M: 1,
  d: 2,
  ri: 1,
  i: 1,
  gs: 1,

  /* 路径构造 */
  m: 2,
  l: 2,
  c: 6,
  v: 4,
  y: 4,
  h: 0,
  re: 4,

  /* 路径绘制 */
  S: 0,
  s: 0,
  f: 0,
  F: 0,
  'f*': 0,
  B: 0,
  'B*': 0,
  b: 0,
  'b*': 0,
  n: 0,

  /* 裁剪 */
  W: 0,
  'W*': 0,

  /* 文本状态 */
  BT: 0,
  ET: 0,
  Tc: 1,
  Tw: 1,
  Tz: 1,
  TL: 1,
  Tf: 2,
  Tr: 1,
  Ts: 1,

  /* 文本定位 */
  Td: 2,
  TD: 2,
  Tm: 6,
  'T*': 0,

  /* 文本绘制 */
  Tj: 1,
  TJ: 1,
  "'": 1,
  '"': 3,

  /* 颜色 */
  CS: 1,
  cs: 1,
  SC: -1,
  SCN: -1,
  sc: -1,
  scn: -1,
  G: 1,
  g: 1,
  RG: 3,
  rg: 3,
  K: 4,
  k: 4,

  /* XObject */
  Do: 1,

  /* 着色器 / 兼容 */
  sh: 1,
  BX: 0,
  EX: 0,
};

/** 参数个数可变（-1）的算子需要按栈上前缀推断，这里给出它们的最小/最大个数。 */
export const VARIADIC_OPS = new Set(['SC', 'SCN', 'sc', 'scn']);

export function isOperatorName(word: string): boolean {
  return Object.prototype.hasOwnProperty.call(OPERATOR_ARITY, word);
}
