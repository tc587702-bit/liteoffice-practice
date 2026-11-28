# 答辩用 Slidev 演示（defense.md）

与仓库现有 `docs/slides/slides.md`（产品设计文档）同一套 Slidev 工程，新增一份独立 deck：
**`docs/slides/defense.md`** —— 按课程大纲组织的项目汇报（28 页）。

## 本地预览

```bash
cd docs/slides
npm install            # 或 pnpm install
npx slidev defense.md  # 打开浏览器实时预览
```

## 构建为静态站点

```bash
cd docs/slides
npx slidev build defense.md --base /liteoffice-practice/defense/ --out dist-defense
```

产物在 `docs/slides/dist-defense/`，上传后访问：

```
https://<用户名>.github.io/<仓库名>/defense/1
```

## 与现有 GitHub Pages 流水线整合

当前 `.github/workflows/deploy.yml` 只构建 `slides.md`，需要再构建一次 defense 并合并到同一份 Pages 产物。

把 `Build Slidev` 这一步替换为下面三步：

```yaml
      - name: Build Slidev（产品文档）
        run: npm run build

      - name: Build Slidev（答辩 deck）
        run: npx slidev build defense.md --base /liteoffice-practice/defense/ --out dist-defense

      - name: 合并到同一份 Pages 产物
        run: |
          mkdir -p dist/defense
          cp -r dist-defense/. dist/defense/
```

`Upload artifact` 的 path 仍然是 `docs/slides/dist`，不需要改。

## 与 PPT 版本的关系

| 文件 | 用途 |
| --- | --- |
| `docs/slides/defense.md` | 网页版（Slidev），适合投屏、远程演示、发链接 |
| `答辩-LiteOffice-终版.pptx` | 离线版（16:9 PPTX），适合现场没有网络或要求交 PPT 文件 |

两份内容一致：同一套 19 个内容点，网页版拆得更细（28 页），PPT 版按页合并。

## 演示提示

- 键盘：`→` 下一页、`←` 上一页、`o` 总览、`f` 全屏
- 导航栏已在 `style.css` 里隐藏，演示时不会误触
- 图表用 Mermaid 渲染，离线也能显示（构建时已内联）
- 若现场网络不稳：直接用本仓库的 PPTX 版本，内容相同
