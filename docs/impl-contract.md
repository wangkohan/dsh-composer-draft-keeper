# dsh-draft-keeper 实现契约（impl-contract）

> **这份文档是工程师写代码的唯一依据。** 每条结论后面都跟着 asar 内部路径 + 函数名 + 原始片段。
> 凡标 `【实测】` 的是本机运行时取到的证据，标 `【源码】` 的是 asar 内可读源码，标 `【待实测】` 的进第 4 章。
>
> 取证环境：DeepSeek Harness 桌面版，asar `D:\Users\84901\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`，
> 版本目录 `dsh/node_modules/@deepseek-ai/*`。**该版本 asar 内含 TypeScript 源码（`src/`），比压缩后的 `lib/client.js` 可读性高一个量级，优先读 src。**
>
> 关联：`docs/BRIEF.md` §3（已确认事实）、§11（LevelDB 现场取证）。本文不与它们冲突，只做**细化与校正**。
> 中间产物全部留在 `docs/_tmp-*.js|ts|txt`，工程师要复核可直接看。

---

## 1. 结论摘要（只看这 12 行就能开工）

1. **官方 persist 是同步的，没有 debounce、没有 flush、没有 dispose 写回。** 每一次输入内容变化 → 一次 `localStorage.setItem`。**外部直写官方键，会被用户下一次按键（通常 < 1 秒）整键覆盖。**
2. key 的拼法是 `defineStore` 内部的 `` `${persist}.${scopeKey}` ``，`scopeKey` 就是 `sessionId`（运行时实证：LevelDB 里键名就是 `dsh.conversation.session-<uuid>`）。
3. persist 写的是 `JSON.stringify(整个 store state)`，**不带信封、不做字段白名单**；rehydrate 用 `setState(parsed, /*replace*/ true)` **整体替换**。
4. 因此：**官方键只有一个合法写者 = 官方 memory state。** 想让官方键里有值，最稳的路是**驱动官方内存态**，不是 `setItem`。
5. **有一条比 `setItem` 好得多的官方通道被交接包漏掉了**：每个 session 作用域插槽的 props 里都有 `inputActions`，含 `setDraft(text)` 与 `persistDraft()`。调它 = 直接改官方编辑器 + 触发官方 persist，**写进去的值和内存态天然一致，不存在覆盖窗口**。
6. 次优通道：`ctx.get('conversation').input.shell(sessionId)`（运行时存在、类型契约未导出，见 §3.5 风险标注）。
7. 兜底通道：`localStorage` 读-改-写。**只在官方 API 不可用、或官方 store 尚未创建的新会话窗口里用**，且必须与内存态语义一致。
8. **发送成功后清草稿的不是 `setDraft('')`，是 `commit-draft` effect → `draftEditor.clearCommittedDraft(...)` → 编辑器清空 → 触发 publish → persistDraft 写入空 draft。** 失败路径完全不清（effects 为 `[]`）。
9. `phase` 有 **5 个值**：`plain | claimed | adjudicating | submitting | sending`。后三个是"冻结态"（编辑器只读），插件在这三态**禁止**写草稿。
10. **每次新 session binding 解析都会重新 `readConversationDraft` + `readConversationViewPreference`**；同一 binding 复用内存 shell（WeakMap）。切走再切回，通常 binding 已释放 → shell 重建 → **从 localStorage 重读**。
11. `view` 字段是活的。写 `{draft:"x"}` 丢掉 `view` → 顺序上 `readConversationViewPreference` 返回 `null` → `resolveActiveView` 回落 `chat` → **用户如果在轨迹视图会被强行拉回对话视图**。必须读-改-写。
12. `sessionId` 有两种形态：`session-<uuid>`（当前）与裸 `<uuid>`（旧版遗留）。**按工作区隔离不要拿 sessionId 做哈希，用 `sessions.list.byId[sid].cwd`。**

---

## 2. 推荐的写入方案

### 2.1 三层写入，从高到低

| 层 | 手段 | 何时用 | 覆盖风险 |
|---|---|---|---|
| **L1 首选** | `props.inputActions.setDraft(text)` + `props.inputActions.persistDraft()` | 当前已挂载的 session 槽里，任何时候（phase 为 plain/claimed） | **零**（写的就是官方内存态） |
| **L2 次选** | `ctx.get('conversation').input.shell(sessionId).setDraft(text)` + `.persistDraft()`（若 run 时存在） | L1 拿不到 / 想在非当前 session 上预置 | 零（同上），但属**非契约 API** |
| **L3 兜底** | `localStorage` 读-改-写官方键 | 官方 store 还没创建的新会话窗口；L1/L2 全失效 | **高**，见 §3.1.5 |

**工程纪律：默认只写 L1。L3 必须放在"官方 API 探测失败"的 `catch`/`else` 分支里，并且打一条 debug 日志。**

### 2.2 主循环伪代码

