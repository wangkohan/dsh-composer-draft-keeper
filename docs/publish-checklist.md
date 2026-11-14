# dsh-draft-keeper · 发布合规清单（联网核实版）

> 调研人：market（子代理） · 核实时间：2026-11-15
> 宿主实测版本：DeepSeek Harness 桌面端 **0.2.2-rc.3**（asar 内 `dsh/package.json`）
> **本文所有结论都来自一手抓取，不是交接包转述。** 交接包 §2 有几处与原文不符，已在 §B 标出。

## 0. 核实来源（先说清楚怎么核的）

| 编号 | 来源 | 取回方式 |
|---|---|---|
| S1 | `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md` | `read_page`（GitHub，云端渲染）；最新 commit `923a1c9` · 2026-10-31；262 行 / 36.7 KB |
| S2 | `https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/contributing.md` | `read_page` 原文（含 CI 章节全文，HTML 页那份被截断） |
| S3 | `https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.md` | `read_page`（安装命令、GitHub-only 条目说明、市场索引接入方式） |
| S4 | `data/plugins/XWIDE__dsh-draft-keeper.yml`、`ne-ilyxa__dsh-session-drafts.yml`、`SiriLee__dsh-rewind.yml` 三份 yml 原文 | raw.githubusercontent 直取 |
| S5 | 宿主 asar `dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/install-spec.js`（安装 spec 的权威解析器） | `asar_tool.py cat` 本机读取 |
| S6 | 宿主 asar `dsh/node_modules/@deepseek-ai/dsh/lib/plugin-DC80YBt4.js`（`dsh plugin` 命令实现） | 同上 |
| S7 | 宿主 asar `docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.zh.md`（`engines.dsh` 强制规则） | 同上 |
| S8 | `https://registry.npmjs.org/dsh-draft-keeper` | HTTPS 直接取 registry 元数据 |
| S9 | `https://api.github.com/search/repositories?q=dsh-draft-keeper+in:name` | GitHub Search API |
| S10 | `D:\Tools\dsh-market\plugins.json`（10936 条市场索引，`updated: 2026-11-13`） | 本地 JSON 解析 |

---

## A. 硬性必过（每条都能机械判真假）

### A1 包清单：`package.json` 必须声明 `dsh.bundle`

- [ ] `package.json` 的 `dsh.bundle.patch` 指向仓库根的 patch 文件
- [ ] 带前端 UI 时另写 `dsh.client`（`platform: "web"`）

原文（S2，逐字）：

```
⚠️ Most rejected submissions declare only `dsh.client` — that alone is **not** installable. A complete example：

{
    "dsh": {
      "bundle": { "patch": "./cordis.patch.yml" },   // ← required / 必须
      "client": { "platform": "web" }                // only if you ship browser UI / 仅带前端 UI 时需要
    }
}
```

> 来源：S1/S2 · `contributing.md` §Requirements 第 1 条
> CI 位置：**第 2 项检查**，"Declaring only `dsh.client` fails here."（S2 §What CI checks）
> 读的是**根包**，或 `packages/` · `plugins/` · `apps/` 子包的 `package.json`。

### A2 仓库根必须有 `cordis.patch.yml`

- [ ] 文件在**仓库根**（路径就是 `dsh.bundle.patch` 那个值）
- [ ] 内容是 `insert` 一条 loader 行

原文（S2）：

```
with a `cordis.patch.yml` next to it / 并在仓库根放一个：

- insert:
    - id: your-plugin-id
      name: your-package-name
```

- `id` = 宿主 Loader 里的行 id（随便起，全 profile 内唯一即可）
- `name` = **npm 包名 / 目录名**，不是 GitHub 仓库名
- ⚠️ 交接包 §8 给的写法把 `id` 写成 `draft-keeper`、`name` 写成 `dsh-draft-keeper` —— **id 与 name 不要求相同**，但 name 必须等于 package.json 的 `name`。这一点交接包没写清。

### A3 仓库必须有真实可用代码

