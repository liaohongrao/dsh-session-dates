# 发布说明（dsh-session-dates）

这个包已经按「可直接发布」的形态准备好了：`package.json` 元数据、`README.md`、`LICENSE`（MIT）、`icon.svg`、以及一份符合 DSH 市场格式的索引样例 `market/index.json`。

发布分两件事：**先把包发到 npm**，**再让市场索引收录它**。

## 0. 前置条件

- 一个 npm 账号（<https://www.npmjs.com/signup>）。
- 一台能访问 `registry.npmjs.org` 的机器。本机沙箱内没有出网能力（`curl https://registry.npmjs.org/-/ping` 返回 000），所以这步需要在沙箱外、由你本人执行。
- 包名 `dsh-session-dates` 若已被占用，改 `package.json` 里的 `name` 为 `@<你的scope>/dsh-session-dates`，并同步改 `market/index.json`。

## 1. 发布到 npm

```sh
cd dsh-session-dates
npm login                 # 或 pnpm login
npm publish --access public
```

本机只有 pnpm，也可以用：

```powershell
node D:\dsh-home\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs publish --access public --no-git-checks
```

发布成功后验证：

```sh
npm view dsh-session-dates version    # 应输出 0.2.0
```

升级版本后用同样的命令再发一次（`npm version patch|minor`）。

## 2. 上架到插件市场

DSH 的市场就是一份 **format 1 的 `index.json`**。有两种做法，选一种即可。

### 2.1 用社区目录（推荐，用户「开箱可见」）

社区目录由 `awesome-dsh-plugin`（站点 <https://awesome-dsh-plugin.com>，索引在 `https://awesome-dsh-plugin.com/index.json`）和 npm 包 [`dsh-plugin-catalog`](https://www.npmjs.com/package/dsh-plugin-catalog)（索引在 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`）维护，DSH 的「发现」默认会用到。收录方式是给对应仓库提 Issue / PR，把 npm 包名加进清单。仓库地址和贡献说明以站点首页的说明为准（本机无法直连，故不在此处写死链接）。

提 PR 时需要的信息就是本包这些：

```json
{
  "name": "dsh-session-dates",
  "versions": [{ "version": "0.2.0", "publishTimestamp": 1793188800, "source": { "type": "npm" } }]
}
```

### 2.2 自己托管索引（完全可控）

1. 把 `market/index.json` 和 `icon.svg` 放到同一目录上传到任意 https 静态主机（GitHub Pages、对象存储、你自己的服务器都可以）。
2. 打开 DSH：**插件 → 发现（Discover）→ 添加索引源**，填入 `index.json` 的 https URL。
3. 索引里 `"icon": "icon.svg"` 是相对路径，会按索引 URL 解析，所以图标和索引要放在同一目录。

索引格式的权威说明：<https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market.md>。

## 3. 发布前检查清单

- [ ] `package.json`：`name` / `version` / `license` / `keywords` / `files` 齐全，没有 `private: true`。
- [ ] `dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh.client.inject` 里包含 `@deepseek-ai/dsh-client-ui-sidebar`。
- [ ] `README.md` 说明了安装方式和已知边界。
- [ ] 本地先 `plugin_manager install_bundle` 装一遍，确认侧边栏行为正常。
- [ ] `market/index.json` 里的 `version` 与 `publishTimestamp` 和实际发布一致（Unix 秒）。
- [ ] 如启用 GitHub Actions，在仓库 Secrets 里配置 `NPM_TOKEN`。

## 4. 自动化发布（可选）

仓库里的 `.github/workflows/publish.yml` 会在推送 `v*` 标签时用 `NPM_TOKEN` 发布。启用步骤：把本目录推到你的 GitHub 仓库 → 在仓库 Settings → Secrets 里加 `NPM_TOKEN`（npm 的 Automation token）→ `git tag v0.2.0 && git push --tags`。
