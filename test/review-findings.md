# 独立复核结论（验证员 · verifier）

> 立场：**只认跑出来的结果，不认"我实现了"的口头声称。**
> 复核对象：`lib/client.js`（工程师在并行改动，本文件对应 **40315 字节 / 963 行 / md5 `42a18e028041814ecd4c956c6e1dc820`**，2026-11-15 01:53）。
> 行号会随工程师的改动漂移 —— 复跑命令在文末，永远以复跑结果为准。
>
> 复核方法不是读代码猜，而是三条并行证据：
> 1. `node test/acceptance.mjs` —— 17 项行为验收（假宿主，真跑）
> 2. `node test/review.mjs` —— 静态契约机械核对
> 3. 人工读实现，只在 1/2 报红的地方定位根因

---

## 0. 一句话结论

**14 / 17 通过。核心功能（跨会话、崩溃恢复、发送后不回灌主路径、容量与配额、首次安装不吃草稿、L3 保住 view）都是真过的 —— 有行为证据，不是自述。**
3 条红，其中 **1 条 P0（可能崩输入框子树）+ 2 条 P1**，都不是设计方向的问题，是两个小判据 + 一个时序标记缺失。

机械检查那边 **P0 0 / P1 0**：体积 39.4KB（< 40KB 上限，勉强）、零网络、除 react 零依赖、两阶段注册在、冻结态字面量齐、L1 + persistDraft 在、L3 读-改-写保住 view、没有任何"拿 sessionId 变了当新建判据"的痕迹（§Q4 的坑**没踩**）。

---

## 1. P0

### P0-1 · `useEffect` 里 `sessionIds.split()` 会抛，可能崩掉输入框子树

**位置**：`lib/client.js:663-664`（孤儿清理那个 effect）

```js
if (!config.enabled || sessionIds === "") return undefined;
const ids = sessionIds.split("\u0000");
```

**为什么是问题**：
`sessionIds` 来自 `useStableHook(props.useSessions, selIds)`（`:519`）。宿主没提供 `useSessions`
时它返回 `undefined` —— 而 `undefined === ""` 是 `false`，所以这条守卫**拦不住**，
下一行直接 `undefined.split` → `TypeError`。

这个 throw 发生在 `useEffect` 里，而组件挂在 `conversation.input.dock`（**输入框子树内部**）。
React 的 effect 异常会往上抛到最近的 error boundary；这里没有 boundary 兜，
后果就是用户看到输入框消失 —— 正是 BRIEF §6E 点名不许发生的事（"任何宿主 API 缺失 → 降级 + 一条 debug 日志，绝不抛异常到 Console"）。

触发条件不是"宿主永远不给"（impl-contract §3.5.3 说 session 槽会提供），而是**版本漂移**：
宿主某次把 `useSessions` 改名/收口，这个插件就从一个"功能失效"变成"输入框崩"。
而这正是本插件宣称"不影响官方输入框"的底线场景。

**证据**（`test/acceptance.mjs` A15，模拟 props 全缺）：

```
A15  宿主 API 缺失 → 降级不抛（BRIEF §6E）   FAIL
     ↳ 宿主 API 缺失时抛了 1 个异常：Cannot read properties of undefined (reading 'split')
```

**建议怎么改**（一行，且与已有的 `useStableHook` 风格一致）：

```js
if (!config.enabled || typeof sessionIds !== "string" || sessionIds === "") return undefined;
```

顺带自查同类：凡是 `useStableHook` 的返回值被直接当字符串/数组用的地方。
本文件里 `draft / phase / rev / cwd` 都做了 `typeof` 判断（`:554/:558/:582`），
只有 `sessionIds` 漏了 —— 属于一处遗漏，不是系统性毛病。

---

## 2. P1

### P1-1 · `compositionend` 里同步读 `latestRef` → 把半截拼音写进镜像和历史

**位置**：`lib/client.js:628-632`（输入法保护 effect 的 `onEnd`），配合 `:535-551` 的 `flushLatest()`