- [ ] 不是占位仓库、不是 squat 名称、不是纯 README

原文（S2）："The repo contains real, working code — placeholder, name-squat, or README-only repos don't qualify. / 仓库需有真实可用的代码——占位仓库、纯 README 仓库不收。"
评审第 3 条又查一遍："Is it real, working code rather than a placeholder or a wrapper around nothing."

### A4 仓库年龄：满 **1 天**（从 `created_at` 算，CI 自动查）

- [ ] 仓库创建时间距今 ≥ 24 小时
- [ ] 提 PR 前不要临时新建同名仓库

原文（S2）："The repo is at least **1 day old**. (There is no commit-count bar…)" / "This is checked automatically. It isn't a judgement about your plugin — it filters out repos created minutes before the PR… If you're just under the bar, finish the work and resubmit; nothing is held against a resubmission."
CI 位置：**第 3 项**，命名就叫 "Repo age — the 1-day bar above."

> 交接包说"仓库建满 1 天才能提 PR（CI 自动查）"——**这条是真的**，且是 1 天 = 24 小时，从仓库创建时间起算，**与提交数无关**。
> 佐证：`XWIDE/dsh-draft-keeper` `created 2026-10-04T21:01:24Z`，条目 `added 2026-10-17`（S9 + S10）——13 天，远在门槛之上。

### A5 topic：仓库必须挂 `dsh-plugin`

- [ ] GitHub 仓库 Topics 里含 `dsh-plugin`

原文（S2）："Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your repo. / 为仓库添加 `dsh-plugin` topic。"

> 同赛道插件实测：`CatLollipop/dsh-composer-draft-cache` topics = `["composer","deepseek-harness","draft","dsh","dsh-plugin","plugin","ui-enhancement","workspace"]`；
> 而 `tuifeibenfeifei/dsh-unsent-drafts` topics = `[]` —— 它至今**不在市场索引里**（S10 查无此条），这是 topic 缺失 + 未提 PR 的现实例子。

### A6 描述字段格式（`en` 必填 / `zh` 可选 / 含冒号要引号）

- [ ] `description.en` 必填，一句话，**以句号结尾**
- [ ] `description.zh` 可选；写不了维护者会补，不构成退回理由
- [ ] 描述里出现**英文冒号 + 空格（`: `）必须整段加单引号**；中文全角冒号无此问题

原文（S2）："**Only `description.en` is required.** If you can't write the Chinese, leave `zh` out and a maintainer will add it — a missing translation is our work, not a reason to bounce your plugin."

原文（S2，YAML 引号）：

```
description:
  en: 'Vision toolkit: OCR, grounding and pixel diff.'   # ✅ quoted / 加引号
  zh: '识图工具包：OCR、定位与像素比对。'                    # 中文全角冒号无此问题，加引号也无妨
```

```
  en: Vision toolkit: OCR, grounding and pixel diff.     # ❌ breaks the parser / 解析失败
```

> **实测**：三份真实条目里，含 `:` 的那条一律带单引号（`XWIDE__dsh-draft-keeper.yml` 的 en 段、`ne-ilyxa__dsh-session-drafts.yml` 的 en 段），不含冒号的（`SiriLee__dsh-rewind.yml` 的 zh 段）就不加。**照抄这个习惯最安全。**

### A7 `category` 允许值（原文抄录，共 23 个）

```
`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`
```

> 来源：S2。共 **23** 个 token；`contributing.md` 正文措辞是 "Valid `category` values"。其中 `session` 的中文名是「会话与消息」（S10 `categories.session.zh`）。
> 官方明确说：**"不会有人因为分类被打回"** —— "Nobody gets sent back over a category — if a better one fits, a maintainer just changes it… Pick the closest one and don't agonise."
> 我们选 `session` 与「会话与消息」语义吻合（草稿是会话态）；`ui` 也说得通（输入框属 UI）。**推荐 `session`，理由：`ne-ilyxa/dsh-session-drafts`（草稿会话）与 `SiriLee/dsh-rewind`（草稿回填）都在 `session`，同赛道先例在此。**

