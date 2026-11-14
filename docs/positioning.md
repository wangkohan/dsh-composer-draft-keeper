# dsh-draft-keeper · 差异化定位（市场同赛道全扫描）

> 调研人：market（子代理） · 核实时间：2026-11-15
> 数据源：`D:\Tools\dsh-market\plugins.json`（**10936 条**，索引自报 `updated: 2026-11-13`，meta `name: awesome-dsh-plugin`）
> 交叉验证：GitHub REST API（`/repos/...`、`/search/repositories`）、npm registry、各仓库 raw README

---

## 0. 扫描方法（为什么不是 grep）

13 MB 单行 JSON，`grep` 打全文既慢又定位不到字段。用 node 解析成对象，**按字段分层过滤**：

```bash
cd /d/Tools/dsh-market
node -e "
const fs=require('fs');
const j=JSON.parse(fs.readFileSync('plugins.json','utf8'));
const arr=j.plugins;                       // 10936
const txt=p=>p.name+' '+p.owner+' '+(p.description.en||'')+' '+(p.description.zh||'');
// 第一层：名字里带 draft/keep/unsent/persist/cache/save/resume/recover
arr.filter(p=>/draft|keep|unsent|persist|cache|save|resume|recover/i.test(p.name)).forEach(p=>console.log(p.owner+'/'+p.name,p.category,p.stars,p.npm));
// 第二层：英文描述里出现 unsent（比 'draft' 精确得多）
arr.filter(p=>/unsent/i.test(p.description.en||'')); 
// 第三层：中文描述里出现 未发送/没发送/打了字却没发
arr.filter(p=>/(未发送|没发送|打了字却没发|未发出)/.test(p.description.zh||''));
"
```

三轮结果：第一层 **87 条**（大量 `*-cache-billing` 之类是"缓存计费"，无关）；第二层 **8 条**；第三层 **9 条**。再人工去重 → **4 条真·同赛道 + 4 组邻接**。

> 为什么必须分三层：单用 `draft` 命中 **331 条**，其中 95% 是"改写/润色草稿"（prompt optimizer 那一大池子），与"保留草稿"毫无关系。**`unsent` 这个词才是这条赛道的分水岭。**

---

## 1. 命中清单（全量，含原文描述）

### 1.1 真·同赛道：做「未发送草稿保留」的（4 个）

#### ① `CatLollipop/dsh-composer-draft-cache` ★ 最接近，必须正视

| 字段 | 值 |
|---|---|
| owner / repo | `CatLollipop` / `dsh-composer-draft-cache` |
| category | `ui` |
| stars | 0 |
| npm | **null**（GitHub-only） |
| install | `dsh plugin --profile web add github:CatLollipop/dsh-composer-draft-cache` |
| 市场 inserted | `added: 2026-10-24` |
| 仓库创建 / 最后推送 | `2026-10-22T23:52:06Z` / `2026-10-23T11:17:06Z`（≈3 周没动） |
| topics | composer, deepseek-harness, draft, dsh, dsh-plugin, plugin, ui-enhancement, workspace |

**描述原文（en）**：
> Composer enhancements: caches unsent drafts per workspace for new sessions and per Session id for existing ones, restoring them after switching away and dropping them once sent or cleared; adds an @plugin completion group that mentions an installed plugin so the agent receives that plugin's metadata as runtime context for the turn.

**描述原文（zh）**：
> 输入框增强：按工作区缓存新会话草稿、按会话缓存已有会话草稿，切换后自动恢复，发送或清空后不再回填；同时在 @ 补全中增加"插件"分组，选中已安装插件后会把该插件信息作为运行时上下文交给 Agent。

它的真实实现（读源码结构：`client.js` 28 KB / `index.js` 5 KB / `lib/mentions.js` / `test/` 两个测试文件）：
- 无界面，注册 `conversation.input.dock` 一行恒返回 `null`
- 双作用域：新会话按 workspace 路径作 key，已开会话按 sessionId 作 key
- 恢复谓词 `sawText`：本挂载还没见过文字时才允许恢复，避免复活已发送内容
- **存储 = 内存 Map + `sessionStorage` 镜像（键前缀 `dsh.composer-draft-cache.v1:`）**，README 原文：*"Survives a page reload, **discarded when the app window closes**; never writes to the Host or the Session log."*

#### ② `romany-saad/dsh-plugins#dsh-drafts`

