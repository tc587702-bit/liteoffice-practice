# 代码怎么读（骨架版）

> 面向不熟悉前端的队友。目标：**20 分钟看懂主干**，而不是读完全部代码。
> 当前状态：md 闭环已通，docx/xlsx/pptx/pdf 待接（Day 2）。

## 一、先看这张调用图

```text
main.js  ──调用──►  views/home.js      首页（拖拽区、最近文件）
   │                views/editor.js    编辑器（会话挂载点）
   │                shell/toolbar.js   工具栏（按钮据 caps 置灰）
   │                shell/statusbar.js 状态栏
   │
   ├──调用──►  session/markdown.js     md 会话（其实就是个 textarea）
   │                   ▲
   │                   └── 由 core/registry.js 按扩展名造出来
   │
   └──调用──►  core/file/web.js        文件通道（选择 / 下载）
```

**箭头只有一个方向**：`main.js` 调别人，别人不反向调 `main.js`。要通知就用回调或 `session.on()`。

## 二、一次「打开 md」的完整链路

| 步 | 代码位置 | 发生了什么 |
|---|---|---|
| 1 | `main.js` 的 `drop` 监听 | 拿到浏览器给的 `File` 对象 |
| 2 | `file.arrayBuffer()` | 变成 `Uint8Array`（原始字节） |
| 3 | `core/registry.js` 的 `createSessionFor('md')` | 决定用哪个内核 |
| 4 | `core/types.js` 的 `assertSession()` | 自检：内核有没有漏实现接口 |
| 5 | `session/markdown.js` 的 `open(bytes)` | 字节 → `TextDecoder` → 字符串 → 塞进 textarea |
| 6 | `views/editor.js` 的 `setSession(session)` → `session.mount(host)` | 把会话画进页面 |
| 7 | `state.view = 'editor'` + `refresh()` | 切视图、重画工具栏和状态栏 |
| 8 | 输入时 emit `change` → `state.doc.dirty = true` → `refresh()` | 标题出现 `•`、保存按钮亮起 |
| 9 | `Cmd+S` → `session.export()` → `fileProvider.save()` | 编码成字节 → 触发下载 |

**看懂这 9 步，就看懂了整个项目的主干。** 接 docx 只是把第 3 步换成 `office` 会话。

## 三、每个文件一句话

| 文件 | 职责 | 从哪读起 |
|---|---|---|
| `js/main.js` | 指挥中心：装配依赖、唯一的 `refresh()`、打开/保存链路 | `openFileObject()` |
| `js/state.js` | 全局唯一状态；只有 main.js 能改 | 全部（20 行） |
| `js/core/types.js` | 接口契约 + 自检函数（不是实现） | 文件头的五条纪律 |
| `js/core/registry.js` | 扩展名 → 会话工厂 | `FACTORIES` 那张表 |
| `js/core/file/web.js` | Web 文件通道：`open()` 选文件、`save()` 下载 | `save()` |
| `js/session/markdown.js` | md 会话：textarea + 编解码 + dirty | `open()` / `export()` |
| `js/shell/toolbar.js` | 工具栏；按钮状态全部从 `caps` 推导 | `render()` |
| `js/shell/statusbar.js` | 状态栏文案与配色 | `render()` |
| `js/views/home.js` | 首页：拖拽区、最近文件列表 | `render()` |
| `js/views/editor.js` | 编辑器：挂载会话、空态 | `setSession()` |
| `js/core/recents.js` | 最近文件（**待实现**，见文件里的 4 个 TODO） | 文件头注释 |

## 四、验收：在浏览器控制台里自己试

```js
// 切换视图（不销毁会话）
state.view = 'editor'; __lo.refresh()

// 造一个假文档打开（不选文件也能测）
await __lo.openFileObject({ name: 'demo.md', data: new TextEncoder().encode('# 标题\n正文') })

// 按钮置灰逻辑：把 caps 关掉，保存按钮应变灰
state.doc.caps.printable = true; __lo.refresh()   // 导出 PDF 亮起

// 状态栏配色
state.status = { text: '出错了', tone: 'error' }; __lo.refresh()
```

## 五、给你的练习（按顺序，都在 `core/recents.js`）

1. `list()`：从 `localStorage` 读 JSON，解析失败返回 `[]`（**不要抛异常**）；
2. `add()`：去重 + 置顶 + 截断到 10 条 + 写回；
3. `remove()`：按 id 删；
4. `clear()`：清空，并在首页加一个"清除历史"按钮（隐私功能必须有出口）。

做完 1、2 之后，把 `main.js` 里 `state.recents = recents.list()` 的两处保留，打开文件后回首页就能看到列表。

进阶练习（做完上面再碰）：
- 工具栏加一个"另存为"按钮：调 `session.export()` 后改文件名再 `provider.save()`；
- 把 `session/markdown.js` 换成 CodeMirror：只改这一个文件，外壳不许动；
- 加 `session/txt.js`：复制 markdown.js，改 `kind` 为 `'md'`、`printable: false`，在 registry 里加 `txt` 一行。