### A8 PR 规则：只加一个文件、文件命名、最多 3 条

- [ ] PR **只新增一个文件**：`data/plugins/<owner>__<repo>.yml`
- [ ] 我们的路径：`data/plugins/wangkohan__dsh-draft-keeper.yml`
- [ ] **不要手改 README**（两个 README 由脚本生成）
- [ ] 一个 PR 最多 3 条（超了 CI 拒）
- [ ] 不要动别人的条目（gate 会把 PR 改到的既有条目全列出来）

原文（S2）："Open a PR that adds **one file**, named after your repo — `data/plugins/<owner>__<repo>.yml`"
"**That one file is the whole submission.** The two READMEs are generated from `data/plugins/*.yml`… you should not edit them by hand."
"A pull request may add **at most 3 entries**. Over that, CI rejects it and asks you to split."
"**The READMEs are generated — don't edit them by hand.**"
"If you're updating your own entry, **change only your own entry**."

monorepo 子包文件名规则（我们用不到，但记下）：`url` 指向子目录，`name` 写 `owner/repo#subname`，文件名变成 `owner__repo--packages-my-plugin.yml`。

### A9 `url` / `name` 字段

- [ ] `url` 必须与仓库地址**完全一致**（`https://github.com/wangkohan/dsh-draft-keeper`）
- [ ] `name` 是列表里的链接文字，写 `owner/repo`

原文（S2）：`url: https://github.com/owner/repo        # must match the repo exactly / 必须与仓库完全一致`、`name: owner/repo                          # link text shown in the list`。

### A10 描述必须属实（**头号退回原因**）

- [ ] 描述里出现的每个功能、数字、命令、API 名，代码里都要真有
- [ ] 不带最高级、不带营销词（不用 唯一 / 首个 / 最好 / 最强）

原文（S2）："**The description must be accurate.** It is read as a claim about your plugin, and it is checked against your code. If you write "46 tools across six domains", there should be 46 tools and six domains… **Overstating is the one thing that gets an otherwise-good plugin sent back.**"
"Descriptions state what the plugin does — no superlatives or marketing."

> **对我们的直接影响**：BRIEF §5 的「增强 5」里，**没实现的功能一个字都不许写进描述**。描述里若写「最近十条」「256KB 上限」，代码里就得有常量与淘汰逻辑。

### A11 CI 四项检查（顺序固定）

原文（S2 §What CI checks）：

1. **Entry count** — 每 PR 最多 3 条，最先查，早于任何网络请求
2. **`dsh.bundle`** — 从 `package.json` 读（根包或 `packages/`·`plugins/`·`apps/` 子包）；只写 `dsh.client` 在这里失败
3. **Repo age** — 1 天门槛
4. **`awesome-lint` + 站点构建** — locale parity、分隔符、日期、截图

"CI 通过是**前置条件**，不是结论" —— 合并前维护者会实读仓库。

### A12 宿主侧额外硬门槛（清单不查，但装不上就白搭）

- [ ] `engines.dsh` 写成**字符串** semver 范围（S7）；`workspace:` 值在 `engines.dsh` 里无效
- [ ] 官方 `@deepseek-ai/*` 放 `peerDependencies`，且**范围必须带显式预发布分支**

原文（S2 / S7）：`"peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0" }` —— 不带 `||` 预发布分支会让 `0.1.0-rc.6` / `0.2.x-rc.*` 被静默排除，用户装的时候撞 `ERESOLVE`。
S7 补充：v0.2.1-alpha.3 起，profile 安装同时按 `engines.dsh` 与 DSH peer 判兼容性；缺 `engines.dsh` 时退化用 peer 范围；`engines.dsh` 不是字符串会直接报错并被拒。

> 我们宿主是 `0.2.2-rc.3`，`engines.dsh` 建议写 `">=0.2.0-rc.1 <0.3.0-0 || >=0.3.0-rc.1"` 这类带预发布分支的范围（具体下限按实测支持的最老版本定）。