```js
// ---------- 观测层（只读，零副作用） ----------
// 在 conversation.input.dock（scope: session）里注册组件，props 自带：
//   sessionId, session, inputActions, useInput, useConversation, useSession, useSessions
function DraftKeeper({ sessionId, inputActions, useInput }) {
  const draft  = useInput(s => s.draft)   // string，clipboard 投影
  const phase  = useInput(s => s.phase)   // 'plain'|'claimed'|'adjudicating'|'submitting'|'sending'
  const rev    = useInput(s => s.draftRev)

  // 1) 镜像：草稿变化 → 写自己的命名空间（永不写官方键）
  useEffect(() => {
    if (phase === 'adjudicating' || phase === 'submitting' || phase === 'sending') return // 冻结态不落镜像
    if (isComposing()) return                  // 输入法保护（compositionstart/end，见 BRIEF §6A）
    mirror.write(sessionId, draft)             // debounce >= 300ms，内部用 try/catch 吞 QuotaExceededError
  }, [sessionId, rev, phase, draft])

  // 2) 恢复：只做一次，只在一个明确的、可证明空的时机
  useEffect(() => {
    if (restoredFor.has(sessionId)) return     // 一次性闸门：本 session 本页生命周期只恢复一次
    if (phase !== 'plain' && phase !== 'claimed') return
    if (draft !== '') return                    // ★ 闸门二：官方已有内容就不动（首次安装不吃用户已有草稿）
    const saved = mirror.read(sessionId)
    if (saved === null || saved.trim() === '') { restoredFor.add(sessionId); return }
    restoredFor.add(sessionId)                  // 先占位，防重入
    restoreVia(inputActions, saved, draft)
  }, [sessionId, phase, draft])

  return null
}

// ---------- L1 恢复 ----------
function restoreVia(inputActions, text, currentDraft) {
  try {
    inputActions.setDraft(text)        // 改官方 Lexical 编辑器（进 undo 合并栈，不产生独立 undo step）
    inputActions.persistDraft()        // ★ 必须显式再调一次：见 §3.1.3「immer 无变化不通知」
    return true
  } catch (e) { debug('setDraft failed', e); return false }
}
```

### 2.3 L3 兜底：读-改-写（只在官方 API 全失效时）

```js
const KEY = sid => `dsh.conversation.${sid}`

function writeOfficialDraftRaw(sid, text) {
  const key = KEY(sid)
  let base = {}
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed
    }
  } catch (_) { base = {} }                      // 坏 JSON：按空基底处理，别把坏值留在盘上
  // ★ 只替换 draft，其余字段（view / viewRequest / 未来新增字段）原样带回
  const next = { ...base, draft: text }
  try { localStorage.setItem(key, JSON.stringify(next)) } catch (_) {}
}
```

四条铁律：

1. **必须 `JSON.parse` 原值再展开**，禁止 `setItem(key, JSON.stringify({draft:x}))`。
2. **`draft` 推荐写字符串**：`parseStoredDraft` 对 `typeof value === 'string'` 直接 `resolveDraftInput`（`src/client/draft.ts`）。写对象 `{text, references:[]}` 也对，但字符串最不容易被 schema 的 `refine` 拒掉。
3. **不要往官方键里塞任何自定义字段**。理由见 §3.1.4（未知字段虽然理论上能活过一次 rehydrate，但没有契约保证，且一旦 store 已存在就必然被吃）。
4. **写完必须接受"会被覆盖"**：L3 只在"官方 store 尚未存在"的窗口有意义。判断窗口的办法见 §3.1.5。

### 2.4 插件自己的命名空间（唯一长期真相）

```
dsh.draft-keeper.v1.drafts.<sid>      // { text, at, cwd, sessionIdForm }
dsh.draft-keeper.v1.history.<sid>     // [ {text, at}, ... ] 最多 N 条
dsh.draft-keeper.v1.meta              // { version, totalBytes, installedAt }
```

- 只在**自己**的键上做淘汰 / 容量 / 孤儿清理（BRIEF §11 方向，正确）。
- 卸载只删 `dsh.draft-keeper.v1.*`，官方键原样保留。
- 容量统计含 key 长度，别只算 value（LevelDB 里 key 也占空间，且 sessionId 形态两种）。

---

## 3. Q1–Q6 逐条回答 + 源码证据

### Q1. 官方 `defineStore` 的 persist 机制

#### 3.1.1 包在哪里 —— 结论：`@deepseek-ai/dsh-client-store` **在 asar 里没有独立目录**

- `asar_tool.py ls` 全量 21717 条，`@deepseek-ai/` 下 338 个包，**没有 `dsh-client-store`、也没有 `dsh-client-ui-slots` 目录**。
- 它们被 esbuild **内联进 web shell 主 bundle**：
  `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-Ciz7DZxv.js`
- 已切出完整实现 → **`docs/_tmp-client-store-impl.js`（1611 字节，就是全部实现）**。

`dsh-client-store` 的完整导出面（压缩名 → 真名）：

```js
// index-Ciz7DZxv.js
const NN = Object.freeze(Object.defineProperty({
  __proto__: null,
  createSnapshotStore: kp,     // = 真名 createSnapshotStore
  defineStore:         ON,     // = 真名 defineStore   ★
  notifySubscribers:   F2,
  shallowEqual:        zN,
}, Symbol.toStringTag, { value: 'Module' }))
```

#### 3.1.2 key 怎么拼出来的

```js
// defineStore = ON
function ON(e){ return { spec:e, create(t){
  const r = e.persist === void 0
    ? void 0
    : t === void 0 ? e.persist : `${e.persist}.${t}`          // ★ 就是这里
  const i = kp(e.init(), r !== void 0 ? { persist: { name: r } } : void 0)
  ...
```

- `t` 是 **store scope key**。`stores.ts` 里 `persist: 'dsh.conversation'`，`create(sessionId)` → 键 = `dsh.conversation.<sessionId>`。
- 【实测】LevelDB 里键名逐条核对无误：`dsh.conversation.session-0c413aaa-...`、`dsh.conversation.session-a4ab5480-...`。
- `create(t)` 的 `t` 由 slots 运行时的 store scope 传入（槽 `conversation.session` 声明 `scope: 'session'`，见 `src/client/apply.ts` registerConversationSession）。运行时键名即 sessionId，闭环。

#### 3.1.3 写入是同步还是 debounce，延迟多久 —— **同步，零延迟，无批量**

