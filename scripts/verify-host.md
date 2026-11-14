# 真宿主验收手册（#6 / #8 / #9 + U4 / U5）

> 面向**人**执行。机器能跑的部分在 `node test/acceptance.mjs`（17 项，不需要宿主）；
> 这份文件只管那些**只有真宿主能回答**的问题。
>
> 本文件所有路径与命令都在本机核实过（2026-11-15），来源标注在括号里。

---

## 0. 铁律（违反一次，用户当前会话就没了）

> **绝对不许 kill / 重启任何 `DeepSeek Harness` 进程。**
> 用户正在用（GUI `http://127.0.0.1:5557`，`netstat` 实测 `127.0.0.1:5557 LISTENING pid 38632`）。
> 桌面端是多进程（当前 6 个），杀一个主进程会连带把用户没保存的对话打断。

**重启时机 = 队长（lead）跟用户约，不是验证员自己开。** 验证员只准备脚本、只跑只读探针。

必须先确认"可以重启"再动第 3 步之后的任何操作。第 1、2 步是只读的，随时可跑。

---

## 1. 先判断现在能不能验（只读，10 秒）

```bash
cd D:\DeepSeek\dsh-draft-keeper
node scripts/host-probe.mjs
```

三种结果：

| 退出码 | 含义 | 下一步 |
|---|---|---|
| `3` | 没有任何 CDP 端口（**当前就是这个状态**：试过 9333/9222 都不通） | 要验真宿主 → 走第 3 步（需要重启，先找队长要窗口） |
| `0` | 全部 PASS | 记下输出，补第 6/7 步的手工观察 |
| `1` | 有 FAIL | 看 `↳` 行定位 |

配置文件 `C:\Users\84901\AppData\Roaming\@deepseek-ai\dsh-desktop\DevToolsActivePort` 里记着 `9333`，
但那是**上一次**带调试端口启动留下的；现在没进程在听 —— 所以"文件里有端口"≠"端口可用"，
探针会真的去连一次再下结论。

---

## 2. 装插件到 desktop profile（三条路，按现状选）

### 2.1 本机现状

| 事实 | 值 | 来源 |
|---|---|---|
| `dsh` CLI 在不在 PATH | **不在**（`C:\Users\84901\AppData\Roaming\npm\` 下没有 `dsh.cmd`） | 实测 `which dsh` 失败 |
| CLI 本体在哪 | `C:\Users\84901\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`（v0.2.1-rc.5） | 读 package.json 的 `bin.dsh` |
| CLI 版本 vs 宿主版本 | 都是 `0.2.1-rc.5` | 宿主 crash log 头部 `app: @deepseek-ai/dsh-desktop 0.2.1-rc.5` |
| profile 目录 | `C:\Users\84901\.dsh\profiles\desktop`（pnpm workspace） | 目录内容 |
| 现在装了吗 | **没装**（`node_modules\dsh-composer-draft-keeper` 不存在，`dsh.profile.bundles` 里没有） | 实测 |

所以本机跑 CLI 要写全路径：

```bash
node "C:\Users\84901\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" --version
# 0.2.1-rc.5
```

### 2.2 方式 A：CLI（发布之后的正规路）

```bash
# 桌面端硬约束（宿主源码里的原始报错）：
#   Open DeepSeek Harness Desktop once to initialize its profile,
#   then fully quit it before running dsh plugin --profile desktop.
# → 必须先启动过一次应用、然后**完全退出**，才能对 desktop profile 动手
dsh plugin --profile desktop add github:wangkohan/dsh-composer-draft-keeper
# 本机等价写法：
node "C:\Users\84901\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" ^
     plugin --profile desktop add <spec>
```

`<spec>` 接受：`github:owner/repo`、`github:owner/repo#<40位sha>`、`https://github.com/owner/repo`、
npm 名（`@scope/name@1.2.3`）、`x.tgz`。**别用 `#main`** —— 它不构成"钉住"。

### 2.3 方式 B：还没发布，从本地目录挂（调试期最常用）