---

## B. 容易踩的坑

### B1 ★★ 命名冲突：`dsh-draft-keeper` 这个**名字已经被别人占用**（最严重）

| 查什么 | 结果 | 来源 |
|---|---|---|
| npm `dsh-draft-keeper` | **已占用**：HTTP 200，`latest = 0.1.0`，维护者 `x-wide <xiupk@sina.com>`，创建 `2026-10-18T02:44:17Z` | S8 |
| GitHub `XWIDE/dsh-draft-keeper` | **已存在**，`created 2026-10-04T21:01:24Z`，2 stars，topics 含 `dsh-plugin` | S9 |
| GitHub `wangkohan/dsh-draft-keeper` | **404，尚不存在**（可以建） | `read_page` 直取 404 |
| 市场上同名条目 | `XWIDE/dsh-draft-keeper`，category `ui`，`added 2026-10-17`，`install: dsh plugin --profile web add dsh-draft-keeper` | S10 |

**这不是"几乎撞名"，是彻底撞名**：仓库名、npm 包名、市场条目三者全被同一个第三方（XWIDE）占了。而且它做的正是「按会话保住输入框里粘贴的**图片**草稿」——同一片地。

后果三条，必须选一条走：

1. **改名**（推荐）：`dsh-composer-draft-keeper`。实测 npm 404、GitHub `in:name` 搜索 `total=0`，**两头都干净**（S8/S9 同批查询）。
2. **GitHub 保留 `wangkohan/dsh-draft-keeper` + npm 用 scope `@wangkohan/dsh-draft-keeper`**（scope 未占用，实测 404）。但市场里会出现两个 `dsh-draft-keeper`，评审第 4 条（是否已被覆盖）与第 6 条（重名混淆）都会被追问。
3. **纯 GitHub-only 条目**，不碰 npm。此时 `package.json` 的 `name` 仍会被 `dsh plugin add` 当包名用——用 `dsh-composer-draft-keeper` 最省事。

**我推荐 1**：名字里明确带 `composer`，与 XWIDE 那条（图片/附件）从名字上就区分开，也避开"重名抢占"的观感。

> ⚠️ 交接包 §6 直接写 `gh repo create dsh-draft-keeper` + `gh repo edit wangkohan/dsh-draft-keeper`，**没有查过这个名字在 npm 和 GitHub 上是否已被别人占用**。这是交接包最大的疏漏。

### B2 npm vs GitHub-only：两种条目的区别与安装命令

原文（S3）："The index covers plugins published on npm with a known version; **GitHub-only entries still install with the command beside them.**"

| | npm 条目 | GitHub-only 条目 |
|---|---|---|
| yml 里怎么写 | 只写 `url` / `name` / `category` / `description`（**不写 npm 字段**，索引从 registry 自己读） | 同样四个字段，不写 npm |
| 索引生成的 `install` | `dsh plugin --profile web add <包名>` | `dsh plugin --profile web add github:<owner>/<repo>` |
| 实例 | `ne-ilyxa/dsh-session-drafts` → `dsh plugin --profile web add @ne-ilyxa/dsh-session-drafts` | `CatLollipop/dsh-composer-draft-cache` → `dsh plugin --profile web add github:CatLollipop/dsh-composer-draft-cache` | 
| 额外好处 | "prebuilt installs skip the `allowBuilds` build-approval step"（免构建授权弹窗） | 走源码安装，纯 JS 无构建的话也不会弹 |
| 可选字段 `tarball:` | — | 可给 GitHub Release 的 https `.tgz`；**仓库无法从源码安装时此项必需** |

> 来源：S3（README 索引段）+ S2（tarball / npm 建议段）+ S10（两条 `install` 字段实测值）

### B3 `dsh plugin add` 的真实语法（本机源码核实，不是猜）

`dsh plugin` 的本体是 `dsh plugin --profile <profile> <pnpm 参数>`，`add` 后面的 spec 由 `parseInstallSpec()` 解析（S5/S6）。**它接受的形式**：