| 字段 | 值 |
|---|---|
| owner / repo | `romany-saad` / `dsh-plugins`（monorepo 子包 `packages/dsh-drafts`） |
| category | `ui` |
| stars | 3 |
| npm | `@rs-dsh/dsh-drafts` v0.1.2 |
| install | `dsh plugin --profile web add @rs-dsh/dsh-drafts` |
| 仓库创建 / 最后推送 | `2026-10-24T15:58:39Z` / `2026-11-10T08:15:50Z`（**仍在维护**） |
| added | `2026-10-30` |

**描述原文（en）**：
> Get back what you typed and walked away from: a new Web conversation you leave before sending never appears in the sidebar, so its draft is out of reach. This plugin lists those drafts above the composer of the next new conversation, newest first, with their workspace and time; Open takes you back with the text and chips in place, and Discard drops one, with Undo.

**描述原文（zh）**：
> 找回打了字却没发送就离开的内容：未发送就离开的新 Web 对话不会出现在侧栏，里面的草稿也就找不到了。本插件在下一个新对话的输入框上方按时间倒序列出这些草稿，并显示所属工作区与时间；「打开」带你回到原对话，文字和引用条原样还在；「丢弃」可撤销地删除草稿。

语义差异：**它给的是一个「草稿列表」，要你手动 Open 回原会话**；不是"回到当前新会话时自动填回"。

#### ③ `2026heshao/dsh-draft-attachments`（BRIEF §9 已知的那个）

| 字段 | 值 |
|---|---|
| category | `ui` | stars | 2 | npm | null |
| install | `dsh plugin --profile web add github:2026heshao/dsh-draft-attachments` |
| 仓库创建 / 最后推送 | `2026-10-11T15:37:38Z` / `2026-10-19T10:11:32Z` |
| topics | attachments, composer, deepseek-harness, deepseek-harness-plugin, draft, dsh-plugin, indexeddb, persistence |

**描述原文（en）**：
> Persists unsent composer attachments per session, so images and files pasted into the input box survive page switches, conversation switches and app restarts: the bytes are mirrored in IndexedDB and handed back through the official createDrafts/addAttachments channel, and are dropped as soon as the message is sent or you remove them.

**描述原文（zh）**：
> 按会话持久化输入框中尚未发送的附件：切页、切换会话乃至重启应用后回到该会话，草稿图片与文件会经官方 createDrafts/addAttachments 通道自动恢复；消息发出或手动移除后不会再出现。

**只管附件字节，文本一个字不碰。**

#### ④ `XWIDE/dsh-draft-keeper` ★★ 跟我们**同名**

| 字段 | 值 |
|---|---|
| category | `ui` | stars | 2 | npm | **`dsh-draft-keeper` v0.1.0（已占名）** |
| install | `dsh plugin --profile web add dsh-draft-keeper` |
| 仓库创建 / 最后推送 | `2026-10-04T21:01:24Z` / `2026-10-08T05:19:05Z` |
| added | `2026-10-17` |

**描述原文（en）**：
> Keeps the images you pasted or attached in the composer, per session: they are mirrored locally in the browser and handed back through the official draft channel when you return to the conversation or the composer remounts, and dropped as soon as the message is sent or you remove them.

**描述原文（zh）**：
> 按会话保住输入框里的图片草稿：在浏览器本地留一份镜像，切回该对话或输入框重新挂载时经官方草稿通道放回去；消息一旦发出或你手动移除，就不再见它回来。

它的 README 明确写"**只镜像图片**"（`kind === "image"`），文档类草稿一律不碰；每会话 12 张 / 32 MB。**功能上仍是附件赛道，但它占着 `dsh-draft-keeper` 这个名字。**

### 1.2 邻接（4 组，沾边但不是同类）

| 插件 | category | stars | 为什么不算同类 |
|---|---|---|---|
| `hffek/dsh-steer-note` | ui | 1 | 插话栏 + **任务结束时救援未发送草稿**（次要能力，主功能是 steer 注入） |
| `railgun20001/dsh-session-status-hub` | notify | 0 | 只在标题栏把"输入框里有未发送草稿"当**状态灯**（灰点）用，不保存不恢复 |
| `baisama-cloud/dsh-composer-history` / `PerryLink/dsh-composer-history` / `Domush/dsh-plugin-message-history` / `HandsYe/dsh-input-history` / `liumorrisclaw/dsh-composer-input-history` | ui | 3/19/0/0/0 | 都是 **↑↓ 历史召回**：召回"已发送的消息"，顺带"退出历史时把草稿放回去"。不解决"切走后草稿没了"，也没有跨会话/跨重启语义 |
| `tuifeibenfeifei/dsh-unsent-drafts` | —（**不在市场索引里**） | 0 | 侧栏面板列出"有草稿但没发消息"的会话 + 每 2 秒后台备份 + 跳回。**方向同赛道但形态是浏览器/列表**，且仓库 topics 为空、未提 PR，所以索引里查不到 |

