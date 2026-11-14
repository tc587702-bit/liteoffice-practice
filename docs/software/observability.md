# 日志与错误处理规范

| 项目 | 内容 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-11-07 |
| 适用代码 | `cc9261f` 之后的仓库现状 |
| 涉及三个服务 | 前端 `code/frontend`、协作后端 `code/backend`、Agent `code/agent` |
| 配套文档 | [项目结构](project-structure.md)、[代码职责地图](code-map.md) |

---

## 一、一句话概括

三个服务用**同一套错误模型 + 同一套日志字段**，让「用户在浏览器里点了一下没反应」这种问题，
能沿着 `requestId` 从浏览器日志一路查到后端、再查到 Agent，而不是靠猜。

```
浏览器 console / 诊断文件       后端 stdout(JSON)            Agent stdout(JSON)
   requestId: 8f3a…      →     requestId: 8f3a…        →    requestId: 8f3a…
   AppError.code         →     body.code / error.code  →    JSONResponse.code
```

---

## 二、日志

### 2.1 格式与字段

后端与 Agent 默认输出 **JSON Lines**（一行一条），字段固定：

| 字段 | 含义 |
|---|---|
| `ts` | ISO 8601 时间戳（UTC） |
| `level` | `debug` / `info` / `warn` / `error` |
| `service` | `liteoffice-backend` / `liteoffice-agent` |
| `msg` | 简短事件名（中文短句，不要拼变量） |
| `requestId` | 请求级关联 ID，HTTP 响应头 `X-Request-Id` 同值 |
| 其余字段 | 业务上下文，如 `docId` / `tool` / `status` / `durationMs` |

本地想看人话：

```bash
LITEOFFICE_LOG_FORMAT=text npm start          # 后端
LITEOFFICE_LOG_FORMAT=text uvicorn app.main:app --port 8100   # Agent
```

### 2.2 级别约定

| 级别 | 什么时候用 | 例子 |
|---|---|---|
| `debug` | 正常但高频、排障才需要 | 静态文件 404、单元格解析降级、Worker 启停 |
| `info` | 业务里程碑 | 创建文档、生成分享链接、Agent 编排完成 |
| `warn` | **预期内**的失败/降级，系统仍可用 | 链接过期、限流、写入快照失败、模型无 Key 走 mock |
| `error` | 非预期异常，或「用户数据可能受损」 | 未捕获异常、协作增量落库失败、导出回读自检失败 |

判断标准：**4xx → warn，5xx → error；可降级 → warn，不可降级 → error。**

### 2.3 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LITEOFFICE_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`/`silent` |
| `LITEOFFICE_LOG_FORMAT` | `json` | `json` 或 `text`（只影响控制台，文件永远是 JSON） |
| `LITEOFFICE_LOG_FILE` | 各自 `logs/*.log` | 落盘路径；设为 `off` 关闭落盘 |
| `LITEOFFICE_LOG_MAX_BYTES` | `10485760` | 单个日志文件上限，超过即轮转 |
| `LITEOFFICE_LOG_BACKUPS` | `3` | 保留的历史文件数（`.1` ~ `.N`） |
| `LITEOFFICE_SERVICE_NAME` | 各自默认 | 日志里的 `service` 字段，容器部署时便于区分 |
| `VITE_LOG_ENDPOINT` | 未设置 | 前端 error 级日志的远程上报地址（`sendBeacon` POST） |

### 2.4 落盘

后端与 Agent **默认写文件**，无需任何配置：

| 服务 | 默认文件 | 轮转 |
|---|---|---|
| 后端 | `code/backend/logs/backend.log` | 到 10 MB → `backend.log.1` → `.2` → `.3`，最旧丢弃 |
| Agent | `code/agent/logs/agent.log` | 到 10 MB → `agent.log.1` → `.2` → `.3` |
| 前端 | 无（浏览器不允许直接写盘） | 用「下载诊断信息」或控制台的 `__liteofficeDiagnose()` |

- 两个 `logs/` 目录都在 `.gitignore` 里，不会误提交。
- 文件内容**始终是 JSON Lines**，与 `LITEOFFICE_LOG_FORMAT` 无关，方便 `jq` 处理。
- 后端用同步追加写（`appendFileSync`），保证进程崩溃时最后几条日志已经落盘；
  Agent 用 `RotatingFileHandler`，天然支持按大小轮转。