```js
// createSnapshotStore = kp
function kp(e,t){
  const r = hN(()=>e), i = fN()(r)              // hN=middleware(subscribeWithSelector), fN=zustand createStore
  t?.persist && EN(i, t.persist.name)           // ★ 建 store 时立刻接持久化
  let n = o => i.subscribe(()=>{ F2([o],"[client-store]") })
  if (t?.flush === 'raf') { ... }               // ★ raf 批量：只有显式传 flush:'raf' 才启用
  return { getSnapshot:()=>i.getState(), subscribe:o=>n(o),
           update:o=>{ i.setState(IN(i.getState(), l=>{o(l)}), true) },   // IN = immer.produce
           set:o=>{ i.setState(o, true) } }
}

function EN(e,t){                                // ← persist 接线，全部真相在这 8 行
  if(!(typeof localStorage>'u')){
    try{ const r = localStorage.getItem(t); r !== null && e.setState(JSON.parse(r), true) }   // ① 建时 rehydrate 一次
    catch(r){ console.error(`snapshot store '${t}' rehydration failed:`, r) }
    e.subscribe(r=>{ try{ localStorage.setItem(t, JSON.stringify(r)) } catch(i){ ... } })     // ② 之后同步写
  }
}
```

三个必须记住的事实：

1. **`defineStore` 永远不会传 `flush`**：`ON` 调 `kp(e.init(), r!==void 0 ? {persist:{name:r}} : void 0)` —— 第二参数只有 `persist`，**`spec.flush` 字段压根没被读取**。→ 会话草稿 store **一定走同步分支**。
2. 同步的含义：`setState` 里 `r.forEach(listener => listener(state))` 是普通 forEach，`localStorage.setItem` 在同一 tick 完成。**没有 microtask、没有 rAF、没有 debounce。**
3. **`update` 用 immer `produce`**：`setState(IN(getState(), d => { action(d, ...args) }), true)`。immer 在**没有任何实际修改**时返回**原对象引用**，而 zustand 的 `setState` 有 `if (!Object.is(y, t))` 守卫 → **不通知 → 不写盘**。
   → `setDraft('')` 在 draft 已是 `''` 时**什么都不会发生**（这一条直接决定 §2.2 里为什么要显式 `persistDraft()`）。

#### 3.1.4 序列化：`JSON.stringify` 整个 state，无信封、无白名单

- 写入：`JSON.stringify(r)`，`r` 是 store 的**完整 getState()**。
- 读取：`e.setState(JSON.parse(r), true)`。zustand vanilla 的 `setState(partial, replace)` 语义：

```js
// zustand vanilla createStore = dN
const i = (h, v) => {
  const y = typeof h == 'function' ? h(t) : h
  if (!Object.is(y, t)) {
    const w = t
    t = (v ?? (typeof y != 'object' || y === null)) ? y : Object.assign({}, t, y)   // v=true → 整体替换
    r.forEach(b => b(t, w))
  }
}
```

`v === true` → `t = y`，**整体替换，不合并**。

由此推两条（**第 2 条进不确定项**）：

- 确定性结论：**官方键里多出来的字段会进入 state**（replace 是全量替换，不做 schema 校验，没有 zod）。之后 `update` 走 immer produce（保留 base 全部字段）、`stringify` 再写回 → **理论上能活过一轮**。
- ⚠️ 但这条**只在"store 尚未创建"时写才成立**。store 一旦存在，你 `setItem` 的字段永远进不了内存态，下一次 `setState` 就没了。而且没有任何契约保证未来版本不在 init 里补 `Object.assign`。→ **所以镜像绝不能存官方键里，BRIEF §11 的判断正确。**

反例（会伤人的）：坏 JSON。`JSON.parse` 抛错 → `console.error('snapshot store ... rehydration failed')`，**坏值不会被清掉**，直到官方第一次 `setState` 用 init 值覆盖它。所以别写坏 JSON。

#### 3.1.5 flush / dispose / 卸载写回钩子 —— **一个都没有**

`defineStore` 返回的对象就 5 个成员：

```js
return { actions:n, getSnapshot:()=>i.getSnapshot(), subscribe:o=>i.subscribe(o), store:i,
         clearPersisted:()=>{ if(!(r===void 0||typeof localStorage>'u')) try{ localStorage.removeItem(r) }catch{} } }
```

- **没有 `flush`**：不存在"脏数据待写"，因为每次变更都同步落盘。
- **没有 `dispose` / 卸载写回**：`EN` 里的 `e.subscribe(...)` 连退订函数都没保存，store 被 GC 就自然失效。`InputHub` 的 scope disposer 只 `shell.dispose()`（`src/client/input/hub.ts:183` 之后），**`dispose()` 里没有 `persistCurrentDraft()`**（`facade.ts` 第 608 行起）→ 卸载不补写。
- **`clearPersisted()` 是唯一的清理入口**，且它只 `removeItem` 官方键 —— 我们自己要清键时**优先用它**（如果有 handle），比手写 `localStorage.removeItem` 语义更正规。

#### 3.1.6 ★ 覆盖窗口到底多大（最重要的一问）

**结论：不是"多大窗口"的问题，而是"几乎必然被覆盖"。**

覆盖的发生条件是「官方 store 的 memory state 发生一次实际变化」。触发它的日常动作：

| 用户动作 | 触发链 | 是否覆盖 |
|---|---|---|
| 打字 | editor update → `publish()` → `persistDraft(draftSnapshot)` → `actions.setDraft` → immer 有变化 → `setState` → `setItem` | ✅ 覆盖 |
| 切视图（对话↔轨迹） | `selectView` → `actions.setView` → `setState` → `setItem` | ✅ 覆盖（整键重写，draft 用内存里的旧值） |
| 发送成功 | `commit-draft` → 编辑器清空 → `publish` → `persistDraft(空)` → `setItem` | ✅ 覆盖 |
| 官方 `persistDraft()` 的首次绑定 | `DefaultConversationViews` 的 `useEffect`：`bindDraftPersistence(actions.setDraft)` 后立刻 `inputActions.persistDraft()` | ✅ 覆盖（把 shell 内存里的 draft 写一次） |
| 什么都不做 | — | ❌ 不覆盖 |