**必须在应用完全退出时做**（宿主运行时会回写 `package.json` 与 `cordis.patch.yml`，抢写会坏配置）。

```bash
cd C:\Users\84901\.dsh\profiles\desktop

# ① 依赖：把本地目录链进 profile（pnpm 的 link: 协议）
npx pnpm add "link:D:\DeepSeek\dsh-draft-keeper"

# ② bundles：package.json 的 dsh.profile.bundles 数组末尾加一项
#    "dsh-composer-draft-keeper"
#    ★ 少这一步的典型症状：包装上了、Console 里也没有报错，但插件就是不生效
#    （宿主只装载 dsh.profile.bundles 里列的包）

# ③ 起来之后核对：
#    C:\Users\84901\.dsh\profiles\desktop\node_modules\dsh-composer-draft-keeper
#    必须指向 D:\DeepSeek\dsh-draft-keeper（symlink），且里面有 package.json / lib/client.js
```

### 2.4 方式 C：市场 GUI

市场（`dshmarket`）里点安装。**桌面端同样要求先退出应用**；市场那条"装完提示重启"其实就是这件事。

---

## 3. 带 CDP 启动（唯一需要重启的一步）

```powershell
# 复用它，别自己写 Start-Process
powershell -ExecutionPolicy Bypass -File D:\agent-shared\skills\debug-dsh-plugin\scripts\win\dsh_launch_cdp.ps1 -Port 9333
```

为什么必须用这个脚本（三个已踩实的坑，脚本注释里也写了）：

1. 用 `Win32_Process.Create` 而不是 `Start-Process`：从 AI 会话/终端 `Start-Process` 出来的子进程
   会随调用方被回收，命令一结束 DSH 就死。WMI 创建的进程父级是 `WmiPrvSE`，能活。
2. WMI 进程不继承调用方环境变量 → 顺带绕开 `ELECTRON_RUN_AS_NODE=1`
   （带着它启动 exe，会当 node 跑，静默退出、无窗口无日志）。
3. 只在 GPU 连续崩（`0xC0000005` / `DawnGraphiteCache` 被占用）时才加 `-FallbackFlags`。

就绪判据：脚本会打印 `CDP ready on port 9333 after Ns`。

**两个网络坑**：

- 本机系统代理会把 `127.0.0.1` 也劫成 502 → 读 CDP 的 HTTP 端点要 `curl --noproxy '*'`
  （脚本内部用的是 `HttpClientHandler.UseProxy = $false`）。实测 `curl` 直连 5557 返回 `401`
  （要 token），所以**别用裸 curl 判活**，用 CDP。
- 沙箱内 bash 连不上本机端口时，命令要带 `dangerouslyDisableSandbox`。

---

## 4. 改完 `lib/client.js` 必须重启宿主

宿主启动时按文件内容给客户端模块生成**带哈希的地址**；文件一改，旧地址 404，页面表现为
`<plugin>: import failed` + 一堆 404 + 卡在「Loading plugins…」，**热重载 / `Page.reload` 都接不上**。

→ 也就是说：**改一次代码 = 一次重启**。别指望刷新。所以调试期要尽量把改动合并批次。

---

## 5. 每一步该看到什么（PASS 判据）

### 5.1 客户端半是否真的加载了（U4 / U5 的前置）

在 Console（DevTools → Console，或用 `scripts/host-probe.mjs`）看：

```js
document.getElementById('dsh-dk-css')   // → <style id="dsh-dk-css">…</style>
```

- 有 → `apply()` 跑过了，`slots` 服务拿到了，CSS 注入成功。**PASS**
- `null` → 三种可能，按这个顺序查：
  1. bundle 没解析成功 → 看 5.4 的日志
  2. 装了但 `dsh.profile.bundles` 没加 → 2.3 的第 ② 步
  3. `slots` 服务没拿到 → Console 应该有 `[draft-keeper] 宿主没有 slots 服务…`

### 5.2 U4 / U5：`props.sessionId` 与 `props.inputActions` 到底注入了没有