```js
const onEnd = () => {
  if (composing.depth > 0) composing.depth -= 1;
  immediateRef.current = true;
  flushLatest();          // ← 同步读 latestRef.current
};
```

**为什么是问题**：
`latestRef.current` 是**渲染时**的快照（`:531` 起的 ref，渲染时赋值）。`compositionend` 触发的那一刻，
宿主还没把上屏结果写进 React state，所以 `latestRef` 里是**上一拍**的值 —— 也就是拼音中间态。

实测写盘流水（喂 `n → ni → nih → compositionend → 你好`）：

```
dsh.draft-keeper.v1.drafts.P    {"text":"nih", ...}      ← 半截拼音
dsh.draft-keeper.v1.history.P   [{"text":"nih"}, ...]    ← 还进了历史槽位
dsh.draft-keeper.v1.drafts.P    {"text":"你好", ...}      ← 紧接着被正确值覆盖
dsh.draft-keeper.v1.history.P   [{"text":"你好"},{"text":"nih"}]   ← 历史里永久留着 "nih"
```

两个后果：
1. **历史槽位里永久留着半截拼音**（设置页会列出 `nih`），`maxHistory=10` 的槽位被无效内容占掉；
2. 这两次写盘之间有个窗口，如果这中间崩了/被杀，恢复出来的就是 `nih` —— 正是 BRIEF §6A
   「不能是半截乱序拼音」要防的东西。

> 注：本项的判据是"compositionend 之后**不许**出现半截拼音的写盘"。正确实现在 compositionend 后
> 延后一拍（`setTimeout(…, 0)` 或依赖下一次 draft 变化的 `immediateRef` 路径）再落盘，
> 那时 `latestRef` 已是最新值。

**证据**（A5）：

```
A5  拼音输入（composition 期间不落盘 / end 后补存）   FAIL
     ↳ 落盘里出现了半截拼音
```

顺带确认**好消息**：composition **期间**确实一次都没落盘（`composition 期间 set=0`），
`decideMirror` 的 `composing` 闸门是真的生效了 —— 只有 `onEnd` 这半拍没处理对。

**建议怎么改**（两种，任选）：

```js
// 方案 1（最小改动）：compositionend 只标记、不落盘，让下面那一帧的 effect 用 delay=0 去写
const onEnd = () => {
  if (composing.depth > 0) composing.depth -= 1;
  immediateRef.current = true;   // 下一次 draft 变化跳过 debounce
  // 删掉 flushLatest()
};
```

```js
// 方案 2（保留"立刻保存"语义）：延后一拍再读
const onEnd = () => {
  if (composing.depth > 0) composing.depth -= 1;
  immediateRef.current = true;
  setTimeout(flushLatest, 0);   // 下一拍：latestRef 已经是上屏后的值
};
```

方案 1 更稳（少一个定时器），代价是落盘晚 0ms（effect 在 microtask 里就跑）。
**注意 `flushLatest()` 在卸载补写（`:646-652`）里也用到，那条路径不能删** —— 卸载时没有"下一帧"，必须同步写。

---

### P1-2 · 没有"发送在飞"标记 → 「发送成功 + 立刻切走/崩溃」这种时序下会把刚发出去的话塞回输入框

**位置**：`lib/client.js:552, 566`（`markConsumed` 只在**观察到 draft 变空**时才调）

**为什么是问题**：
现在的消费标记只有一条路径：`decideMirror` 返回 `consume`（draft 从非空变空）→ `markConsumed`。
如果发送成功与切走/崩溃撞在同一拍，**组件根本没机会渲染那一帧空草稿**，
`markConsumed` 永远不会执行 —— 镜像里就留着刚发出去的内容，`consumedAt` 还是 0。
下次挂进这个会话（`draft === ""`、`restored` 未置位、`consumedAt >= at` 不成立）→ 恢复 → **回灌**。

