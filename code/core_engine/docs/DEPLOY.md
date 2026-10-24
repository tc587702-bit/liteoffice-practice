# 怎么让别人打开（不用拷文件夹）

LiteOffice 是**纯前端**：打开文档、解析、渲染全在浏览器里完成，**没有后端、没有数据库、没有接口**。
所以「别人怎么用」只有一个问题：**怎么把那一堆静态文件放到他们能访问的地方**。

下面三条路，按「省事程度」排序。

---

## 路线一：同一个 WiFi 直接开（最快，0 成本）

适合：同学/同事在同一个办公室或宿舍，临时看一下。

```powershell
cd C:\deepseekharness\liteoffice
$env:HOST = '0.0.0.0'      # 监听所有网卡（默认只监听 127.0.0.1）
node tools/serve.mjs
```

然后：

1. 用 `ipconfig` 查本机内网 IP（形如 `192.168.1.23`）
2. 告诉对方访问 `http://192.168.1.23:5180/apps/web/`
3. 第一次可能弹 **Windows 防火墙**提示 —— 必须勾选「专用网络」并允许，否则对方连不上

**注意**：这条完全**没有鉴权**，同一局域网内谁知道地址谁就能打开。
不要在公共 WiFi、咖啡厅、公司访客网络下这么干。

---

## 路线二：传到静态托管，给一个网址（推荐）

适合：要发给不在同一网络的人，或者想长期有个可访问的地址。

先打包出一个**自包含的静态站点目录**：

```powershell
cd C:\deepseekharness\liteoffice
node tools/dist.mjs --verify
```

`--verify` 会起临时服务把整个模块图爬一遍（实测 98 个资源 200、0 失败）才宣告成功 ——
这一步很重要：静态托管出错时浏览器只会白屏，本地却能跑，根本不知道哪里错了。

产物：

```
dist/
├── index.html          ← 自动跳转到 ./apps/web/
├── .nojekyll           ← GitHub Pages 必需
├── apps/web/index.html ← 应用入口
├── apps/web/styles.css
└── build/              ← 98 个模块的原生 ESM 产物（无打包器、无 import map）
```

**103 个文件、约 1.3 MB，没有 .ts 源码**（全是类型擦除后的 .js），可以直接公开。

### 更省事：打成一个 zip，直接拖上传

拖一个文件比拖文件夹快，也不用担心中途漏文件：

```powershell
node tools/pack.mjs dist liteoffice-site.zip
```

实测输出：

```
[pack] 103 个文件 -> liteoffice-site.zip（461 KiB）
[pack] 条目 103 个，全部正斜杠；入口文件齐全
    index.html  (298 B)
    apps/web/index.html  (6495 B)
    apps/web/styles.css  (17942 B)
    build/apps/web/src/main.js  (1736 B)
```

**为什么不用 PowerShell 的 `Compress-Archive` / .NET 的 `ZipFile`：**

它们写出的条目名用**反斜杠**（`apps\web\index.html`），而 ZIP 规范（APPNOTE 4.4.17.1）
要求正斜杠。多数静态托管会把它当字面文件名 —— 上传成功、网址能打开、**然后白屏**，
子目录资源全部 404。实测本机 .NET 4.x 的 `ZipFile.CreateFromDirectory` 就是这个行为。

`tools/pack.mjs` 用本项目自己的 `ZipWriter` 打包（内部把 `\` 规范成 `/`），
打完还会读回来校验「条目名无反斜杠 + 四个入口文件齐全」，不合格直接非零退出。

**这个包做过端到端验证**：解压到空目录 → 起静态服务 → 从 `/` 和 `/apps/web/`
出发爬整个模块图，结果 **99 个资源 200、0 失败**。也就是说把它传到任何静态托管都能直接跑。

### 选项 A：Netlify Drop（最省事，不用命令行、不用账号也能试）

1. 打开 <https://app.netlify.com/drop>
2. 把 **`dist` 文件夹**整个拖进去
3. 几秒后得到一个网址，形如 `https://random-name-123.netlify.app`
4. 把这个网址发给别人即可

### 选项 B：GitHub Pages（和仓库放一起）