| spec 形态 | 例子 | 说明 |
|---|---|---|
| GitHub 简写 | `github:owner/repo` | `GIT_SHORTHAND = /^(?:github\|gitlab\|bitbucket\|gist):/i`，映射到对应 host |
| git URL | `git+https://github.com/owner/repo.git` | 也吃 `git@host:` 的 scp 形式 |
| 仓库 HTTPS 地址 | `https://github.com/owner/repo` | `HOSTED_REPOSITORY_URL` 直接放行 |
| **钉提交** | `github:owner/repo#<40位完整 sha>` | `pinnedGitOrigin()` 只认完整 40 位 SHA；`#` 之后可带 `path:<子目录>`（monorepo） |
| npm 名 / 名+范围 | `dsh-pause`、`@ne-ilyxa/dsh-session-drafts@0.7.0` | 走 registry |
| tarball | `x.tgz`（绝对路径）或 `https://…/x.tgz` | `TARBALL_SPEC` |

**关于 `#branch`**：解析器不拦（`github:owner/repo#main` 会被整段交给 pnpm，pnpm 支持），但宿主侧**只有完整 40 位 commit SHA** 才会被识别成"钉住的来源"（`pinnedGitOrigin` 要求 `FULL_COMMIT.test(...)`）。所以：

- **给人看的文档 / 清单条目录入**：`github:owner/repo`（最稳，跟市场上 4000+ 条一致）
- **要可复现、防上游漂移**：`github:owner/repo#<40位sha>`
- **别用 `#main` 当"钉版本"**——它不构成钉住，只是分支引用

**`--profile` 怎么用**（S6）：

- 位置固定：`dsh plugin --profile <profile> add <spec>`（`--profile` 在 `plugin` 之后、子命令之前）
- profile 名就是 `~/.dsh/profiles/<name>`；桌面端固定叫 `desktop`
- 桌面端 profile 有个硬约束，源码原文报错：
  `Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.`
  → **先启动过一次应用、再完全退出应用**，才能跑 `--profile desktop`
- 市场索引里写的 `--profile web` 是 **web 档**的写法；桌面端用户照抄会装进另一个 profile。**README 里两种都写清楚，别只抄清单那行。**
- 子命令还有 `remove <package>`、`update`、`allow-version <pkg@ver> --dsh-version <exact> --accept-risk`、`revoke-version`、`version-exemptions`（S6/S7）

### B4 交接包写错/漏掉的地方（逐条对照）

| 交接包说法 | 原文事实 | 判定 |
|---|---|---|
| §2「`dsh.bundle` 必须，只写 `dsh.client` 会被拒」 | 完全一致 | ✅ 对 |
| §2 `cordis.patch.yml` 只写 `- insert: - id / name` | 一致，但需补：`name` 必须等于 `package.json.name` | ⚠️ 不完整 |
| §2「仓库建满 1 天」 | 一致（`created_at` 起算，CI 第 3 项） | ✅ 对 |
| §2 topic `dsh-plugin` | 一致 | ✅ 对 |
| §6「npm 未登录（ENEEDAUTH）→ 走 GitHub-only」 | **不是主要原因**：包名 `dsh-draft-keeper` 已被 `x-wide` 占用，**登不登录都发不了** | ❌ 归因错误 |
| §6 `gh repo create dsh-draft-keeper` | 名字与既有 GitHub 仓库 `XWIDE/dsh-draft-keeper` 同名 | ❌ 有踩坑风险 |
| §6 装法 `dsh plugin --profile desktop add github:wangkohan/dsh-draft-keeper` | 语法正确；但桌面端必须先退出应用才能跑 `--profile desktop` | ⚠️ 少了前置条件 |
| 未提 | 描述含 `: ` 必须加引号（YAML 解析） | ❌ 漏 |
| 未提 | 官方包 `peerDependencies` 必须带预发布 `||` 分支，否则 `ERESOLVE` | ❌ 漏 |
| 未提 | `engines.dsh` 必须是字符串 semver；v0.2.1-alpha.3 起安装按它判兼容 | ❌ 漏 |
| 未提 | 一个 PR 最多 3 条；改到别人条目会被 gate 列出 | ❌ 漏 |
| 未提 | `held: author` 标签机制：被 hold 后只在同分支推修复 + **一条**评论，反复 push 不会加速 | ❌ 漏 |