这就是 BRIEF §4 表里第一行那个"实测出现过 `ZZTEST2 … ZZTEST3 …` 连成一行"的历史 bug，
只是触发窗口变窄了。

**证据**（A2b，两个子场景都是真跑）：

```
A2b  「没看到 draft 变空」的时序边角（切走 / 崩溃正好撞上发送成功）   FAIL
     ↳ 切走场景回灌 1 次；崩溃重启场景回灌 1 次
```

- 切走场景：`phase→sending`（这一帧渲染了）→ 官方清空草稿 → **卸载发生在重渲染之前**
- 崩溃场景：`phase→sending`（渲染了）→ 官方清空草稿 → **进程没了，排队中的 effect 不会执行**

两次都是 `L1.setDraft("ZZTEST 发出去立刻切走")` —— 也就是真的把发出去的话塞回了输入框。

**为什么要现在就修，而不是"概率低先放着"**：
这是本项目唯一被用户点名过的历史 P0（"发送后回灌"，BRIEF §4 第一条）。
`markConsumed` 依赖"观察到空"这个前提本身是脆的：任何让组件错过那一帧的原因（切走、崩溃、
宿主批量更新把卸载和清空并到一个渲染里）都会重新打开这个洞。
**把判据从"我看到它空了"换成"我知道它被发出去了"**，洞就没了。

**建议怎么改**（在飞的时候就打标记，失败路径自动复位）：

```js
// 1) 新增：进入冻结态且草稿非空 → 直接把镜像标成已消费
function markInFlight(env, sid, now) {
  const store = pick(env);
  if (!store) return false;
  const record = readDraft(store, sid);
  if (record === null || isBlank(record.text) || record.consumedAt > 0) return false;
  // 注意 consumedAt 用 record.at（不是 now）：判据是 consumedAt >= at
  return writeJSON(store, KEY.draft(sid), {
    text: record.text, at: record.at, cwd: record.cwd,
    consumedAt: record.at, orphanAt: record.orphanAt,
  }).ok;
}

// 2) 镜像 effect 里，冻结态分支改成"打标记 + 不落盘"
if (isFrozen(phase)) {
  if (typeof draft === "string" && !isBlank(draft)) markInFlight(undefined, sessionId, Date.now());
  return undefined;
}
```

为什么这样**不会**伤到"发送失败草稿必须还在"（BRIEF §6C）：
发送失败时 `onSinkSettled` 把 phase 退回 `plain`、草稿原封不动 → 下一次镜像 effect 判定为
`write` → `writeDraft` 写新记录时 `consumedAt: 0`（`:315` 那行已经是这么写的）→ 自动复位。
同理，发送成功后用户继续打字也是 `writeDraft` → 复位。**冷路径的这条链已经是对的，只是缺"在飞"那一拍。**

---

## 3. 已核对通过的关键项（附证据，防止"没写就等于没验"）