**量化证据【实测】**（扫 LevelDB 全部 `.ldb`/`.log`，脚本见 `docs/_tmp-*` 调用记录）：

```
11 次  dsh.conversation.session-01cdd198-af94-4683-8c16-d583f99725e4
 6 次  dsh.conversation.session-f1dc5e2f-8662-4980-a153-c41ffecd44a9
 4 次  dsh.conversation.session-a4ab5480-8dec-4703-b245-8977e8208b83
 3 次  dsh.conversation.session-a4ab5480-...（另一 value）
 ...   每个活跃会话 1~11 条历史版本
```

同一个键在一个会话里留下十几条历史版本 = **每次输入内容变化都写了一次**。所以"外部 `setItem` 之后官方不会再写"这个假设不成立；用户只要接着敲一个字，你的值就没了。

**唯一安全的窗口 = 官方 store 尚未创建的那一瞬间**：

```
新建/切换会话
  → uiSession.provide 的 resolve(binding) 跑（apply.ts:322）
      → inputHub.shellFor(binding)      ← 这里 readConversationDraft（读 localStorage）
  → 槽 conversation.session 挂载 → conversationStore.create(sessionId)   ← 这里 rehydrate（再读一次）
  → DefaultConversationViews.useEffect → bindDraftPersistence + persistDraft()  ← 从这里开始覆盖
```

插件**插不进这个同步窗口**（都是同一 tick 内官方自己完成的）。所以：

> **别赌 localStorage 直写。走 L1（`inputActions`）——它写的是官方内存态本身，覆盖对它无效，因为覆盖写的就是同一个值。**

---

### Q2. 发送成功后草稿是怎么被清的

#### 3.2.1 清空链（完整、可追）

```
用户 Enter
 → InputActions.submit() → SubmitMachine.dispatch({type:'enter'})            [machine.ts onEnter]
 → phase='sending'，effect: {type:'default-sink', attempt, draft, mode}
 → facade.sinkSerialized → deps.defaultSink(...)   // 真正 RPC
 → Host 接受 → facade.acceptSink / applySinkOutcome({kind:'success'})
 → dispatch({type:'sink-settled', ok:true})                                  [machine.ts onSinkSettled]
 → effects = [{type:'commit-draft', retainSuffixOf:null}]
 → facade.commitDraft(null) → draftEditor.clearCommittedDraft(...) + draftEditor.clearHistory()
 → Lexical editor.update → onEditorUpdate → publish()
 → publish(): if (draft !== lastPublishedDraft) persistDraft?.(draft)        [facade.ts 末尾]
 → store actions.setDraft({text:'',references:[]}) → immer 有变化 → setState → setItem
```

**关键结论三条**：

1. **不是 `shell.setDraft('')` 清的**。是 `commitDraft()` 直接操作编辑器（`clearCommittedDraft`），**清空是编辑器的副作用**，再由 `publish()` 顺带 persist。（所以想"拦一下不清空"没有钩子。）
2. `clearCommittedDraft` 的 `prefixLength` 回调支持"发送期间用户继续打的字"：`retainSuffixOf !== null && clip !== retainSuffixOf && clip.startsWith(retainSuffixOf)` → 只删已发送的前缀。**`retainSuffixOf: null` 表示全清**（普通消息走这条）。
3. `clearHistory()` 紧接着调用 —— **发出去的内容不可被 undo 撤回**。这也是历史 bug「发送后回灌」的一个诱因：如果有人把旧草稿再 `setDraft` 一次，它进的是**新的** undo 栈。

#### 3.2.2 发送失败时草稿在哪

```js
// machine.ts onSinkSettled
private onSinkSettled(ev) {
  ...
  this.phase = 'plain'
  const effects = ev.ok ? [{ type: 'commit-draft', retainSuffixOf: null }] : []   // ★ 失败 → 空数组
  const text = ev.message ?? ev.outcome?.text
  if (text !== undefined) effects.push({ type:'notice', level: ..., text })
  return effects
}
```

**失败路径 `effects = []` → 什么都不做 → 编辑器和 draft 原封不动**，只弹一条 notice。
`facade.failSink()` / `applySinkOutcome(accepted=false)` 走的都是这一个分支。

命令路径同理（`onSubmitSettled`，`ev.ok === false`）：`this.claim = ev.command; this.phase = ev.command===undefined?'plain':'claimed'` —— 编辑器内容保留，claim 复位。

→ **插件纪律：绝不能"发送请求一发出就清镜像"。清镜像的唯一时机 = 观察到 `draft` 变成 `''`（或 `draftRev` 前进且内容为空）。**

#### 3.2.3 `phase` 的五个值是什么意思

`src/client/contract/input.ts:56`：

```ts
readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting' | 'sending'
```

`src/client/input/machine.ts` 全文只有一个 phase 字段，语义：

| 值 | 含义 | 编辑器 | 谁设置 |
|---|---|---|---|
| `plain` | 空闲。无 claim、无在飞消息 | 可写 | 初始态；`followCommand(undefined)`；任一 attempt 结算后 |
| `claimed` | 编辑器首部有 slash 命令 chip，但没按 Enter | 可写 | `followCommand(claim)`（chip 插入/删除/历史恢复） |
| `adjudicating` | 已按 Enter，draft 以 `/` 开头，正在仲裁这是不是命令 | **只读** | `onEnter` 里 `trimmed.startsWith('/')` |
| `submitting` | 已确认是命令，`begin-submit` 进行中（`/goal`、`/plan` 等） | **只读** | `onEnter`(claimed) 或 `onAdjudicated(outcome.claim)` |
| `sending` | 普通消息已交给 Host，**等 Host 接受** | **只读** | `send(attempt)` |

冻结判定（`facade.ts:99`）：