### B5 其他小而致命的坑

- **`private: true` 会挡住 npm 发布**。`CatLollipop` 那条就写了 `"private": true`（纯 GitHub-only 的自保写法）。我们若要发 npm，**必须删掉**。
- **`tarball:` 的 `latest/download/` 陷阱**（S2）：文件名里带版本号 → 提交当天有效，下次发版 404。要么资产名不带版本，要么钉 tag。
- **`exports` 要给 `./client`**：`2026heshao` 与 `CatLollipop` 两家都写了 `exports: { ".": "./index.js", "./client": "./client.js" }`，宿主按子路径加载客户端模块。
- **`files` 白名单**：两家都显式列 `files`。少列 `cordis.patch.yml` 或 `client.js`，源码安装能跑、npm 安装就缺文件。
- **`held: author` 不会自动摘**：只有重新评审才摘。自查入口是每天 06:19 UTC 刷新的「Held pull requests that may have healed」跟踪 issue。
- **PR 冲突几乎全在生成的 README 行上**，且"靠自己重新生成 README"正是历史上把 218/296 个开放 PR 变成不可合并的元凶 —— **别碰 README**。
- **不查重复就等于赌运气**：评审第 4 条明写"是否已被现有条目覆盖…两个插件做同一件事时，先来者保留位置…规则不是先来后到，规则是谁更好"。→ 详见 `docs/positioning.md`。

---

## C. 模板原文（真实条目，逐字照抄）

### C1 `data/plugins/XWIDE__dsh-draft-keeper.yml`（现存的同名条目，category `ui`）

```yaml
url: https://github.com/XWIDE/dsh-draft-keeper
name: XWIDE/dsh-draft-keeper
category: ui
description:
  en: 'Keeps the images you pasted or attached in the composer, per session: they are mirrored locally in the browser and handed back through the official draft channel when you return to the conversation or the composer remounts, and dropped as soon as the message is sent or you remove them.'
  zh: '按会话保住输入框里的图片草稿：在浏览器本地留一份镜像，切回该对话或输入框重新挂载时经官方草稿通道放回去；消息一旦发出或你手动移除，就不再见它回来。'
```

> 来源：S4。注意 en 里有 `: ` → 整段单引号；zh 里是全角冒号，也加了引号（"加引号也无妨"）。

### C2 `data/plugins/ne-ilyxa__dsh-session-drafts.yml`（**category `session`** 的同赛道条目）

```yaml
url: https://github.com/ne-ilyxa/dsh-session-drafts
name: ne-ilyxa/dsh-session-drafts
category: session
description:
  en: 'Cursor-style New Session: every click creates a fresh blank draft session (persisted before the first message) instead of reusing the workspace''s single one, plus a sidebar Drafts switcher to keep several empty chats open at once.'
  zh: 'Cursor 风格的新会话：每次点击都新建一个空白草稿会话（首条消息前即持久化），不再复用工作区唯一的空会话；侧栏新增草稿切换器，可同时保留多个空会话。'
```

> 来源：S4。**关键细节**：en 里出现英文单引号（`workspace's`）时，YAML 单引号字符串要写成 **`''`** 双写转义 —— 这是最容易被 lint 抓的一处。

### C3 `data/plugins/SiriLee__dsh-rewind.yml`（**category `session`**，草稿回填语义近邻）

```yaml
url: https://github.com/SiriLee/dsh-rewind
name: SiriLee/dsh-rewind
category: session
description:
  en: 'Conversation rewind: one click back to any earlier user message, in the same window — no new branch, no leftover copy; the target message is refilled into the composer, with optional workspace-file restore — the full Claude Code /rewind semantics.'
  zh: 对话回退：一键回到任意更早的用户消息，同窗口内完成，不新建分支、不残留副本；目标消息自动填回输入框，可一并还原工作区文件——即完整的 Claude Code /rewind 语义。
```