`tuifeibenfeifei/dsh-unsent-drafts` 的仓库元数据：`created 2026-10-23T10:27:17Z`，`pushed 2026-10-23T14:47:49Z`，`topics: []`，描述 "DSH client plugin: list unsent composer drafts (sessions you typed into but never sent) in a sidebar panel." 它的 README 与 BRIEF §3 的结论完全一致（草稿在 `localStorage` 的 `dsh.conversation.<sessionId>`，`{draft, view}`，空白会话也在会话目录里 `blank: true`）——**独立验证了我们的根因判断，可以直接引用它当旁证。**

---

## 2. 判断：**有真同类，但不是"完全被覆盖"**

### 2.1 结论一句话

**有真同类。** `CatLollipop/dsh-composer-draft-cache` 在**功能意图上与我们的核心 3 条中的第 1 条（跨会话保留）撞车**，且实现路径（`conversation.input.dock` + 无界面 + 双作用域 key）几乎一模一样。但它**只活到页面关闭**，其余四条增强它一条都没有。

### 2.2 逐条对比（我们的 BRIEF §5 清单 vs 现有 4 个）

| 我们的能力（BRIEF §5） | CatLollipop/draft-cache | romany-saad/dsh-drafts | 2026heshao 附件 | XWIDE 图片 |
|---|---|---|---|---|
| 1 跨会话保留（新建会话/切页后仍在） | ✅ | ⚠️ 给列表，需手点 Open 回原会话 | ❌（仅附件） | ❌（仅图片） |
| 2 发送后不回灌 | ✅（`sawText` 谓词） | ✅（Discard/Undo） | ✅ | ✅ |
| **3 崩溃恢复（强杀/重启后仍在）** | ❌ **`sessionStorage`，关窗即丢** | ✅（草稿本就在官方 localStorage，它只是加了个入口） | ✅ IndexedDB | ✅ IndexedDB |
| **4 按工作区隔离** | ✅（新会话按 workspace 路径） | ✅（显示所属工作区） | ❌ | ❌ |
| **5 多槽位历史（最近 N 条，设置页可翻回）** | ❌ | ⚠️ 列表是"未发送会话"，不是"最近 N 条历史版本" | ❌ | ❌ |
| **6 容量上限（256KB，超限淘汰最旧）** | ❌（无上限、无淘汰） | ❌ | ⚠️ 12 张/32 MB（图片维度） | ⚠️ 12 张/32 MB |
| **7 管理界面（settings.section 卡片：列表/删除/清空/总开关）** | ❌（无界面，headless） | ⚠️ 有列表 UI，但挂在输入框上方，不是设置页；无总开关 | ❌ | ❌ |
| **8 纯本地零网络** | ✅ | ✅ | ✅ | ✅ |

### 2.3 真正的差异点（可写进 README 的、可验证的）

1. **活过关窗**：CatLollipop 用 `sessionStorage`，README 自己写"discarded when the app window closes"。我们落 `localStorage`（BRIEF §3.1 那个键空间）+ 读-改-写合并，**强杀进程/重启后仍在**——这是 BRIEF 的核心 3 之一，也是唯一一个能一句话说清、且对方文档自认做不到的差异。
2. **多槽位历史**：不是"当前那一份草稿"，而是"最近 N 条草稿可回溯"。四个同赛道插件全都没有。
3. **有管理面 + 总开关**：能在设置页看列表、逐条删、一键清、整体关。其余全是 headless 或只有输入框下方列表。
4. **容量与淘汰**：256KB 上限、超限淘汰最旧、`QuotaExceededError` 降级不阻塞输入（BRIEF §6 B 段）。四个都没做容量淘汰。
5. **IME 安全**（BRIEF §6 A 段）：composition 期间不保存、`compositionend` 补存。**这一点在 10936 条索引里，同赛道没有一个提到中文输入法。** 对中文用户是实打实的差异。

### 2.4 最接近的那个、差在哪（一句话版）

- 最接近：`CatLollipop/dsh-composer-draft-cache`（2026-10-23 后停更，0 star，GitHub-only）
- 差在：**关窗即丢**（`sessionStorage`）、**无历史槽位**、**无管理面**、**无容量淘汰**、**无 IME 处理**，且它一半功能是无关的 `@plugin` 提及

