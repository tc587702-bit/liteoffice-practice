/**
 * 数字格式（numFmt）表与 Excel 日期序列号转换。
 *
 * 为什么要内置一张 0-49 的表：xlsx 的 `<cellXfs>` 里绝大多数 xf 只写 `numFmtId`，
 * 而 `numFmtId` 0-49 是**规范内置**的，不写在 `<numFmts>` 里。如果不认识它们，
 * 后果不是「格式丢一点」，而是**日期全变成 5 位数字**（14/22 等日期格式都是内置的），
 * 用户会直接判定「这个阅读器坏了」。
 *
 * 日期的坑（1900 闰年 bug）：
 *   Excel 为了兼容 Lotus 1-2-3，认为 1900 年是闰年，于是序列号 60 对应一个
 *   不存在的 1900-02-29。真实日历里 1900-02-28 是序列号 59、1900-03-01 是 61。
 *   因此：
 *     serial <= 59  ->  1899-12-31 + serial 天
 *     serial >= 61  ->  1899-12-30 + serial 天（正好比上一行少算一天）
 *   serial == 60 无法用真实日历表示，这里**夹到 1900-02-28**（与 Excel 显示
 *   1900-02-29 只差一天）。绝不返回 Invalid Date。
 */

/** 规范内置的数字格式（ECMA-376 §18.8.30）。23-36 / 41-44 / 50-58 是地区变体，故意留空。 */
export const BUILTIN_NUM_FMTS: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '"$"#,##0_);("$"#,##0)',
  6: '"$"#,##0_);[Red]("$"#,##0)',
  7: '"$"#,##0.00_);("$"#,##0.00)',
  8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'm/d/yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
};

export function builtinNumFmt(id: number): string | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_NUM_FMTS, id) ? BUILTIN_NUM_FMTS[id] : undefined;
}

/**
 * 取某个 numFmtId 的格式串：先查部件里的自定义表，再查内置表。
 * 两者都没有时返回 'General' —— 绝不因为一个未知格式串而丢内容。
 */
export function resolveNumFmt(id: number, custom: Map<number, string> | undefined): string {
  const own = custom?.get(id);
  if (own !== undefined) return own;
  return builtinNumFmt(id) ?? 'General';
}

/**
 * 去掉格式串里的「字面量」部分，只留下格式占位符。
 *
 * 必须去干净，否则会有两类误判：
 *   - `0.00"元"`     —— 里边的字会被当成日期标记
 *   - `_ "¥"* #,##0` —— WPS 的会计格式，`_`/`*` 后面那个字符是填充字符
 * 同时 `[Red]`、`[$-409]`、`[>100]` 这类方括号块要丢掉；
 * 但 `[h]`/`[mm]`/`[ss]` 是**经过时间**标记，必须留下。
 */