这两条 **impl-contract §4 明确列为"必须实测"的不确定项**。不需要改代码，用行为反推：

| 要验的 | 操作 | PASS 判据 | 为什么这条就够了 |
|---|---|---|---|
| U4 `props.sessionId` 非空 | 输入框打几个字，等 >300ms | `Object.keys(localStorage).filter(k=>k.startsWith('dsh.draft-keeper.v1.drafts.')).length ≥ 1`，**且键名结尾是当前 sessionId** | 镜像键是 `drafts.<sessionId>` 拼出来的；sessionId 是空字符串时代码直接 `return`，一个键都不会写 |
| U5 `props.inputActions` 注入 | 刷新页面后重进同一个会话（官方输入框应为空） | 输入框里**自动出现**之前那段草稿，且 `dsh.conversation.<sid>` 的 `view` 字段没被清空 | 恢复只能走 `inputActions.setDraft` + `persistDraft`（L1）；L1 不在就只能走 L3 直写官方键 —— 而 L3 会打 `[draft-keeper] L1 不可用，已走 L3 直写官方键` 这条 debug 日志 |

**判据的硬边界**：只要 Console 里出现 `L1 不可用，已走 L3`，就说明 U5 是**否**的
（`props.inputActions` 没注入），这不是插件写错了，是宿主契约跟 impl-contract §3.5.3 不一致 ——
要报给队长，改架构而不是打补丁。

带 `--watch` 跑探针可以把上面两条自动看完：

```bash
node scripts/host-probe.mjs --port 9333 --watch 30
# 这 30 秒里请你自己在输入框正常打字、切一次会话，探针会听 Console 的 error/exception
```

### 5.3 #6 设置页（列表 / 单条删除 / 一键清空）

手工：`设置` → 找到「草稿保留」卡片。

| 检查 | PASS 判据 |
|---|---|
| 卡片存在 | 能看到「启用草稿保留」开关 + `N 条草稿 · 占用 x KB / 上限 256.0 KB · 每会话保留最近 10 条` |
| 列表 | 每条显示 `cwd · 月-日 时:分`，下面是草稿前 90 字（换行会被压平） |
| 单条删除 | 点「删除」→ 该行消失 → Console 无报错 → 刷新设置页后仍然消失（说明真删了，不是只改了内存） |
| 一键清空 | 点「一键清空」→ 出现二次确认「确认清空全部 N 条草稿镜像？官方键不受影响。」→ 确认后列表空 |
| 历史 | 点「历史」展开，最多 10 条，最新在前 |
| 关闭总开关 | 关掉后打字 → 不再产生新镜像键；**官方输入框照常可用**（这条最容易翻车） |

自动（卡片只要在 DOM 里就能查）：

```bash
node scripts/host-probe.mjs --port 9333        # H4 检查 .dsh-dk-card 数量
```

> 注意：`H4` 只有在**设置页打开着**的时候才是非 0。没打开就是 WARN，不是 FAIL。

### 5.4 #8 `dump-config` 里不能有 `skipping profile bundle` / `Cannot find package`

**先说清楚这条为什么不能随手跑。** `dsh --dump-config` 会调用 `prepareProfile()`，而它内部有
一句 `writeFileSync(profile.dir/cordis.yml, …)`（`@deepseek-ai/dsh/src/profile-boot.ts:198`）——
也就是**它会写 profile 的 cordis.yml**（内容是个常量，但仍然是写）。BRIEF §4 的老坑是"宿主回写配置"，
所以：

> **`--dump-config` 只在应用完全退出后跑。**

```bash
# 应用已退出时
node "C:\Users\84901\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" ^
     --profile desktop --dump-config > D:\DeepSeek\dsh-draft-keeper\test\_dump-config.txt 2>&1

# 判据（三条一起看）
findstr /I /C:"skipping profile bundle" D:\DeepSeek\dsh-draft-keeper\test\_dump-config.txt   # 期望：无输出
findstr /I /C:"Cannot find package"    D:\DeepSeek\dsh-draft-keeper\test\_dump-config.txt   # 期望：无输出
findstr /I /C:"draft-keeper"           D:\DeepSeek\dsh-draft-keeper\test\_dump-config.txt   # 期望：至少 1 行
```