- 写文件失败（磁盘满 / 无权限）**不会影响服务**：只向 stderr 报一次，然后继续打控制台。

查日志：

```bash
tail -f code/backend/logs/backend.log | jq -c '{ts, level, msg, requestId, code}'
grep '"level":"error"' code/agent/logs/agent.log | jq -r '.msg' | sort | uniq -c | sort -rn
```

### 2.5 脱敏

后端 `logger.mjs`、Agent `logging_conf.py` 都会自动把下列键名的值替换为 `<redacted:N>`：

`token`、`authorization`、`cookie`、`password`、`secret`、`api_key`、`x-api-token`、`x-admin-token`、`contentBase64`

同时：字符串截断到 500 字符、数组只保留前 20 项、对象递归深度上限 3～4 层、Error 只取前 8 帧栈。

> **约定**：任何时候都不要 `console.log(req.body)`、不要打印完整文档内容、不要把 `X-API-Token` 写进日志。

---

## 三、错误模型

### 3.1 三端同构的 `AppError`

| 语言 | 类 | 文件 |
|---|---|---|
| Node | `AppError` 及其子类 | `code/backend/server/errors.mjs` |
| Python | `AppError` 及其子类 | `code/agent/app/errors.py` |
| TypeScript | `AppError` | `code/frontend/src/lib/errors.ts` |

共同的四个属性：

- `message` / `userMessage`：给用户看的文案（避免堆栈、SQL、路径）
- `code`：机器可读错误码，便于统计与前端分支处理
- `status`（前端为 `recoverable`）：HTTP 状态码 / 是否可重试
- `cause`：原始异常，只进日志

### 3.2 后端与 Agent 的对应关系

| 场景 | 后端类 | Agent 类 | HTTP |
|---|---|---|---|
| 参数不合法 | `BadRequestError` | `BadRequest` | 400 |
| 未授权 | `UnauthorizedError` | `Unauthorized` | 401 |
| 资源不存在 | `NotFoundError` | `NotFound` | 404 |
| 请求体过大 | `PayloadTooLargeError` | — | 413 |
| 链接失效 | `GoneError`（`code` 复用 `not_found`/`revoked`/`expired`） | — | 410 |
| 限流 | `RateLimitedError` | `RateLimited` | 429 |
| 上游失败 | `UpstreamError` | `UpstreamError` | 502 / 503 |
| 内部错误 | `AppError`（默认） | `AppError`（默认） | 500 |

统一响应体：

```json
{ "error": "人话", "code": "NOT_FOUND", "requestId": "8f3a…" }
```

Agent 沿用 FastAPI 的 `detail` 键：

```json
{ "detail": "人话", "code": "NOT_FOUND", "requestId": "8f3a…" }
```

**500 类错误对外只回通用文案**，真实原因（SQL 报错、上游返回、文件路径）只进日志。

### 3.3 前端错误分层

| 场景 | 处理方式 |
|---|---|
| 可预期的业务失败（解析失败、导出失败） | 返回 `{ ok:false, message }` 或抛 `AppError`，由调用方 toast |
| 渲染期崩溃 | `ErrorBoundary.vue` 兜住，展示 code + 「下载诊断信息」 |
| 内存不足 | `FatalDialog`，提供下载原始文件 |
| 其余未捕获异常 | 全局兜底 → `logger.error` + 已注册的 UI 回调 |

前端提供 `collectDiagnostics()`：把 UA、视口、地址、最近 300 条日志打包成 txt，
用户点一下就能把现场发过来。

---

## 四、全局兜底清单

### 后端（`server/index.mjs`）

- 每个请求生成/透传 `X-Request-Id`，响应头回写
- `res.on('finish')` 记录访问日志（method / path / status / durationMs / ip）
- `process.on('unhandledRejection')`：记录，不退出（提示需修复）
- `process.on('uncaughtException')`：记录后**退出**，交给进程管理器重启（状态已不可信）
- `SIGINT` / `SIGTERM`：停止接收新连接 → 关闭 WebSocket → `closeDb()` → 5 秒兜底强杀
- WebSocket：畸形帧 debug、只读越权写入 warn、落库失败 error、连接进出 info

