/**
 * 功能开关。
 *
 * 为什么要有这个文件：课程周期只有 5 天，必须能一刀砍掉未完成的功能，
 * 而不是让它在演示时冒出来。所有"可能做不完"的功能都在这里集中开关，
 * 关闭时 UI 上完全不可见（不是灰掉，是不渲染），避免答辩时被问"这个按钮为什么没用"。
 */
export const features = {
  /** 右侧「文档助手」面板。规划里是占位，默认关闭。 */
  agentEnabled: false,

  /**
   * 是否启用 ONLYOFFICE 编辑器。
   *
   * 现在为 true：onlyoffice-web-local 已安装，静态资源已由
   * `node scripts/prepare-onlyoffice.mjs` 复制到 public/onlyoffice。
   *
   * 如果要临时退回「只演示文件流」（比如依赖没装好），把它改成 false，
   * 编辑区会显示文件信息而不是报错 —— 演示时不会因此开天窗。
   */
  editorEnabled: true,
} as const;

export type Features = typeof features;