第三条是关键：**没有 `skipping` 还不够，必须能看到自己的 `insert` 行**，
否则说明 `dsh.profile.bundles` 根本没引用到我们的包（dump 里自然也不会出现）。

**不许跑的那个版本**：应用还开着的时候别跑（会跟宿主抢写 `cordis.yml`）。

#### 不跑 CLI 时的等价证据（推荐，零风险）

失败态在宿主日志里长这样（本机 2026-11-11 的真实日志）：

```
--- error ---
Error: dsh desktop host stopped: dsh: skipping profile bundle "@local/draft-keeper": Error: dsh: cannot resolve profile bundle "@local/draft-keeper" from the dsh installation or C:\Users\84901\.dsh\profiles\desktop; run 'dsh plugin --profile desktop install' if its dependency is not installed
```

日志位置：`C:\Users\84901\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\crash-<时间戳>-host.log`
（`source: host`；正常启动的那一次不一定有新文件 —— 这时用渲染端证据代替）。

```bash
# 找最近一次宿主日志里有没有点到我们
findstr /S /I /C:"dsh-composer-draft-keeper" "C:\Users\84901\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\*host.log"
```

**渲染端等价证明**（最可靠，不需要 CLI）：
第 5.1 步 `#dsh-dk-css` 存在 + 设置页有卡片 = bundle 一定解析并 `apply()` 成功了。
bundle 解析失败时这两条都不可能出现 —— 所以它比 dump 更直接。

### 5.5 #9 禁用插件后官方输入框一切正常

**这条必须两次重启**（禁用一次、恢复一次），所以务必跟 #6/#8 排在同一次停机窗口里做完。

| 步骤 | 动作 | PASS 判据 |
|---|---|---|
| 1 | 记下当前状态：`node scripts/host-probe.mjs --port 9333` 的输出存档 | 作为对照基线 |
| 2 | 完全退出宿主 | 任务管理器里 DeepSeek Harness 相关进程清零（别用 taskkill 猜进程名，用任务管理器看） |
| 3 | 禁用插件：从 `dsh.profile.bundles` 里删掉 `dsh-composer-draft-keeper`（**保留** `node_modules` 里的包，方便回滚） | `package.json` 能被 JSON 解析 |
| 4 | 用第 3 节同一脚本启动 | `CDP ready on port 9333` |
| 5 | 在 Console 里跑 | `document.querySelector('div[contenteditable="true"]')` → 存在；`document.getElementById('dsh-dk-css')` → **null**（说明确实没加载） |
| 6 | 手工打一段字 → 发送 → 再打一段 → 切会话 → 切回 | 官方行为跟没装插件时一致；输入框不卡、不丢字、发送正常、Console 无 error |
| 7 | 恢复：把 bundles 那行加回去 → 退出 → 重启 | 第 5.1 步重新 PASS |

> 遗留镜像键的处理：禁用插件后 `dsh.draft-keeper.v1.*` 还留在 localStorage 里（这是设计：
> 卸载即净 = 官方键原样保留、镜像自己清）。清法：先在插件里「一键清空」，或者 Console 里
> `Object.keys(localStorage).filter(k=>k.startsWith('dsh.draft-keeper')).forEach(k=>localStorage.removeItem(k))`。

---

## 6. 九条验收：谁验、在哪验、要不要重启