```js
function frozen(phase) { return phase === 'adjudicating' || phase === 'submitting' || phase === 'sending' }
```

→ **`frozen(phase)` 为真时：不写镜像、不恢复、不改草稿。** 另外 `addAttachments`、`insertQuote` 也在这里被拒。

---

### Q3. session 切换时会发生什么

#### 3.3.1 `readConversationDraft` 的调用点：**只在 shell 首次创建时**，不是每次切换

```js
// src/client/input/hub.ts  (shellFor 末尾)
shell.setDraft(readConversationDraft(binding.sessionId))
return shell
```

`shellFor(binding)` 开头：

```js
const existing = this.shells.get(binding)          // WeakMap<SessionBinding, SessionInputShell>
if (existing !== undefined) return existing        // ← 命中就不读盘
```

→ **同一 binding 第二次进来不读盘**；只有新 binding 才读。

#### 3.3.2 `inputHub.shell(sessionId)` 是不是每 session 一个

是，但 key 是 **SessionBinding**（不是 sessionId）：

```js
private readonly shells = new WeakMap<SessionBinding, SessionInputShell>()
```

```js
shell(id) {
  const binding = this.sessions().binding(id)
  if (binding === undefined) throw new Error(`conversation.input: session "${id}" resolved no binding`)
  return this.shellFor(binding)
}
```

**shell 生命周期 = binding 生命周期（同生同灭）**，靠 Cordis scope effect 管理：

```js
actx.effect(() => {
  ...
  return () => {
    for (const off of offs) off()
    const drafts = shell.dispose()          // ← 卸载：abort 在飞、退订、不写盘
    this.shells.delete(binding)
    const conversation = this.rootCtx.get('conversation')
    for (const attachmentId of drafts) conversation?.releaseDraftAttachment(attachmentId)
  }
}, 'conversation.input: session shell')
```

⚠️ 注意 `dispose()` **不 persist**（见 §3.1.5）。但因为每次内容变化都实时写盘了，磁盘上已是最新 —— **只要插件自己的镜像也实时，崩溃/切会话都不丢。**

#### 3.3.3 A 打字 → 切 B → 切回 A，草稿从哪来

两条路径，取决于 binding 是否被释放：

```js
// src/client/apply.ts  uiSession.provide
ctx.uiSession.provide({
  hooks: ['conversation', 'input'],
  props: ['inputActions'],
  resolve: (binding) => {
    trackBinding(binding)
    const shell = inputHub.shellFor(binding)      // ← 已存在则直接复用（内存）
    const conversation = uiConversation.binding(binding)
    restoreView(binding.sessionId)                // ← 每次 resolve 都重读 view 偏好
    return { hooks: { conversation: conversation.snapshot, input: shell.state },
             props: { inputActions: shell.actions } }
  },
})
```

- **binding 仍存活**（还被人 retain）→ `shellFor` 命中 WeakMap → **从内存 shell 拿**（`shell.state` 里的 draft）。
- **binding 已释放**（切走时 `previous?.release()` 把引用计数清零，`navigation.ts:replaceMain`）→ scope 销毁 → shell `dispose()` 并出 WeakMap → 切回时**重新 `readConversationDraft`**。

**`view` 偏好每次 resolve 都重读**（`restoreView` → `readConversationViewPreference`），这与草稿不同 —— 说明**官方认为 view 是可随时从盘上校正的，draft 不是。**

→ 工程含义：**你的镜像必须覆盖"内存 shell 也丢了"的场景**（binding 释放 + 页面刷新 + 进程退出）。所以镜像写盘要实时（debounce ≤ 300ms），不能靠 unload 钩子。

---

### Q4. 「新建会话」这条路径

#### 3.4.1 新 sessionId 谁生成 —— **Host 生成（或复用），客户端只请求**

```ts
// dsh-api-session-controller/src/client/contract/sessions.ts
/**
 * Create a Session for a new conversation on the Host. The Host reuses the
 * named blank Session while it is reusable and otherwise creates another; ...
 */
create(opts?: { workspaceId?, cwd?, sessionId?, agentPreset? }): Promise<SessionId>
```

```js
// dsh-client-ui-workspace/src/client/navigation.ts  createNamed()
const sessionId = await this.sessions.create(request)     // ← RPC，Host 决定 id
```

→ **客户端不生成 id。** `session-<uuid>` 的 uuid 出自 Host。

#### 3.4.2 ★ 新建会话未必是新 id —— 会**复用空白会话**

```js
// navigation.ts  createInWorkspace()
const blank = sessions.ids.find((id) => {
  const summary = sessions.byId[id]
  const listed = summary?.projectionValues?.agentPreset
  return summary !== undefined && summary.blank && summary.cwd === workspace.path
    && workspace.sessionIds.includes(id) && !archived.includes(id)
    && (options.agentPreset === undefined || typeof listed !== 'string' || listed === options.agentPreset)
})
return this.createNamed({ workspaceId, ...(blank === undefined ? {} : { sessionId: blank }), ... })
```

**这是本任务最大的设计陷阱**：

- 点「新建会话」→ 若工作区里已有**空白**会话 → **复用它的 sessionId**。
- 官方于是 `readConversationDraft(同一个 id)` → **会读出上次的草稿** → 输入框不是空的。
- 而我们的插件若在"新建会话"时无条件把镜像塞回去 → 可能塞回**用户刚发完消息的那个旧草稿**（历史 bug「发送后回灌」的温床）。

→ **纪律：不能以"sessionId 变了"作为新建会话的判据。判据必须是「这个 sessionId 的 shell 是本次首次挂载，且当前 draft 为空，且镜像里的内容不是它刚发出去的那条」。** 建议在镜像里记 `{ text, at, consumedAt }`，发送成功（观察到 draft 从非空→空）时打 `consumedAt`，恢复时跳过 `consumedAt >= at` 的条目。