> 来源：S4。这条**只有 en 加引号、zh 不加**（zh 无 `: `）—— 说明引号是"遇到 `: ` 才加"，不是一律加。两种都合法。

### C4 真实 `package.json` 的 `dsh` 段（两个同赛道插件，逐字）

`2026heshao/dsh-draft-attachments`（GitHub-only，纯前端）：

```json
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web"
    }
  },
```

`CatLollipop/dsh-composer-draft-cache`（host 半边 + 客户端半边）：

```json
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-conversation"
      ]
    }
  },
```

> 来源：GitHub raw 直取（2026-11-15）。
> `dsh.client.inject` / `immediately` 是可选字段：声明你依赖哪个官方客户端包，宿主据此排加载顺序。`XWIDE` 的 npm 包写的是 `"inject": ["@deepseek-ai/dsh-client-ui-slots"]`。

### C5 真实 `cordis.patch.yml`（两份，逐字）

`2026heshao/dsh-draft-attachments`：

```yaml
# 让 Loader 以独立插件行装载本包（与官方 dsh-web-app patch 的行同构）。
# 不改任何官方行：只插入一行，卸载即恢复。
- insert:
    - id: draft-attachments
      name: dsh-draft-attachments
```

`CatLollipop/dsh-composer-draft-cache`：

```yaml
# Mount the composer toolkit bundle into the DSH profile.
# The Host row reads the @plugin mention tokens out of the messages entering a
# step and publishes the selected plugins' metadata as runtime context. The
# package's `dsh.client` section supplies the composer draft cache, the `@`
# plugin completion source, and the sent-message mention renderer.
- insert:
    - id: composer-draft-cache
      name: 'dsh-composer-draft-cache'
```

> 来源：GitHub raw 直取。`name` 一律等于 `package.json.name`；`id` 与包名可以不同（`composer-draft-cache` vs `dsh-composer-draft-cache`）。
> 注释写清楚"为什么插这一行"，与 BRIEF §6「注释写为什么」一致。

### C6 我们该交的条目（建议稿；`name` 待命名决策后填）

```yaml
url: https://github.com/wangkohan/dsh-composer-draft-keeper
name: wangkohan/dsh-composer-draft-keeper
category: session
description:
  en: 'Keeps unsent composer text as a per-session, per-workspace draft in local storage, so it comes back after you switch away, change workspaces, or restart the app; a sent or deliberately cleared draft does not come back.'
  zh: 按会话与工作区把未发送的文本草稿存在本机，切走、换工作区、重启之后回来仍在；已发送或手动清空的草稿不会回灌。
```

> 为什么这么写：en 含 `: `？没有 → 无需引号（但加引号也不违规）；zh 全角冒号逗号 → 可不加。
> 描述里**只出现 BRIEF §5 的核心 3 条**（跨会话保留 / 不回灌 / 重启恢复）。**"最近十条""256KB""设置页管理"暂不写**，等代码落地再加，避免 A10 那条头号退回原因。

---

## D. 发布前最后一屏（照这个顺序走）

1. 命名定案（B1）→ 改 `package.json.name`、README、`cordis.patch.yml` 的 `name`
2. `engines.dsh` 写字符串范围；官方包全进 `peerDependencies` 并带预发布 `||` 分支
3. 删 `private: true`（若要发 npm）
4. `files` 白名单必须含 `index.js` / `client.js` / `cordis.patch.yml`
5. `gh repo create` → 打 topic `dsh-plugin` → 等满 24 小时
6. 描述逐条对着代码核一遍（A10）
7. fork → 加 `data/plugins/wangkohan__<repo>.yml` → PR 标题 `Add wangkohan/<repo>`
8. 被 `held: author` 就在同分支推修复 + **一条**评论，然后等