### 2.5 写描述时的自我约束（重要）

- ❌ 不许写「唯一」「首个」「最好」「最完整」
- ❌ 不许写「业界第一个解决草稿丢失」之类 —— 有 4 个同行
- ✅ 可以写「重启后仍在」——对方文档自认做不到，可核
- ✅ 可以写「最近十条」「设置页」「256KB」——**但只在代码真的实现之后**
- ✅ 与 XWIDE 那条划清界限的措辞：**「文本草稿」**（对方是图片/附件）

---

## 3. 描述文案候选（`en` 1 条 + `zh` 3 条）

**硬约束**：中文 60–90 字（汉字计）；场景提问 + 一句解决；不罗列功能清单；不用营销词；提到的每个功能都必须在 BRIEF §5 里、且发布前已实现；不宣称唯一/首个/最好。

### 候选 A（推荐 ★）—— 主诉「切走回来是空的」，落到核心 1+3+4

> **zh**（74 汉字）：
> 新建会话里打了一段话，没发送就切去看插件页，回来输入框却是空的？这个插件把没发出去的文本草稿按会话存在本机，切回来、换工作区、乃至强杀重启之后都还能接上原来那段。

> **en**：
> Typed something in a new session, left without sending, and came back to an empty box? This plugin keeps that unsent text as a per-session draft on your machine, so it is still there after you switch away, change workspaces, or kill and restart the app.

### 候选 B —— 主诉「白打一遍」，带出历史槽位与不回灌

> **zh**（68 汉字）：
> 写了一半跑去点别的页面，回来发现草稿没了，只能重打一遍？插件在你打字时把内容存在本机，返回时自动填回，发送成功后不会回灌；最近十条也能在设置页翻回来。

> **en**：
> Halfway through a message you click another page, and the draft is gone — retype it? The plugin keeps what you typed on your machine and puts it back when you return; a sent message never leaks back in, and the last ten drafts are listed in Settings.

### 候选 C —— 主诉「换工作区/重启就丢」，强调本地与零联网

> **zh**（61 汉字）：
> 切换工作区或者重启应用，之前没发出去的那段就找不到了？草稿按会话和工作区分开保存，程序崩溃后依然能恢复，全部只写本机，不联网也不上传。

> **en**：
> Switch workspaces or restart the app and whatever you had not sent is gone? Drafts are stored per session and per workspace on disk, survive a crash, and never leave your machine.

**我最推荐 A**：它把 BRIEF §0 那句用户原话（点「插件自动化任务」再回来）几乎原样复述成提问，评审读一眼就知道解决的是哪个真实场景；且只承诺"会话 + 工作区 + 重启"三件代码必然会有的事，不含任何需要等实现的功能名。

> ⚠️ 共同风险：B 里「最近十条」、A/B/C 里的"重启后仍在"都必须有对应代码。**发布前用 `positioning` 这三条对着 `lib/` 逐条核一遍再往 yml 里抄。**

---

## 4. README 标题候选（3 个）+ 顶部一句话

### 标题候选

1. **`dsh-draft-keeper · 没发出去的，切回来还在`**
   理由：名字 + 一句人话；「切回来」直接对上用户操作序列。
2. **`草稿不丢：DSH 输入框的未发送文本，跨会话、跨工作区、跨重启`**
   理由：三个"跨"正是与 4 个同行的分界线，一眼可核。
3. **`写了一半也可以走：DSH 未发送草稿保留`**
   理由：场景化，不吹功能；中文语感最好，适合放 README 首行。

### 顶部一句话（15 字内，给市场卡片/README 首行用）

> **切走再回来，你写的还在。**（11 字）

备选：
- **没按发送，也不算丢。**（9 字）
- **关掉再开，草稿还在。**（9 字）

---

## 5. 顺带给队长的两条可复用情报

1. **命名必须先定案**：`dsh-draft-keeper` 这个包名/仓库名已被 `XWIDE` 占用（npm 200 + GitHub 已存在），详见 `docs/publish-checklist.md` §B1。定位文档里我一律按 `dsh-composer-draft-keeper` 举例。
2. **`tuifeibenfeifei/dsh-unsent-drafts` 的 README 独立复现了我们 BRIEF §3 的根因结论**（草稿在 `dsh.conversation.<sessionId>`、值 `{draft, view}`、空白会话 `blank: true`、官方切回会话时会自动回填）。**可以直接拿它当第三方旁证写进 README 或 PR 说明**，比自说自话有说服力。
