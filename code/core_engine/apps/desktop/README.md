# apps/desktop —— 桌面壳（尚未构建）

**当前状态：只有设计与接口，没有可运行的壳。** 本机没有 Rust 工具链（`cargo`/`rustc` 均缺失），
因此无法在此环境构建。

完整的架构决策、为什么选 Tauri 而不是 Electron、Rust 侧应该暴露哪些命令、
以及构建前置条件，见 **[docs/DESKTOP.md](../../docs/DESKTOP.md)**。

## 这里应该有什么（落地时）

```
apps/desktop/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs          # 命令注册
│       ├── fs.rs            # 文件读写 + 字节区间读
│       └── fonts.rs         # 系统字体枚举与加载
└── src/
    ├── host.ts              # TauriHost：实现 packages/core 的 HostAdapter
    └── main.ts              # 复用 apps/web 的 UI，注入 TauriHost
```

## 两条不要违反的约束

**① Rust 侧不解析文档。** 一旦把解析逻辑分叉到两侧，就会出现两个实现、两套 bug，
以及「桌面版能打开、网页版打不开」这类问题。Rust 只提供系统能力
（文件、字体、内存信息），解析全部留在 TS 内核。

**② 不复制粘贴 UI。** 落地时应把 `apps/web/src/main.ts` 重构为
`bootstrap(host: HostAdapter)`，两个壳各自提供实现。
否则 UI 会立刻分叉，修 bug 要修两遍。

## 桌面壳的四条存在理由

如果桌面壳只是「把网页套个壳」，那不值得做。它真正的价值只有这四条：

| 限制（Web 壳） | 桌面壳的解法 |
|---|---|
| 无法枚举系统字体 | Rust 侧枚举并注册，减少字体替换导致的版面偏移 |
| 无法读文档内嵌字体 | 从包里取出字体字节，渲染层直接用 |
| 标签页内存上限不受控 | 进程级控制，可设更激进的上限 |
| 文件系统访问受限（仅 Chromium 有 FSA API） | 直接读写路径，可做文件关联与最近文件 |

其中前两条是**主要理由** —— 它们直接影响版面保真度，而不只是便利性。