前提：这台机器要先装 git（当前没有）。见文末「装 git」。

```powershell
cd C:\deepseekharness\liteoffice
node tools/dist.mjs                    # 生成 dist/
git init
git add .
git commit -m "LiteOffice: 零依赖多格式文档平台（第一轮：只读渲染）"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

然后在 GitHub 仓库页面 → Settings → Pages：

- Source 选 **Deploy from a branch**
- Branch 选 `main`，目录选 **`/docs`** 或 **`/ (root)`**

**关键**：Pages 默认只认仓库根或 `/docs`。要么把 `dist` 的内容放到仓库根
（源码就不适合一起放了），要么改成 `/docs` 目录：

```powershell
# 让 Pages 发布 dist：把 dist 内容复制到 docs/（docs/ 里原有的架构文档会被覆盖，注意备份）
```

更干净的做法是用 **GitHub Actions** 发布（`.github/workflows/pages.yml`），
构建后只发布 `dist`，源码与产物彻底分开。需要的话告诉我，我给你写。

发布后的地址是 `https://<用户名>.github.io/<仓库名>/apps/web/`
（或根地址，会自动跳转）。

### 选项 C：Vercel / Cloudflare Pages / 任意 Nginx

都是同一个道理：**构建命令 `node tools/dist.mjs`，输出目录 `dist`**。
不需要 Node 运行时（产物是静态文件），也不需要安装任何依赖。

---

## 路线三：临时给一个公网网址（本机做服务端）

适合：只在几小时内给某个人看一下，不想注册托管。

用 `cloudflared`（免费、无需账号）把本机 5180 端口临时暴露出去：

```powershell
# 先装一次：winget install --id Cloudflare.cloudflared
# 另开一个窗口保持服务运行：
cd C:\deepseekharness\liteoffice
$env:HOST = '0.0.0.0'
node tools/serve.mjs

# 再开一个窗口：
cloudflared tunnel --url http://127.0.0.1:5180
```

它会打印一个 `https://xxx-xxx.trycloudflare.com` 的地址，发给别人即可。
关掉窗口地址就失效。

**注意**：同样是**无鉴权**，拿到地址的人都能打开你的机器提供的页面。
只看静态文件，不会读写对方的任何数据，但也别把这当成私密分享。

---

## 装 git（本机当前没有）

这台机器上 `git` 不在 PATH，也没有 `winget` / `choco` / `scoop`。三种办法：

1. **图形化**：装 [GitHub Desktop](https://desktop.github.com/)，它自带 git，
   还能直接「Add local repository → Publish repository」，全程不用命令行
2. **命令行**：装 [Git for Windows](https://git-scm.com/download/win)，
   装完在 PowerShell 里 `git --version` 验证
3. **不装 git**：直接用 Netlify Drop（路线二·选项 A），把 `dist` 拖进浏览器就行

---

## 一个必须知道的细节：路径不能写成绝对路径

`apps/web/index.html` 引用入口用的是**相对路径** `../../build/apps/web/src/main.js`，
不是 `/build/apps/web/src/main.js`。

原因：绝对路径只在「站点根目录」下成立。一旦部署到子路径
（`https://user.github.io/repo/` 这种），`/build/...` 会指向**域名根**，直接 404，
浏览器白屏 —— 而本地开发一切正常，极难排查。这个坑本项目实际踩过。

如果你要改回绝对路径，就必须保证部署在域名根（自有域名 + Nginx 根目录）。

---

## 发布前检查清单

```powershell
node tools/lint.mjs        # 硬约束巡检
node tools/dist.mjs --verify   # 构建 + 打包 + 爬模块图（98 个资源必须全 200）
```

另外确认：

- [ ] `dist/` 里没有 `.ts` 源码（`node tools/dist.mjs` 保证）
- [ ] `LICENSE` 是你想要的协议（当前是 MIT；做产品建议 Apache-2.0 或 MPL-2.0）
- [ ] 仓库里没有真实文档样本（本项目从来没把用户的 docx/xlsx/pdf 拷进仓库）
- [ ] `dist/`、`build/`、`bench/out/` 都在 `.gitignore` 里