#### 3.4.3 新会话的键什么时候才存在

`dsh.conversation.<newId>` **不会在会话创建时就出现**。顺序是：

1. `sessions.create()` → Host 返回 id
2. `replaceMain(reference, ..., beforeOpen?)` → `this.selection.set({sessionId})` 写 `dsh.sessions.current`
3. React 渲染 → `conversation.session` 槽挂载 → `conversationStore.create(newId)` → **`EN` 里 `getItem`（读，不写）**
4. 第一次内容变化（打字 / `persistDraft()` / 切视图）→ 才第一次 `setItem`

→ **所以"新会话一定没有这个键"是对的，但"没有键"不等于"没被 init 过"。** 若 store 已 init 而你在步骤 4 之前 `setItem`，仍然会被步骤 4 覆盖。

#### 3.4.4 能不能在"新会话创建事件"里拿到 newId

有，但**不是给插件的事件，是官方内部同步钩子**：

```js
// apply.ts  registerConversationContent 的 inject
selectWorkspace: workspaceId => workspaceNavigation.openWorkspace(workspaceId, (nextId) => { ... })
// navigation.ts  replaceMain
reference = this.sessions.retain(target, { source: 'mainView' })
beforeOpen?.(reference.sessionId)        // ← 同步回调，此时 id 已知
```

这条链是**官方自用**（换工作区搬草稿，BRIEF §3.6），插件复制不到。

**插件可用的三个替代观测点**（按可靠性排序）：

1. **`props.sessionId` 在 session-scope 槽挂载时变化** —— 这是最直接、最可靠的。槽本身就是为"当前会话"挂载的。
2. **`dsh.sessions.current`**（`navigation.ts` 顶部）：

   ```js
   private readonly selection = createSnapshotStore<MainSelection>({}, { persist: { name: 'dsh.sessions.current' } })
   ```

   值形态 `{ sessionId?, subagentAddress? }`。**【实测】LevelDB `000005.ldb` 中确实存在该键。**
   副作用：它也走同一个同步 persist，**你写它同样会被覆盖**，而且会打乱官方导航恢复。→ **只读，别写。**
3. `ctx.get('uiWorkspace')`（`UiWorkspace` 服务，`openSession/startSession/connectWorkspace/forkSession`）。读没问题，但**不要调用** `startSession` —— 那是"新建会话"本身。

**不要**试图监听"新建会话按钮点击"（DOM 事件）：`startSession` 可能被快捷键、hero 区、`beforeOpen` 多条路径触发。

---

### Q5. 拿「当前 sessionId」和「当前工作区路径」

#### 3.5.1 哪些插槽的 props 带 `sessionId`

`sessionId` 由 `PropsRuntime<'槽名'>` 提供（标准 Session props）。实证链三条：

**(a) 官方自己的 session 槽组件在解构它**

```tsx
// src/client/skeleton/ConversationSession.tsx
export function ConversationSessionHeader({
  sessionId, hideChrome, useSessions, useConversationViews, useStore,
  renderSlot, renderFactorySlot, open, useContextMenu, selectView, setPinned, t, useEntryPins, useEntryActions,
}: ConversationSessionHeaderProps) { ... }
```

`ConversationSessionHeaderProps` 里 `PropsRuntime<'conversation.session.header'>` 是唯一可能提供 `sessionId` 的来源（`ConversationSessionHeaderInjected` 与 `PropsStore` 都不含它）。

**(b) 官方 factory 的 inject 签名直接收 sessionId**

```js
// apply.ts  registerConversationSession
store: conversationStore,
inject: (sessionId: SessionId, actions: BoundActions<typeof conversationStore>) => ({ ... })

// registerConversationContent（conversation.content，scope: session-maybe）
inject: (sessionId: SessionId | undefined) => ({ ... })
```

**(c) 第三方插件的实测注释**

```js
// C:\Users\84901\.dsh\profiles\desktop\node_modules\dsh-file-mentions\lib\client.js:726
// 0.1.2 起 props 无 sessionId（turnTail 只传 turn/seq/openFile）；会话 ID
// 从标准源 props.sessionId 或 useSession 获取，都没有时置空由宿主兜底
const sessionId = props.sessionId || (props.turn && props.turn.sessionId) || ''
```

**结论**：`sessionId` **在 session / session-maybe 作用域的槽 props 里存在**，且可被显式覆盖成 `undefined`（`session-maybe` 无会话时）。**取值必须做 `typeof props.sessionId === 'string'` 校验。**

作用域对照（`apply.ts` 权威表）：

| 槽 | kind | scope | props 有 sessionId |
|---|---|---|---|
| `conversation.session` | single | **session** | ✅ 必有 |
| `conversation.view` | list | **session** | ✅ |
| `conversation.input.dock` | list | **session** | ✅ 必有 ← **本插件首选挂载点** |
| `conversation.composer.dock` | list | **session** | ✅ 必有 |
| `conversation.input.left/right/overlay/permission/model/plan/activity` | list/single | **session** | ✅ |
| `conversation.composer` | chain | **session** | ✅（`ComposerChainProps.sessionId: SessionId \| undefined`） |
| `conversation.session.header.actions/utilities/corner/lineage` | list/single | **session** | ✅ |
| `conversation.composer.bar` | single | **session-maybe** | ⚠️ 可能 `undefined` |
| `conversation.header` | single | **session-maybe** | ⚠️ 可能 `undefined` |
| `conversation.hero.*` | 混合 | root / session / session-maybe | ⚠️ 混合 |
| `settings.section` / `plugins.row.config` | — | root | ❌ |

#### 3.5.2 拿工作区 cwd —— **`sessions.list.byId[sessionId].cwd`**（队长猜对了）

```js
// apply.ts  addFiles 里（官方自己的用法）
const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd
```

类型：

```ts
// dsh-api-session-controller/src/client/contract/sessions.ts
cwd?: string          // SessionSummary.cwd，可选
```

