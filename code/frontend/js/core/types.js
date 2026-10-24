/*
 * core/types.js —— 接口契约（不是实现）
 * 谁调用：所有模块 import 这里的 assert 函数做自检；也当文档读
 * 不负责：任何具体功能
 *
 * 为什么需要这个文件：
 *   JavaScript 没有 C++ 的纯虚函数、也没有 Python 的 Protocol，
 *   接口只能靠"写下来 + 开发期自检"来约束。
 *   改这个文件里的契约，必须在群里同步（对应规划 §3 的协作规则）。
 */

/**
 * 文档会话：一个打开的文件 = 一个 session。
 *
 * 五条纪律（违反不会立刻报错，但三天后一定出事）：
 *  1. 不支持的命令要 resolve，不要 reject —— 外壳只看 caps，不做 try/catch 兜底；
 *  2. dirty 只有会话自己改，外壳只读；
 *  3. destroy() 必须幂等（可重复调用），否则切文件会泄漏 iframe / 监听器；
 *  4. caps 在 open() 之后不再变化；
 *  5. mount() 之前调用 export() 是未定义行为，外壳必须先 open()。
 *
 * @typedef {Object} DocumentSession
 * @property {string} kind                       'md' | 'docx' | 'xlsx' | 'pptx' | 'pdf'
 * @property {SessionCaps} caps
 * @property {string} name                       文件名
 * @property {boolean} dirty                     是否有未保存改动（只读）
 * @property {(bytes: Uint8Array, name: string) => Promise<void>} open
 * @property {(container: HTMLElement) => void} mount        把自己画进容器（纯 JS 必需）
 * @property {(cmd: EditorCommand) => Promise<void>} command
 * @property {() => Promise<Uint8Array>} export
 * @property {() => Promise<void>} print
 * @property {(event: string, cb: (payload: any) => void) => void} on
 * @property {() => void} destroy
 * @property {() => void} [markClean]            保存成功后由外壳调用，清零 dirty（骨架阶段新增）
 */

/**
 * 能力声明：外壳据此决定按钮启用/禁用，避免"能点但无效"。
 * @typedef {Object} SessionCaps
 * @property {boolean} editable
 * @property {boolean} undoable
 * @property {boolean} findable
 * @property {boolean} exportable
 * @property {boolean} printable
 */

/**
 * @typedef {{type:'undo'}|{type:'redo'}|{type:'find',query:string}|{type:'zoom',level:number}} EditorCommand
 */

/**
 * @typedef {Object} OpenedFile
 * @property {string} name
 * @property {Uint8Array} data
 * @property {unknown} [handle]   桌面：绝对路径；Web(FS Access)：FileSystemFileHandle
 */

/**
 * @typedef {Object} FileProvider
 * @property {() => Promise<OpenedFile|null>} open    用户取消返回 null，不要抛异常
 * @property {(name: string, data: Uint8Array) => Promise<'saved'|'downloaded'|'cancelled'>} save
 */

const SESSION_MEMBERS = [
  'kind', 'caps', 'name', 'dirty',
  'open', 'mount', 'command', 'export', 'print', 'on', 'destroy',
]

const CAP_KEYS = ['editable', 'undoable', 'findable', 'exportable', 'printable']

/**
 * 会话自检。在 registry 造出 session 后立刻调用一次，
 * 队友漏实现会当场爆炸，而不是等切文件时才发现。
 * @param {DocumentSession} session
 * @param {string} [label]
 * @returns {DocumentSession}
 */
export function assertSession(session, label = 'session') {
  if (!session || typeof session !== 'object') {
    throw new Error(`[${label}] 不是一个对象`)
  }
  for (const key of SESSION_MEMBERS) {
    if (!(key in session)) throw new Error(`[${label}] 缺少接口成员：${key}`)
  }
  for (const key of CAP_KEYS) {
    if (typeof session.caps?.[key] !== 'boolean') {
      throw new Error(`[${label}] caps.${key} 必须是 boolean`)
    }
  }
  if (session.kind !== 'md' && session.kind !== 'docx' && session.kind !== 'xlsx'
      && session.kind !== 'pptx' && session.kind !== 'pdf') {
    throw new Error(`[${label}] kind 非法：${session.kind}`)
  }
  return session
}

/**
 * 文件通道自检。
 * @param {FileProvider} provider
 * @param {string} [label]
 * @returns {FileProvider}
 */
export function assertFileProvider(provider, label = 'fileProvider') {
  for (const key of ['open', 'save']) {
    if (typeof provider?.[key] !== 'function') {
      throw new Error(`[${label}] 缺少方法：${key}`)
    }
  }
  return provider
}