### Agent（`app/main.py` + `app/error_handlers.py`）

- 中间件：分配 `requestId` → 限流 → 计时 → 响应头回写 → 访问日志
- **中间件层异常**单独兜底（FastAPI 的 exception_handler 捕获不到中间件抛出的异常）
- 处理器：`AppError` / `RequestValidationError`（422）/ `StarletteHTTPException` / `Exception`
- `lifespan`：启动打印模型与知识库配置，关闭记一条日志
- 禁用 `uvicorn.access`，避免与中间件访问日志重复

### 前端（`src/lib/errors.ts`）

在 `main.ts` 中**先于 `mount`** 安装：

- `app.config.errorHandler` → 组件渲染/生命周期异常
- `app.config.warnHandler`（仅 dev）
- `window.onerror` → 第三方库 / 资源加载错误（资源失败降为 warn）
- `window.onunhandledrejection` → 「点了没反应」的头号来源；`AbortError` 直接忽略
- `router.onError` → 懒加载 chunk 失败

---

## 五、写代码时的规则

1. **不允许空 catch**。确实要忽略，也要写一行 `log.debug(...)` 说明为什么。
   （历史代码里的 `catch { /* 快照损坏则忽略 */ }` 已全部改为带日志的降级分支。）
2. **不要用 `console.log` 打业务日志**，前端统一 `createLogger(scope)`，后端/Agent 统一 `logger`。
3. **日志里不放变量拼接**：写 `log.info('创建文档', { docId, kind })`，不写 `'创建文档 ' + id`。
4. **异常必须带 cause**：包装错误时保留原始异常，否则只剩最后一层的手写文案。
5. **对外文案与内部细节分离**：`userMessage` 给用户，`message`/`cause` 给日志。
6. **可恢复与不可恢复要分开**：可恢复给「重试」，不可恢复给「下载原始文件」。
7. **日志调用不能抛错**：前端 logger 内部全部 try/catch，后端同理（远程上报失败静默）。

---

## 六、排障流程

### 6.1 用户报「导入失败 / 打不开」

1. 让用户点 ErrorBoundary 的「下载诊断信息」，拿到 `liteoffice-diagnostics-*.txt`
2. 在文件里搜 `level":"error"` 和 `code`
3. 如果是前端解析问题（`parse` / `worker` / `pdf` scope），看 `file` / `size` / `errorName`
4. 如果带了 `requestId`（调用了后端），用同一 ID 在服务端日志里 `grep`

### 6.2 后端排障

```bash
# 只看错误
LITEOFFICE_LOG_LEVEL=warn npm start

# 按请求 ID 串起来（含 WS 与代理）
grep '8f3a1c' server.log

# 统计各类业务错误
grep '"level":"warn"' server.log | jq -r '.code' | sort | uniq -c | sort -rn
```

### 6.3 Agent 排障

```bash
LITEOFFICE_LOG_LEVEL=debug LITEOFFICE_LOG_FORMAT=text uvicorn app.main:app --port 8100
```

关注 `logger":"llm"`（模型调用）、`"logger":"tools"`（工具异常）、`"logger":"graph"`（编排失败）。

---

## 七、验证方式

| 服务 | 命令 | 覆盖 |
|---|---|---|
| 后端 | `node server/test-db-seq.mjs` | 快照序号单调性、HTML 消毒 |
| 后端 | `node server/smoke.mjs`（需先 `npm start`） | 分享 / 协同 / 只读 / 重连 / 撤销 |
| Agent | `python -m app.test_kb` | 知识库（不依赖模型与网络） |
| 前端 | `npm run typecheck && npm run build` | 类型与构建 |

这三条自检在本次改造后全部通过；日志本身另做了人工验证：

- 后端：一次完整 smoke 跑出 20+ 条 JSON 日志，`requestId` 可与响应头对齐，token 字段显示 `<redacted:8>`
- 落盘：后端与 Agent 的 `logs/*.log` 均实际生成；把 `LITEOFFICE_LOG_MAX_BYTES` 调到 1200 后确认轮转出 `.1` / `.2`
- Agent：`422` / `400` / `429` / `500` / `502` 五种错误的响应体与日志均符合本文约定
- 前端：构建产物中 `logger` 被正确 tree-shake 进主包，生产环境仅输出 error