插件侧写法（`useSessions` 是标准 hook prop）：

```js
const cwd = useSessions(s => (sessionId ? s.byId[sessionId]?.cwd : undefined))
```

注意：
- `cwd` **可能 undefined**（未落工作区的会话）。
- 工作区切换后，同一 sessionId 的 `cwd` 会变（`navigation.ts` 的 blank 复用判据就是 `summary.cwd === workspace.path`）。
- **BRIEF §6C 要求"同一会话换工作区，草稿跟随会话不跟随工作区"→ 所以 cwd 只用于「工作区 A 打 AAA / B 打 BBB 互不污染」的副作用能力（BRIEF §5.4），不能作为草稿的主键。** 主键永远是 sessionId。

#### 3.5.3 `useSession` / `useProjection` 在插件里能用吗 —— **能，作为 props**

```ts
// dsh-client-ui-session/src/client/index.ts
import { standardHookPropName } from '@deepseek-ai/dsh-client-ui-slots'
export type UseSession = SessionSnapshotSelector
export type UseSessions = SnapshotSelectorHook<SessionListState>
```

`standardHookPropName` 把标准源映射成 `props.use<Name>`（`useSession` / `useSessions` / `useProjection` / `useContextMenu` …），由 `ctx.uiSession.provide({ hooks, props })` 声明。

```js
// apply.ts
ctx.uiSession.provide({
  hooks: ['conversation', 'input'],
  props: ['inputActions'],
  resolve: (binding) => ({ hooks: { conversation: ..., input: shell.state },
                           props: { inputActions: shell.actions } }),
})
```

→ **本插件要用的三件套都在 props 上，不需要 `slots.register` 声明 inject，也不需要 `ctx.get()`：**

| prop | 类型 | 用途 |
|---|---|---|
| `props.sessionId` | `SessionId \| undefined` | 当前会话 |
| `props.inputActions` | `InputActions` | **`setDraft(text)` / `persistDraft()`** ← L1 写入通道 |
| `props.useInput(sel)` | `SnapshotSelectorHook<InputState>` | `draft` / `phase` / `draftRev` 观测 |
| `props.useConversation(sel)` | 同上 | 会话生命周期（`blank` 等） |
| `props.useSession(sel)` | `SessionSnapshotSelector` | 会话状态 |
| `props.useSessions(sel)` | `SnapshotSelectorHook<SessionListState>` | **拿 cwd** |

`InputActions` 完整面（`contract/input.ts:264+`，都是 session 槽组件可直接调的）：

```ts
insertQuote(text, summary?): boolean
captureInsertion(): TokenSpan
insertText(text, span): boolean
setDraft(text: string): void      // ★
persistDraft(): void              // ★
addAttachments(ids): boolean
removeAttachment(id): void
pruneAttachments(ids): void
submit(): void
```

#### 3.5.4 `ctx.get('conversation').input.shell(sessionId)` —— 存在，但**不在类型契约里**

- `ConversationService.input` 的**声明类型**是 `SessionInputResolver`，只有 `for(actx)` 与 `requestDraftInitialization(binding, options)`（`contract/input.ts:228`）。
- **运行时** `input` 就是 `InputHub` 实例（`apply.ts:303` `const inputHub = new InputHub(ctx, t)`，`service.ts:186` `this.input = config.input`），所以 `hub.shell(id)`、`hub.shellFor(binding)`、`.bindDraftPersistence()` 都在。
- 用途：在**非当前挂载**的会话上预置草稿（L2）。
- 风险：升级可能改名/收口。**必须 `typeof hub?.shell === 'function'` 探测 + try/catch + 失败回落 L3。**

---

### Q6. `view` 字段不能丢

#### 3.6.1 丢 `view` 会怎样 —— 视图偏好被清空，UI 跳回 Chat

三处消费点，都会因缺 `view` 而回落：

```ts
// src/client/stores.ts
export function readConversationViewPreference(sessionId: SessionId): string | null {
  const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
  if (raw === null) return null
  const stored: unknown = JSON.parse(raw)
  if (typeof stored !== 'object' || stored === null || !('view' in stored)) return null   // ★ 缺 view → null
  return typeof stored.view === 'string' ? stored.view : null
}
```

```ts
// src/client/view-selection.ts
export const DEFAULT_VIEW_ID = 'chat'
export function resolveActiveView(tabs, selectedId) {
  const selected = selectedId === null ? undefined : tabs.find(v => v.id === selectedId)
  return selected ?? tabs.find(v => v.id === DEFAULT_VIEW_ID)      // ★ 回落 chat
}
```

`restoreView` 在**每次 binding resolve 时**被调（`apply.ts:326`），所以：

**可见后果（必须是插件验收项）**：
1. 用户之前在「轨迹(trajectory)」视图 → 写一次坏值 → **下一次进该会话被强行拉回「对话(chat)」视图**。
2. store state 里 `view` 变成 `undefined`（replace 全量替换）→ `useStore(s => s.view)` 得 `undefined` 而非 `null` → 同一条回落逻辑。用户切一次 tab 后 `setView` 会补回来，但**偏好已丢**。
3. 若同时丢了 `viewRequest` → 一次性 focus 请求丢失（影响 `openView` 的跳转定位，轻微）。

#### 3.6.2 正确做法 —— **读原值 → 只改 draft → 写回**（是）

```js
// 正确
const parsed = JSON.parse(localStorage.getItem(key) ?? 'null')
const base = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {}
localStorage.setItem(key, JSON.stringify({ ...base, draft: text }))

// 错误（会清掉 view/viewRequest）
localStorage.setItem(key, JSON.stringify({ draft: text }))
```