| 契约要求 | 结论 | 证据 |
|---|---|---|
| 恢复走 L1（`setDraft` + `persistDraft`），不裸写官方键 | ✅ | A1「恢复通道=L1.setDraft」；A14「L1 不可用时才走 L3」 |
| 没有拿"sessionId 变了"当新建判据（§Q4 的坑） | ✅ 没踩 | 静态检查 Q4 无命中；`decideRestore`（`:446` 起）判据是 `draft === "" ∧ !restored ∧ !consumed` |
| 冻结态（adjudicating/submitting/sending）禁止写入 | ✅ | `FROZEN_PHASES` 三值齐（`:419`）；A2/A2b 的 sending 期间无镜像写 |
| 条件调用 hook（历史 P0） | ✅ 无 | A17「跨 17 个场景、271 次渲染无违规」；`useStableHook` 用 `useRef` 首帧锁死，hook 数量恒定 |
| L3 兜底写官方键时保住 `view` / `viewRequest` | ✅ | A14「写后 view=trajectory / viewRequest 保住」；`writeOfficialDraftRaw`（`:393`）确实 `JSON.parse` 原值 + `Object.assign` 只替换 draft |
| 宿主 API 调用都有 try/catch | ⚠️ 除 P0-1 那一处 | `test/review.mjs` 的 TRY 检查 0 命中；P0-1 是"非 API 调用"（`split` on undefined），静态扫不到，靠 A15 抓到 |
| 单文件 ≤ 40KB | ✅ 39.4KB | `test/review.mjs` 算的 39.4KB（40960 上限）—— **余量只剩 600 字节，后续加注释要盯着** |
| 空/纯空白不写入 | ✅ | A9「plugin 键 0 个 / 0 字节」 |
| `\n` / `\u0000` / 零宽 / emoji 逐字节往返 | ✅ | A8「86 字节 UTF-8 完全一致」 |
| QuotaExceeded → 淘汰最旧 → 重试一次 | ✅ | A10「基线 120600B → 预算 125600B → 淘汰后 120600B；Q1 被淘汰、Q4 写入成功」 |
| 配额始终失败 → 静默放弃不抛 | ✅ | A11「异常 0；console.error 0 条；失败后仍可继续输入」 |
| 256KB 上限淘汰最旧（且不把该留的也清了） | ✅ | A12「242091B ≤ 262144B；最近 3 条都在；K0 已淘汰」 |
| 首次安装不覆盖用户已有草稿 | ✅ | A13「setDraft 调用 0 次；官方键原样保留」 |
| 3 万字 debounce ≥300ms / 单次写入 <5ms | ✅ 但余量小 | A7「debounce=300ms；单次写入 **2.38–3.92ms**（多次复跑波动）」—— 离 5ms 上限不远，属于要盯的指标 |
| 纯本地零网络 / 除 react 零依赖 | ✅ | `test/review.mjs` NET / DEPS 均无命中 |
| 两阶段注册（`inject` 包 `register`） | ✅ | A16「已注册：conversation.input.dock, settings.section」 |

---

## 4. 我判不了、也不该我判的（交队长）

1. **任务书 A4 的措辞与契约文档冲突**：队长的任务书写「同一 sessionId 不同 cwd → 断言互不污染」，
   而 BRIEF §6C / impl-contract §3.5.2 明确要求「同一会话换工作区，草稿跟随**会话**不跟随工作区」。
   **两者相反。** 验收表按契约文档判（当前实现也是"跟随会话"→ PASS），并在该行打印了注记。
   如果队长的本意是按 cwd 分命名空间，那要改的是 BRIEF §6C 和实现，不是这一行断言。
2. **P1-2 要不要升 P0**：触发窗口窄（发送成功与卸载/崩溃同一拍），但只要命中就是历史 bug 原形。
   我按"不丢数据 → P1"给，队长若认为"回灌 = 最高优先级"可直接按 P0 排。
3. **单次写入 2.4–3.9ms（多次复跑有波动）**：离 5ms 上限不远。真实宿主上 30000 字还要叠上 Lexical + 官方 persist 的开销，
   这条必须等真宿主 `--watch` 实测（`scripts/verify-host.md` 5.2）。

---

## 5. 复跑命令（改完代码请按顺序跑，全绿再交）

```bash
cd D:\DeepSeek\dsh-draft-keeper

node test/selftest.mjs      # 先确认测具本身没坏：好实现 17/17 绿、坏实现必红 14 条
node test/acceptance.mjs    # 产品 17 项（exit 非 0 = 有 FAIL）
node test/review.mjs        # 静态契约（exit 非 0 = 有 P0）
```

`test/fixtures/good-client.js` 是**标定件**（按契约写对的参照实现），不是产品代码；
它跑 17/17 全绿这件事本身，就是"这张表不会把正确实现判成错"的证据。
`test/fixtures/bad-client.js` 是故意写错的对照，14 条必红 —— 那是"这张表真的抓得住 bug"的证据。
