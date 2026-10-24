/*
 * core/recents.js —— 最近打开列表（只存元数据，绝不含文件内容）
 * 谁调用：main.js
 * 不负责：读取文件本身
 *
 * 两个平台的语义差异（已和团队确认）：
 *   桌面（Tauri）：可以存绝对路径，点条目能直接重开；文件没了就提示"已移动或删除"
 *   Web：浏览器不给路径，只能存名字和时间；点条目只能提示"请重新选择文件"
 *        （要"点一下直接重开"需要 File System Access API + IndexedDB，属于 Day 4 加分项）
 *
 * 这个文件是骨架里留给你的练习题（约 60 行）。
 * 现在它返回空列表，界面显示"还没有打开过文件"，不影响其它功能。
 */

const MAX_ITEMS = 10
const STORAGE_KEY = 'liteoffice.recents.v1'

/**
 * 读取历史记录，按最近打开时间倒序。
 * @returns {Array<{id:string,name:string,ext:string,size:number,openedAt:number}>}
 */
export function list() {
  // TODO(练习 1)：从 localStorage 读出 JSON，解析失败时返回 []（不要抛异常）
  return []
}

/**
 * 新增一条记录：去重、置顶、截断到 MAX_ITEMS，并写回 localStorage。
 * @param {{name:string, ext:string, size:number}} entry
 */
export function add(entry) {
  // TODO(练习 2)：id 用 `${entry.name}:${entry.size}`，桌面版还要加 path 字段
  void entry
}

/** 移除一条 */
export function remove(id) {
  // TODO(练习 3)
  void id
}

/** 清空（首页需要一个"清除历史"入口，隐私相关的功能必须有出口） */
export function clear() {
  // TODO(练习 4)：localStorage.removeItem(STORAGE_KEY)
}

export { MAX_ITEMS, STORAGE_KEY }