**【实测】`view` 是活字段**，不是摆设：旧版数据 `{"draft":"","view":"chat","viewRequest":null}`（BRIEF §11 形态 A），当前版 `{"draft":{"references":[],"text":""},"view":null,"viewRequest":null}`（形态 B）。`view` 曾经是 `"chat"` 说明它被真写过。

#### 3.6.3 但更该做的事 —— **根本别碰这个键**

L1 通道（`inputActions`）只调 `setDraft`/`persistDraft`，官方 `setDraft` action 只改 `d.draft`：

```js
// src/client/stores.ts
actions: {
  setDraft: (d, text) => { d.draft = text },     // ★ 只碰 draft
  setView: (d, view) => { d.view = view },
  openView: (d, view, focus) => { d.view = view; d.viewRequest = { view, focus } },
  completeViewRequest: (d) => { d.viewRequest = null },
}
```

→ **`view` / `viewRequest` 物理上不可能被 L1 弄丢。** 这就是把 L1 定为首选通道的第二个理由（第一个是零覆盖风险）。

---

## 4. 不确定项清单（必须实测才能定，别当已知）

| # | 待验证假设 | 为什么不确定 | 怎么验（低成本） |
|---|---|---|---|
| U1 | **store scope key 就是 sessionId**（即 `conversationStore.create(sessionId)`） | `create(t)` 的调用点在 slots 运行时的 React 渲染层，该层未随 asar 暴露为可读源码（`index-Ciz7DZxv.js` 里只有 registry 类，无 `renderSlot`/`useStore` 字符串） | 旁证已足（LevelDB 键名 = `dsh.conversation.session-<uuid>`）。要闭环：新建会话 → 打一个字 → 读 `localStorage` 键名。 |
| U2 | **未知字段能否活过 rehydrate 后的一轮 setState** | 源码显示 `setState(parsed, true)` 全量替换 + immer produce 保留 base 字段，推断"能活"；但无契约、无测试 | **不要依赖它**。若非要验：先 `removeItem` 目标键 → `setItem({draft:'x', probe:1})` → 打开该会话 → 打字 → 看 `probe` 是否还在。 |
| U3 | **切走后 binding 是否一定释放** | 取决于引用计数（`retainInfo(id).referenceCount`）。`uiWorkspace` 释放 mainView 引用，但 `uiConversation`/其他 retain 可能仍在 | 切 A→B→A，在 A 的槽里打日志看 `useEffect` mount 次数：mount 两次 = binding 被释放；一次 = 复用。 |
| U4 | **`props.sessionId` 在 `conversation.input.dock` 上确实非空** | 有强旁证（同 scope 的官方组件解构它、`dsh-file-mentions` 注释），但本槽未逐一实测 | 在 dock 组件里 `useEffect(() => console.log('dk props', Object.keys(props), props.sessionId), [])`，看一眼 Console 即可。 |
| U5 | **`inputActions` 在插件注册的槽里真的注入** | `ctx.uiSession.provide({props:['inputActions']})` 是标准源，理论上对所有 session 槽生效 | 同 U4，一次日志确认 `typeof props.inputActions?.setDraft === 'function'`。 |
| U6 | **`persistDraft()` 在 bind 之前是否空转** | `persistCurrentDraft()` 是 `this.persistDraft?.(...)`，未绑定即 no-op | 在 shell 创建但 `DefaultConversationViews` 未挂载的极短窗口里 `setDraft` + `persistDraft`，看键是否出现。**若空转 → 加 200ms 重试一次。** |
| U7 | **官方 `commit-draft` 之后 `draftRev` 具体前进几次** | 取决于 Lexical update 粒度；不影响设计（我们按 `draft === ''` 判定），只影响测试断言写法 | 发送一条消息，打 `useInput(s => [s.draft, s.draftRev, s.phase])` 的时间序列。 |
| U8 | **旧版裸 `<uuid>` 键是否需要迁移** | 【实测】LevelDB 里两种都存在，但裸 uuid 的会话在当前 `sessions.list` 里是否还能打开，未知 | 用裸 uuid 直接 `openSession` 一次；打不开就是死键，只在"清理入口"里列出，不做迁移。 |
| U9 | **`dsh.sessions.current` 是否可作为"当前会话"的观测源** | 官方 `createSnapshotStore(..., {persist:{name}})` 写的，`【实测】`键存在；但其变更时机与 React 渲染顺序的对应关系未验 | 只在 L1/L2 都失效时用作最后兜底，**且只读**。 |
| U10 | **多窗口同会话并写的胜负** | 每个窗口一个 store 实例、各自同步写同一个键 → 后写覆盖先写（无 CAS、无 storage 事件处理） | BRIEF §6C 要求"多窗口不能被覆盖成空"：**用镜像做仲裁**（取 `at` 更新的非空值），不要指望官方键。 |

---

## 5. 一页速查：写代码时盯住这 7 条

1. 挂 `conversation.input.dock`（scope session，props 必有 `sessionId` + `inputActions` + `useInput`）。
2. 观测 `useInput(s => s.draft / s.phase / s.draftRev)`，`frozen(phase)` 时**只读**。
3. 恢复用 `inputActions.setDraft(text)` **然后** `inputActions.persistDraft()`（immer 无变化不通知，必须显式）。
4. 恢复闸门三连：`未恢复过该 sid` ∧ `phase ∈ {plain, claimed}` ∧ `当前 draft === ''`。缺一不写。
5. 镜像只写 `dsh.draft-keeper.v1.*`，实时（debounce 300ms），容量/淘汰/孤儿清理全在镜像侧。
6. 官方键只在 L1/L2 全失效时 L3 兜底，且**必须读-改-写**，保住 `view`。
7. 发送成功 = 观察到 `draft` 变空；**不要**在 `submit()` 时就清镜像。

---

*产出：`docs/impl-contract.md` · 侦查员 scout · 证据脚本与切片见 `docs/_tmp-*.py|js|ts|txt`*
