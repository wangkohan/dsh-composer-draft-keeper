# dsh-draft-keeper 重写 · 共享简报

> 队长（lead）写。**全员开工前必读**，读完不要再重复挖同样的东西。
> 版本：v1 · 2026-11-15

---

## 0. 任务一句话

把 DSH 的「未发送草稿跨会话保留」插件**从零重写**为可公开发布的 `dsh-draft-keeper`：
先能跑 → 再完善 → 最后发 GitHub。

原插件源码已丢失（`D:\DeepSeekHarness\_plugins\draft-keeper` 是**空目录**，已确认）。
所以这是**全新实现**，不是修复。

## 1. 铁律：优先级

> 用户原话：「最好是能被看见，不能被看见也没有关系，但是能用。这个插件得完善，是最起码的基础。」

**能用 > 完善 > 被看见。**

- 一个完善但没人知道的插件，比一个到处宣传但会丢数据的插件有价值得多。
- 不要为了 README 好看而跳过边界测试。
- 九条验收（见 §7）任何一条没过，就回去改，不许往下走。

## 2. 环境事实（已实测，**别重查**）

| 项 | 值 |
|---|---|
| 工作目录 | `D:\DeepSeek\dsh-draft-keeper` |
| 宿主 | DeepSeek Harness **桌面版**（Electron），当前 6 个进程在跑 |
| 当前 GUI | `http://127.0.0.1:5557` |
| profile 目录 | `C:\Users\84901\.dsh\profiles\desktop` |
| 宿主 asar | `D:\Users\84901\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` |
| 读 asar 工具 | `python "D:\DeepSeek\02-宿主运维与自愈\scripts\asar_tool.py" ls <asar>` / `cat <asar> <内部路径>` |
| 已提取的对话区客户端源码 | `D:\Tools\dsh-update\conv-client.js`（**704KB 单行压缩代码**） |
| 参考实现（格式最接近，同区域插件） | `C:\Users\84901\.dsh\profiles\desktop\node_modules\dsh-file-mentions\` |
| node / npm / git | v24.19.0 / 11.17.0 / 2.55.0 |
| gh | 已登录 `wangkohan`，scopes 含 `repo`、`workflow` |
| `D:\DeepSeekHarness` | **不是** git repo → 可以干净建仓 |
| 交接包原文 | `D:\DeepSeek\03-配置与插件\DSH-Draft-Keeper-重写交接包-20261115.md` |

> ⚠️ **改完 `lib/client.js` 必须重启宿主才生效**。宿主启动时按文件内容给客户端模块
> 生成带哈希的地址，文件一改旧地址 404，页面表现为 `<plugin>: import failed` + 卡在
> 「Loading plugins…」，热重载/刷新都接不上。
> ⚠️ 这类打包文件行尾是 **LF**：用 Python 文本模式写回会变 CRLF（diff 炸全文），要二进制读写。

## 3. 已确认的宿主源码事实（原文级，可直接引用）

### 3.1 存储键

```js
const CONVERSATION_STORE_KEY = `dsh.conversation`;
```

全部草稿键 = `` `dsh.conversation.${sessionId}` ``。

### 3.2 官方草稿读取（这是"草稿丢失"的根因）

```js
function readConversationDraft(sessionId) {
  const empty = { text: ``, references: [] };
  if (typeof localStorage === `undefined`) return empty;
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`);
    if (raw === null) return empty;                       // ← 新会话换 id，这里直接返回空
    const stored = JSON.parse(raw);
    if (typeof stored !== `object` || stored === null || !(`draft` in stored)) return empty;
    return parseStoredDraft(stored.draft) ?? empty;
  } catch (_error) { return empty }
}
```

**结论**：点「新建会话」= 换新 sessionId → `raw === null` → 输入框空。
旧草稿其实**还在 localStorage 里**，只是没人去读它。

### 3.3 `parseStoredDraft`：字符串直接放行（这是关键捷径）

```js
function parseStoredDraft(value) {
  if (typeof value === `string`) return resolveDraftInput(value);   // ← 纯字符串直接可用
  const parsed = snapshotSchema.safeParse(value);                   // 富文本走 schema
  if (!parsed.success) return void 0;
  return { text: parsed.data.text, ...quotes, references, ...command };
}
```

**结论**：`{"draft": "纯文本"}` 这种最简形态，宿主能正确解析成 `{text, references:[]}`。
不需要构造复杂的 snapshot 对象（除非要保留引用附件/斜杠命令）。

### 3.4 ★ 官方 store 自己也写这个键（**交接包漏掉的坑**）

```js
function createConversationStore() {
  return defineStore({
    init: () => ({ draft: ``, view: null, viewRequest: null }),
    persist: CONVERSATION_STORE_KEY,        // ← 官方 persist 自动写 dsh.conversation.<id>
    actions: {
      setDraft: (d, text) => { d.draft = text },
      setView: (d, view) => { d.view = view },
      openView: (d, view, focus) => { d.view = view; d.viewRequest = { view, focus } },
      completeViewRequest: d => { d.viewRequest = null },
    },
  });
}
```

**这意味着**：
1. 官方 store 的持久化值是 `{draft, view, viewRequest}` 三者一起写。
   → 如果我们**只** `setItem(key, {"draft":"x"})`、把 `view` 字段弄丢，
   用户的**视图偏好（当前是对话/轨迹视图）会被清掉**。→ 必须**读-改-写**，合并而不是覆盖。
2. 官方会在 `setDraft` 时 persist。如果我们写完新会话的键、官方某个时机又用内存态覆盖回来，
   就白写了。→ **overwrite 窗口有多大、persist 是同步还是 debounce，是 scout 的必答项。**

### 3.5 官方的草稿持久化绑定路径

```js
// InputHub.Shell 上：
bindDraftPersistence(write) { this.persistDraft = write; return () => { if (this.persistDraft === write) this.persistDraft = void 0 } }

// DefaultConversationViews 里：
useEffect(() => {
  const unbindDraftPersistence = bindDraftPersistence(actions.setDraft);
  inputActions.persistDraft();
  return () => { unbindDraftPersistence() }
}, [inputActions]);
```

### 3.6 官方已经会"跨会话搬草稿"（换工作区时）

```js
selectWorkspace: workspaceId => workspaceNavigation.openWorkspace(workspaceId, nextId => {
  if (sessionId !== void 0 && nextId !== sessionId) {
    const from = inputHub.shell(sessionId);
    if (from.snapshot.phase !== `plain` && from.snapshot.phase !== `claimed`) return;
    const draft = from.draftSnapshot;
    const attachmentIds = from.snapshot.attachmentIds;
    const next = inputHub.shell(nextId);
    if (attachmentIds.length === 0 || next.addAttachments(attachmentIds)) {
      ...
      if (draft.text !== ``) { next.setDraft(draft); from.setDraft(``) }
    }
  }
})
```

**结论**：官方在**换工作区**这一条路径上已经在搬草稿了（但**点「新建会话」不搬**）。
我们需要覆盖的是「新建会话」这条路径，不是抢工作区切换的活。

### 3.7 可用的对话区插槽（宿主实测全清单）

```
conversation.composer              conversation.composer.bar
conversation.composer.dock         conversation.header
conversation.header.leading        conversation.hero.agentPreset
conversation.hero.brand.mark       conversation.hero.frame
conversation.hero.options          conversation.hero.workspace
conversation.input.activity        conversation.input.attachments
conversation.input.dock            conversation.input.left
conversation.input.model           conversation.input.overlay
conversation.input.permission      conversation.input.plan
conversation.input.right           conversation.session
conversation.session.header        conversation.session.header.actions
conversation.session.header.corner conversation.session.header.lineage
conversation.session.header.utilities
```

其他常用：`conversation.chat.turnTail`、`settings.section`、`plugins.row.config`、`plugins.bundle.config`

> 注：`conversation.input.dock` 的 kind 是 `list`，`conversation.composer.dock` 是 `list`，
> `conversation.composer` 是 `chain`（**chain 槽注册必须同时给 `id` 和 `select`**）。

### 3.8 前端插件文件格式（0.2.2-rc.3 实测）

```js
window.__ModuleLoader__.load({
  id: "dsh-draft-keeper",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    const inject = ["slots"];
    // ... 实现
    return module.exports;
  }
});
```

### 3.9 插槽注册（两阶段，必须）

```js
slots.inject("conversation.input.dock", () => slots.register(
  { name: "conversation.input.dock", id: "dsh-draft-keeper-dock", select: () => null },
  (props) => { /* React 组件 */ }
));
```

`slots.inject(slot, () => slots.register(opts, Component))` —— 裸 `slots.register` 永不渲染且不报错。

## 4. 必避的历史坑（真实踩过）

| 坑 | 症状 | 对策 |
|---|---|---|
| **发送后回灌** | 发送成功后旧草稿串回输入框，两段内容连成一行（实测出现过 `ZZTEST2 ... ZZTEST3 ...` 连成一行） | 双闸门：① 发送成功后立刻清键；② 写回前校验「当前确实是 blank 新会话」 |
| **hooks 顺序违规（P0）** | 条件调用 `props.X ? X(sel) : undefined` → 崩掉输入框子树，报 `RangeError: Invalid array length` | 所有 hook 无条件在组件顶层调用 |
| **cordis 4 `ctx.inject` 对象形态** | `ctx.inject({a:true, b:{required:false}}, cb)` 里 `{required:false}` **不生效**，每个 key 都算必需服务 → 回调永不触发、路由 404、**零报错** | 只用数组形态 `ctx.inject(['slots'], cb)`，可选服务用时再 `ctx.get()` |
| **宿主回写配置** | DSH 启动会回写 `cordis.patch.yml` 和 `package.json` 的 bundles | 改宿主配置前先停 DSH |
| **改 client.js 不重启** | `<plugin>: import failed` + 一堆 404 + 卡「Loading plugins…」 | 改完必须重启宿主 |
| **Python 写回换行** | LF 被打包文件变 CRLF，diff 炸全文 | 二进制读写 / `newline=''` |

## 5. 功能清单

**核心 3（不做就不算完成）**
1. 跨会话保留 —— 新建会话/切页面后草稿还在
2. 发送后不回灌 —— 双闸门，堵死历史 bug
3. 崩溃恢复 —— 强杀/重启后草稿仍在

**增强 5（决定比原版强）**
4. 按工作区隔离 —— workspace 路径作命名空间
5. 多槽位历史 —— 最近 N 条（默认 10），设置页可翻回
6. 容量上限 —— 总 256KB，超限淘汰最旧
7. 管理界面 —— `settings.section` 卡片：列表 / 逐条删除 / 一键清空 / 总开关
8. 纯本地 —— 零网络请求，不出本机

## 6. 完善标准（验收的唯一判据）

**A. 输入法（中文用户生死线）**
- `compositionstart` / `compositionend` 期间**不触发保存**（否则存进拼音字母）
- `compositionend` 后**补一次保存**（否则最后一个词的改动丢）
- 全角标点、emoji 原样保留

**B. 数据边界**
- 10 万字不卡（debounce ≥ 300ms，单次写入 < 5ms）
- 换行、`\u0000`、零宽字符、emoji 原样往返
- `QuotaExceededError` → 淘汰最旧重试一次 → 再失败静默放弃（不弹错、不阻塞输入）
- 空草稿 / 纯空白不写入、不占空间、不出现在列表

**C. 时序与并发**
- 新建会话 → 立刻切走 → 回来，草稿在
- 发送**失败**时草稿必须还在（不能一律清）
- 多窗口同会话编辑，不能被覆盖成空
- 会话被删 → 草稿标孤儿 → N 天后清理，不能无限堆积
- 同一会话换工作区，草稿跟随**会话**不跟随工作区

**D. 不破坏官方**
- 只读写 `dsh.conversation.<sid>`，不 patch 官方 `createConversationStore` / `readConversationDraft` / `setDraft`
- 装插件后官方草稿输入/发送/引用全正常
- 卸载后官方功能不受影响，残留 key 有清理入口

**E. 健壮**
- 首次安装不覆盖用户已有草稿，只接管新的
- 任何宿主 API 缺失 → 降级 + 一条 debug 日志，**绝不抛异常到 Console**
- 连续 30 分钟 Console 无 error、无 unhandled rejection

**F. 代码**
- 存储层 / 监听层 / UI 层分开
- 注释写「为什么」，不只写「做什么」
- 除 `react` 外**零外部依赖**，单文件 ≤ 40KB

## 7. 九条实跑验收（**不能口头声称**）

1. 新建会话打字 → 切插件页 → 切回，文字在
2. 打字 → 发送 → 新会话输入框为空，无回灌
3. 打字 → 强杀进程 → 重启，草稿在
4. 工作区 A 打 "AAA"、B 打 "BBB" → 切换互不污染
5. 拼音输入 "nihao" 过程中切走 → 回来是「你好」或「nihao」，**不能是半截乱序拼音**
6. 设置页能看列表、单条删除、一键清空
7. 连续输入 3 万字不卡，Console 无报错
8. `dump-config` 无 `skipping profile bundle`、无 `Cannot find package`
9. 禁用插件后官方输入框一切正常

> ⚠️ **第 3 条与第 9 条必须重启宿主**。当前宿主正被用户使用（GUI 5557），
> 重启会中断用户当前会话 —— 验证脚本要写好，但**重启时机由队长跟用户协调**，
> 队员不得擅自 kill 宿主进程。

## 8. 发布硬要求（细节由 market 核对，这里只列已知）

- `package.json` **必须**声明 `dsh.bundle: { patch: "./cordis.patch.yml" }`
  （只写 `dsh.client` 会被拒 —— 最常见退回原因）
- 根目录 `cordis.patch.yml`：
  ```yaml
  - insert:
      - id: draft-keeper
        name: dsh-draft-keeper
  ```
- 仓库建满 **1 天**才能提 PR（CI 自动查）
- 仓库加 topic `dsh-plugin`
- 提 PR 到 `awesome-dsh-plugin/awesome-dsh-plugin`，**只加一个文件**
  `data/plugins/wangkohan__dsh-draft-keeper.yml`，category 用 `session`，**不要手改 README**
- npm 未登录（`ENEEDAUTH`）→ 走 **GitHub-only 条目**
- 描述必须与代码逐条一致（夸大 = 退回首因）

## 9. 已知的"半个同类"（定位参考）

市场索引里已有 **`dsh-draft-attachments`**（`2026heshao`，2 stars，category `ui`）：
按会话持久化输入框中未发送的**附件**（图片/文件，走 IndexedDB + 官方 `createDrafts/addAttachments`）。

→ 它只管**附件**，不管**文本草稿**。我们的差异点：文本草稿 + 跨会话 + 工作区隔离 + 历史槽位 + 崩溃恢复。
→ README/描述里**不要**宣称"唯一"或"首个"，避免与它对撞；用「文本草稿」精确限定。

## 10. 协作约定

- 所有产出落在 `D:\DeepSeek\dsh-draft-keeper\`
- 有疑义先看本简报 §3（源码事实），再看交接包全文
- 挖到新的宿主事实，**追加写进自己的产出文档**，不要只放脑子里
- 不许 kill 宿主进程（见 §7 警告）

---

## 11. ★★ 现场取证补充（队长 2026-11-15 实测，**优先级高于交接包**）

从宿主**真实 localStorage LevelDB** 里直接解出的持久化值原文
（路径 `C:\Users\84901\AppData\Roaming\@deepseek-ai\dsh-desktop\Local Storage\leveldb`）：

**形态 A（旧版，000005.ldb，2026-10-02）**
```json
{"draft": "", "view": "chat", "viewRequest": null}
```

**形态 B（当前版，000284.log，2026-11-15）**
```json
{"draft": {"references": [], "text": ""}, "view": null, "viewRequest": null}
```

### 由此确认的三件事

1. **`draft` 两种形态宿主都吃**：字符串走 `resolveDraftInput`，对象走 `snapshotSchema`。
   → 交接包说"传纯字符串最简"没错，但**对象形态 `{text, references:[]}` 才是当前版本的官方写法**，
   跟官方保持一致更安全（未来版本放宽 schema 时不会翻车）。

2. **`view` 字段是活的**：旧数据里它是 `"chat"`，不是摆设。
   → **任何写官方键的操作都必须「读-改-写」，保住 `view` 和 `viewRequest`**。
   只写 `{"draft":"x"}` 会把用户的视图偏好清零 —— 这是交接包完全没提的坑。

3. **同一 key 在 leveldb 里有多条历史记录**，说明官方 persist **写得很频繁**（不是只在卸载时写）。
   → 外部直接 `setItem` 写官方键，被官方内存态覆盖的风险**真实存在**。

### 因此确定的架构方向（工程师按这个设计）

**不要让插件成为官方键的"第二个写者"去长期维护它。改为「镜像 + 一次性恢复」：**

```
官方键 dsh.conversation.<sid>     ← 官方独占写权（我们只在"恢复"那一刻写一次）
镜像 dsh.draft-keeper.<维度>      ← 插件独占写权（历史槽位 / 容量 / 孤儿清理都在这边）
```

- 监听：持续把草稿变化镜像到自己的命名空间（自己写的，不会被官方覆盖）
- 恢复：新会话创建 / 切换回来时，从镜像取出、**读-改-写**官方键一次（保住 `view`）
- 写入官方键后，官方内存态与磁盘一致 → 后续覆盖也无害（内容相同）
- 所有增强功能（历史 10 条、256KB 淘汰、孤儿清理、清空入口）**只动镜像，不动官方键**
- 卸载时删镜像即可，官方键原样保留 → 满足「卸载即净」

这个方向同时解决了「不破坏官方」和「不怕被覆盖」两个要求。
scout 的 Q1/Q6 请以本结论为校验基准：如果实测发现 persist 是 debounce 或有 flush 钩子，
**补充细节，但不推翻本方向**。

---

## 12. 框架契约（队长从参考实现 `dsh-file-mentions/lib/client.js` 抠出的准确写法）

### 12.1 三种配置位，按需选

```js
// ① 设置页分区（我们要用这个：草稿列表 / 删除 / 清空 / 开关）
slots.inject("settings.section", () => slots.register(
  { name: "settings.section", id: "dsh-draft-keeper-settings", order: 40, label: "草稿保留" },
  () => react.createElement(SettingsCard),      // 注意：() => 形式，不是 (props) =>
));

// ② 插件区行配置（keyed 槽，必须有 key，拼法 = `${包名}#${条目id}`）
const ROW_CONFIG_KEY = "dsh-draft-keeper#draft-keeper";
slots.inject("plugins.row.config", () => slots.register(
  { name: "plugins.row.config", key: ROW_CONFIG_KEY, order: 30, label: "草稿保留" },
  () => react.createElement(SettingsCard, { inCard: true }),
));

// ③ 包级配置
slots.inject("plugins.bundle.config", () => slots.register({ ... }));
```

**关键区别**：
- `settings.section` / `plugins.row.config`：**不需要 `select`**，要 `id`（row.config 要 `key`）+ `order` + `label`
- `conversation.composer`（chain 槽）：**必须给 `select`**，否则抛 `requires options.select`
- 组件传参用 `() => react.createElement(C)`，不是 `(props) => ...`

### 12.2 UI 面积最小化原则

我们**不需要**在输入框区域加任何按钮/徽标。
只用 `settings.section` 一张卡片 + 必要时 `plugins.row.config` 同一张卡片。

理由：每多一个插槽就多一个崩溃面（历史 P0 就是插槽里 hook 顺序违规崩掉输入框子树）。
用户要的是"草稿不丢"，不是"输入框变花"。**能用 > 好看。**

### 12.3 注入声明

```js
const inject = ["slots"];          // 前端只需要 slots
```
可选服务（如 `settings`、`sessions`）**不要**写进 inject 数组 —— cordis 4 里数组形态的每个 key 都是
**必需**服务，缺一个就整插件 pending、零报错。要可选用 `ctx.get('xxx')` 现取，取不到走降级。

### 12.4 官方 `Config` schema（可选的设置持久化）

参考实现用 `export const Config = z.object({...})`（z = `@deepseek-ai/schemastery`）在 host 半声明配置，
profile patch 里按条目 id 存 config，宿主自动生成表单。**但我们不依赖它**：
我们的配置项（开关 / 上限 / 保留条数）直接存自己的 localStorage 命名空间，
理由：少一个宿主 API 依赖 = 少一个故障面，且配置与草稿数据同源好做「一键清空」。

### 12.5 host 半（`lib/index.js`）怎么处理

`dsh.bundle.patch` 的 `insert: [{id, name}]` 会让宿主 import 我们的包并调用 `apply()`。
所以 `main` 必须指向**一个合法的 ESM 模块**。两种做法：

- **做法 A（推荐）**：写一个**最小 host 半**，只导出 `name` + 一个空 `apply()`，
  所有逻辑都在 `client.js`（前端）。满足 bundle 机制、便于以后加 host 能力（如清理定时器）。
- 做法 B：`main` 指向前端文件 —— 不推荐，语义混乱。

采用 A。

---

## 13. ★★ 命名与定位决策（队长拍板，2026-11-15，全员必须遵守）

### 13.1 改名：`dsh-draft-keeper` → **`dsh-composer-draft-keeper`**

**原名字已被占用，不是我多虑，是硬冲突：**

| 位置 | 占用情况 | 证据 |
|---|---|---|
| GitHub 仓库 | `XWIDE/dsh-draft-keeper` 已存在（2026-10-04，2 stars，**1143 次下载**，市场 `ui` 分类） | `gh api repos/XWIDE/dsh-draft-keeper` |
| npm 包 | `dsh-draft-keeper@0.1.0` 已发布（x-wide，2026-10-18） | `npm view dsh-draft-keeper` |
| 新名字查重 | GitHub `in:name` **total_count=0**；npm **HTTP 404** | 双干净 ✓ |

> 注意：`XWIDE/dsh-draft-keeper` 做的是**图片附件**保留（不是文本草稿），
> 但名字占了、下载量还不低。我们沿用原名 = 混淆 + 蹭名嫌疑 + 市场 PR 可能因重名被拒。
> **全项目所有位置必须统一用 `dsh-composer-draft-keeper`**，包括：
> `package.json.name`、`cordis.patch.yml` 的 `name`、仓库名、README、描述、settings label。

### 13.2 差异化：唯一硬差异是「重启后还在」

真同类已逐一核实：

| 插件 | 存储 | 关窗/重启后 | 说明 |
|---|---|---|---|
| `CatLollipop/dsh-composer-draft-cache` | **sessionStorage** | **丢** | 源码第 29 行注释原文：`Storage is browser-lifetime only: an in-memory map plus a sessionStorage` |
| `XWIDE/dsh-draft-keeper` | — | — | 只管**图片附件**，不管文本 |
| `2026heshao/dsh-draft-attachments` | IndexedDB | 附件保留 | 只管**附件**，不管文本 |
| **我们** | **localStorage** | **还在** | 会话级 + 工作区级双层，强杀重启可恢复 |

**这是我们必须打出去的唯一硬卖点**：`sessionStorage` 那类插件，关闭应用就没了；
我们用 `localStorage`，强杀进程、重启 DSH 之后草稿还在。

### 13.3 描述文案（定稿方向）

market 候选 A 需要微调 —— 它写「换工作区也能接上」，但竞品也做得到，不是差异。
真正差异是**重启**。定稿要点：

- ✅ 要讲：切走回来还在 / **强杀重启还在** / 纯本地
- ❌ 不要讲：「首个 / 唯一 / 最强」
- ❌ 不要讲：「换工作区」当卖点（竞品也有）
- 中文 60-90 字，场景提问 + 一句解决

### 13.4 竞品 package.json 里两个值得抄的字段

从 `CatLollipop/dsh-composer-draft-cache` 的 package.json 学到（它是能上市场的）：

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,                                    // ← 立即加载，别等懒加载
    "inject": ["@deepseek-ai/dsh-client-ui-conversation"]    // ← 声明依赖的客户端 UI 包
  }
}
```

`exports` 里显式导出 `./client` 和 `./icon`，`files` 里带上 `cordis.patch.yml`。
