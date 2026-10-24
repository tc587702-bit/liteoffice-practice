/*
 * state.js —— 全局唯一的界面状态
 * 谁调用：main.js 修改；所有 views / shell 只读
 * 不负责：任何 DOM 操作
 *
 * 铁律：只有 main.js 能改这里，视图只能读。
 *      这样"按钮该灰没灰"这类 bug，查一个文件就能定位。
 */

export const state = {
  /** 'home' | 'editor' */
  view: 'home',

  /** 当前 DocumentSession 实例；null 表示没打开文件 */
  session: null,

  /** 从 session 同步过来的快照，界面只读这个，不直接读 session */
  doc: {
    name: '',
    ext: '',
    dirty: false,
    caps: {
      editable: false,
      undoable: false,
      findable: false,
      exportable: false,
      printable: false,
    },
  },

  /** 最近打开的文件（元数据，不含内容）；Web 端不持久化 */
  recents: [],

  /** 状态栏文案；tone: 'normal' | 'warn' | 'error' */
  status: { text: '就绪', tone: 'normal' },

  /** 正在读文件 / 导出时置 true，可用来禁用按钮 */
  busy: false,
}