| # | 验收项 | 在哪验 | 要重启吗 | 现状 |
|---|---|---|---|---|
| 1 | 新建会话打字 → 切走 → 切回文字在 | `test/acceptance.mjs` A1（+ 真宿主手工复核） | 否 | A1 PASS |
| 2 | 发送后不回灌 | `test/acceptance.mjs` A2 / **A2b** | 否 | A2 PASS、**A2b FAIL** |
| 3 | 强杀重启后草稿在 | `test/acceptance.mjs` A3（模拟崩溃）+ 真宿主手工杀进程 | **是**（真杀） | A3 PASS |
| 4 | 工作区 A/B 互不污染 | `test/acceptance.mjs` A4 | 否 | PASS |
| 5 | 拼音输入（不能存半截拼音） | `test/acceptance.mjs` A5（模拟 composition 事件） | 否 | **FAIL** |
| 6 | 设置页列表/删除/清空 | **只有真宿主**（第 5.3 节） | 是 | 待验 |
| 7 | 3 万字不卡、Console 无报错 | `test/acceptance.mjs` A7 + 真宿主 `--watch` | 否 | A7 PASS（单次写入 3.92ms，离 5ms 上限不远） |
| 8 | dump-config 干净 | 第 5.4 节 | **是**（dump 要在停机窗口跑） | 待验 |
| 9 | 禁用插件后官方正常 | 第 5.5 节 | **是**（两次） | 待验 |

一次停机窗口能干完的最小集合：**装插件 → 重启带 CDP → 5.1/5.2/5.3/5.5(1~2) → 退出 → 5.4 dump → 禁用 → 重启 → 5.5 → 恢复 → 重启**。
也就是 **3 次启动 + 2 次退出**，最后一次停下来就是用户能继续用的状态。

---

## 7. 故障排查表

| 症状 | 最可能的原因 | 怎么办 |
|---|---|---|
| Console 一堆 404 + `<plugin>: import failed` + 卡「Loading plugins…」 | 改了 `lib/client.js` 没重启（带哈希的地址失效） | 重启宿主 |
| 上面这条重启后仍然复现 | `exports` 里没有 `./client`，或 `files` 白名单漏了 `lib` | 核对 `package.json`（本仓库已有 `"./client": "./lib/client.js"`） |
| 插件装上了但完全没反应，Console 干净 | `dsh.profile.bundles` 里没加，或 `name` 与 `package.json.name` 不一致 | 第 2.3 ② 步；`cordis.patch.yml` 的 `name` 必须逐字等于包名 |
| 设置页没有卡片 | 只注册了 dock 槽、`settings.section` 注册失败 | Console 找 `[draft-keeper] settings.section 注册失败` |
| 输入框整块消失 / 报 `RangeError: Invalid array length` | 条件调用 hook（历史 P0） | 看 `test/review.mjs` 的 HOOKS 项；`test/acceptance.mjs` A17 也会红 |
| 草稿能存不能恢复 | `props.inputActions` 没注入（U5 = 否） | Console 找 `L1 不可用，已走 L3`；这是宿主契约问题，报队长 |
| 恢复后视图从「轨迹」跳回「对话」 | 有人绕过了 L1 直接写官方键，且没读-改-写 | `test/acceptance.mjs` A14 会红；`test/review.mjs` 的 L3-VIEW 项 |
| `dsh plugin` 报 `…fully quit it before running dsh plugin --profile desktop` | 应用还开着 | 完全退出（不是最小化）再跑 |
| 探针报 `没有可用的调试端口` | 宿主不是带 `--remote-debugging-port` 启动的 | 第 3 节（需先约重启窗口） |
| `curl 127.0.0.1:9333` 返回 502 | 系统代理劫持了 localhost | 加 `--noproxy '*'` |

---

## 8. 验证员自己不许做的事

- 不 kill / 不重启任何 `DeepSeek Harness` 进程（含 `taskkill`、任务管理器"结束任务"、重启电脑）。
- 不改 `C:\Users\84901\.dsh\profiles\desktop\*`（`package.json` / `cordis.patch.yml` / `node_modules`）——
  第 2、3、5 步是给**执行停机窗口的人**看的操作手册，不是给验证员自己跑的。
- 不在应用运行时跑 `--dump-config`（它会写 `cordis.yml`）。
- 不用 `--type` 往用户正在用的输入框里塞东西（探针默认关闭，开了会先打印警告）。
