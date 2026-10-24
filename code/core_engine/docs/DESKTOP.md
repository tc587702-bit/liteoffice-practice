# 桌面壳设计（Tauri）

**当前状态：方案，尚未构建。** 本文件说明架构决策与落地路径，
使「同一内核 + 两种壳」这个目标不至于停在口号上。

---

## 为什么需要桌面壳

Web 壳已经能跑，但有四件事**在浏览器里做不到或做不好**，这些正是桌面壳的全部理由：

| 限制 | 后果 | 桌面壳如何解决 |
|---|---|---|
| **无法枚举系统字体** | 文档指定的字体缺失时只能替换，版面必然偏移 | Rust 侧枚举字体并注册，`@font-face` 指向本地文件 |
| **无法嵌入文档自带字体** | OOXML/ODF 可内嵌字体（`word/fonts/`、`fonts/`），Web 下拿不到 | 从包里取出字体字节，直接喂给渲染层 |
| **标签页内存上限不受控** | 打开 200 MB 的 xlsx 时浏览器可能直接杀页 | 进程级控制，可设更激进的上限或分进程解析 |
| **文件系统访问受限** | File System Access API 仅 Chromium，且每次要用户授权 | 直接读写路径，可做文件关联与最近文件 |

**反过来，桌面壳不应该做的事**：不要为了「像原生」而重写 UI。
外壳必须是**薄适配层**，业务逻辑全在共享内核里。

---

## 分层

```
┌─────────────────────────────────────────────────┐
│ 共享内核（100% 复用，一行不改）                   │
│  core · zip · xml · ooxml · engine ·             │
│  format-* · render-dom                           │
└──────────────────┬──────────────────────────────┘
                   │  只依赖一个薄接口
                   ▼
        ┌────────────────────────┐
        │  HostAdapter 接口       │
        └───────┬────────┬───────┘
                │        │
      ┌─────────▼──┐  ┌──▼──────────────┐
      │ WebHost    │  │ TauriHost       │
      │ (已完成)    │  │ (待实现)         │
      └────────────┘  └─────────────────┘
```

### 需要抽象的能力

```ts
/** 外壳能力适配。内核只依赖这个接口，不依赖任何浏览器/原生 API。 */
export interface HostAdapter {
  /** 读文件。Web 用 File/Blob，Tauri 用路径 + 惰性读。 */
  readFile(id: string): Promise<Uint8Array>;
  /** 惰性分块读，避免一次性把大文件读进内存。 */
  readRange?(id: string, start: number, length: number): Promise<Uint8Array>;

  /** 写文件。 */
  writeFile(name: string, bytes: Uint8Array): Promise<void>;
  /** 另存为对话框，返回用户选择的路径/句柄。 */
  saveAs?(suggestedName: string, bytes: Uint8Array): Promise<boolean>;

  /** 让用户选文件。返回 id + name + size 的列表（不返回内容）。 */
  pickFiles(options?: { multiple?: boolean; accept?: string }): Promise<HostFileRef[]>;

  /** 系统字体清单。Web 下返回 null（不可用），内核据此走字体替换路径。 */
  listFonts?(): Promise<string[] | null>;
  /** 取字体文件字节，用于文档内嵌字体。 */
  loadFont?(family: string, bold: boolean, italic: boolean): Promise<Uint8Array | null>;

  /** 内存上限提示。Web 下由 navigator.deviceMemory 粗估。 */
  memoryBudgetBytes?(): number | null;
}
```

`openDocument()` 的输入已经抽象为 `OpenInput`（`bytes` 或 `blob`），
桌面壳只需多实现一条「按路径惰性读」的分支，内核其余部分完全复用。

---

## Tauri 侧要点

### 为什么是 Tauri 而不是 Electron

| | Tauri | Electron |
|---|---|---|
| 二进制体积 | ~5 MB 级 | ~100 MB 级 |
| 内存基线 | 复用系统 WebView | 自带整个 Chromium |
| 与「轻量」定位 | 一致 | 矛盾 |

Electron 自带 Chromium 意味着**最低内存基线就已经是几十 MB 到上百 MB**，
与 LiteOffice 的核心主张直接冲突。因此选 Tauri。

代价要提前说明：Tauri 用系统 WebView（Windows 上是 WebView2），
因此**渲染差异随系统版本而变化**，需要针对 WebView2 做兼容测试。
`render-dom` 只用最基础的 DOM API，兼容风险可控，但要实测。

### Rust 侧需要暴露的命令

```rust
// 只做系统能力，不放任何文档解析逻辑 —— 解析留在 TS 内核里，
// 这样 Web 壳和桌面壳的解析行为必然一致（不会有"桌面版能开、网页版打不开"）
#[tauri::command] fn read_file(path: String) -> Result<Vec<u8>, String>
#[tauri::command] fn read_range(path: String, start: u64, len: u64) -> Result<Vec<u8>, String>
#[tauri::command] fn write_file(path: String, bytes: Vec<u8>) -> Result<(), String>
#[tauri::command] fn list_fonts() -> Result<Vec<FontInfo>, String>
#[tauri::command] fn load_font(family: String, bold: bool, italic: bool) -> Result<Vec<u8>, String>
#[tauri::command] fn memory_info() -> Result<MemoryInfo, String>
```

**关键约束：Rust 侧不解析文档。** 一旦把解析逻辑分叉到两侧，
就会出现两个实现、两套 bug、以及「桌面版能开网页版打不开」这类问题。
Rust 只提供系统能力。

### 目录结构（待创建）

```
apps/desktop/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs          # 命令注册
│       ├── fs.rs            # 文件读写 + 范围读
│       └── fonts.rs         # 系统字体枚举与加载
└── src/
    ├── host.ts              # TauriHost 实现 HostAdapter
    └── main.ts              # 复用 apps/web 的 UI，注入 TauriHost
```

### 前端复用策略

`apps/web/src/main.ts` 应被重构为「接收 `HostAdapter` 的 `bootstrap(host)`」，
两个壳各自提供自己的实现。**不要复制粘贴 UI 代码。**

---

## 构建前置条件（当前环境不满足）

本机没有以下工具，因此**桌面壳无法在此环境构建**：

- `cargo` / `rustc`（Rust 工具链）
- WebView2 运行时（Windows 10/11 通常自带，需确认）

落地步骤：

```powershell
# 1. 安装 Rust（rustup）
winget install Rustlang.Rustup
# 2. 安装 Tauri CLI
cargo install tauri-cli
# 3. 构建
cd apps/desktop
cargo tauri dev      # 开发
cargo tauri build    # 打包
```

在此之前，`apps/desktop` 只保留本设计与 `HostAdapter` 接口定义
（接口定义放在 `packages/core/src/host.ts`，Web 壳先行实现它）——
这样桌面壳落地时不需要改动内核。