export function stripFormatLiterals(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"') {
      i++;
      while (i < code.length && code[i] !== '"') i++;
      i++;
      continue;
    }
    if (ch === '\\') {
      i += 2; // 反斜杠转义下一个字符
      continue;
    }
    if (ch === '_' || ch === '*') {
      i += 2; // 跳过宽度占位符 / 填充字符
      continue;
    }
    if (ch === '[') {
      const end = code.indexOf(']', i);
      const body = end < 0 ? code.slice(i + 1) : code.slice(i + 1, end);
      // 只保留 [h] [mm] [ss] 这类时间标记
      if (/^[hms]+$/i.test(body)) out += body;
      i = end < 0 ? code.length : end + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export interface FormatFields {
  /** 含年/日（或单独的月）—— 需要按日期显示 */
  date: boolean;
  /** 含时/分/秒 —— 需要按时间显示 */
  time: boolean;
  seconds: boolean;
}

/** 判断格式串里有哪些日期/时间字段。 */
export function analyzeFormat(code: string): FormatFields {
  const s = stripFormatLiterals(code);
  const hasYear = /y/i.test(s);
  const hasDay = /d/i.test(s);
  const hasHour = /h/i.test(s);
  const hasSec = /s/i.test(s);
  const hasMin = /m/i.test(s);
  // 'm' 既可能是月也可能是分。约定：有 h 或 s 时按「分」，否则按「月」。
  // 这样 `mm:ss`（分:秒）与 `mmm-yy`（月-年）都能落到正确的分支。
  const minIsMinute = hasHour || hasSec;
  const date = hasYear || hasDay || (hasMin && !minIsMinute);
  const time = hasHour || hasSec || (hasMin && minIsMinute);
  return { date, time, seconds: hasSec };
}

/** 该格式串是否属于日期/时间族（决定要不要把序列号转成日期字符串）。 */
export function isDateFormat(code: string): boolean {
  const f = analyzeFormat(code);
  return f.date || f.time;
}

const MS_PER_DAY = 86400000;
const EPOCH_1900 = Date.UTC(1899, 11, 30); // 基准：serial 0 的前一天，配合下面的 ±1 天修正
const EPOCH_1904 = Date.UTC(1904, 0, 1);

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Excel 序列号 -> { y, m, d, hh, mm, ss }。
 * 超出可表示范围（负数、非有限值）返回 null，由调用方保留原始数字 ——
 * 宁可显示数字，也不要显示 Invalid Date。
 */
export function serialToParts(serial: number, date1904 = false): { y: number; m: number; d: number; hh: number; mm: number; ss: number } | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const whole = Math.floor(serial);
  const frac = serial - whole;
  let ms: number;
  if (date1904) {
    ms = EPOCH_1904 + whole * MS_PER_DAY + Math.round(frac * MS_PER_DAY);
  } else {
    // <=59 走 1899-12-31 基准（= 相对 EPOCH_1900 多一天），>=60 走 1899-12-30 基准。
    // 这个「跳变」正是 1900 闰年 bug 的体现，不是写错了。
    const shift = whole < 60 ? 1 : 0;
    ms = EPOCH_1900 + (whole + shift) * MS_PER_DAY + Math.round(frac * MS_PER_DAY);
  }
  const dt = new Date(ms);
  const t = dt.getTime();
  if (!Number.isFinite(t)) return null;
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    hh: dt.getUTCHours(),
    mm: dt.getUTCMinutes(),
    ss: dt.getUTCSeconds(),
  };
}

/**
 * 把序列号按格式串渲染成可读日期字符串。
 * 输出用 ISO 风格（`2024-03-05` / `2024-03-05 08:30:00` / `08:30`）：
 * 按原格式串逐字还原（`d-mmm-yy` 之类）需要完整的 locale 表，代价远大于收益，
 * 而模型里的 numFmt 已经保留了原格式串，渲染器需要时还能自己再格式化。
 * 返回 null 表示「不该按日期显示」（负数等），调用方保留原始数字。
 */
export function formatExcelSerial(serial: number, code: string, date1904 = false): string | null {
  const parts = serialToParts(serial, date1904);
  if (!parts) return null;
  const f = analyzeFormat(code);
  const iso = `${parts.y}-${pad2(parts.m)}-${pad2(parts.d)}`;
  const time = `${pad2(parts.hh)}:${pad2(parts.mm)}${f.seconds ? `:${pad2(parts.ss)}` : ''}`;
  if (f.date && f.time) return `${iso} ${time}`;
  if (f.date) return iso;
  return time;
}

/**
 * 规范 `t="d"`（ISO 8601 日期）单元格的显示值：只做轻量归一
 * （`T` 换成空格、去掉尾部 `Z`/毫秒），解析不了的保持原样。
 */
export function normalizeIsoDate(v: string): string {
  const s = v.trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}))?)?(?:\.\d+)?Z?$/.exec(s);
  if (!m) return s;
  return m[2] ? `${m[1]} ${m[2]}${m[3] ? `:${m[3]}` : ''}` : m[1];
}
