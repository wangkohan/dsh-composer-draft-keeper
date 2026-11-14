/**
 * dsh-composer-draft-keeper · 验收测试台（纯 node，不需要宿主、不需要浏览器）
 *
 * 跑法：
 *   node test/acceptance.mjs                                  # 验 lib/client.js（产品）
 *   DK_CLIENT=test/fixtures/good-client.js node test/acceptance.mjs   # 标定测具本身
 *
 * 判据来源：docs/BRIEF.md §6 §7 + docs/impl-contract.md §2 §3。
 * 纪律：断言不许为了让测试变绿而放宽。测不过就报 FAIL —— 那是最有价值的信号。
 *
 * 状态含义：
 *   PASS  断言全部成立
 *   FAIL  有断言不成立（exit code 非 0）
 *   WARN  契约里有、但缺失不直接导致丢数据/崩 UI（例如 L3 兜底未实现）
 *   SKIP  该实现的挂载点/能力形态导致本项无从判定（会写明原因）
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FakeHost } from './harness.mjs'

const ROOT = join(import.meta.dirname, '..')
const TARGET = process.env.DK_CLIENT ? join(ROOT, process.env.DK_CLIENT) : join(ROOT, 'lib', 'client.js')

/* ───────────────────────── 断言与行框架 ───────────────────────── */

const rows = []
const ALL_HOSTS = []
let currentRow = null

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function row(id, title, fn) {
  currentRow = { id, title, status: 'PASS', measured: '', note: '' }
  const t0 = process.hrtime.bigint()
  try {
    const r = await fn()
    if (r && typeof r === 'object') {
      currentRow.status = r.status ?? 'PASS'
      currentRow.measured = r.measured ?? ''
      currentRow.note = r.note ?? ''
    }
  } catch (e) {
    currentRow.status = 'FAIL'
    currentRow.measured = currentRow.measured || '—'
    currentRow.note = e?.message ? String(e.message) : String(e)
  }
  currentRow.ms = Number(process.hrtime.bigint() - t0) / 1e6
  rows.push(currentRow)
  return currentRow
}

const newHost = () => {
  const h = new FakeHost({ code: CODE })
  ALL_HOSTS.push(h)
  return h
}

const advance = (h, ms) => h.clock.advance(ms)
const pluginWrites = (h) => h.writes().filter((w) => !w.key.startsWith('dsh.conversation.') && w.key !== 'dsh.sessions.current')
const allErrors = (h) => [...h.errors, ...h.react.errors, ...h.clock.errors]
const draftCalls = (h) => [...h.calls('L1.setDraft'), ...h.calls('L2.setDraft')]
const bytesOf = (s) => Buffer.byteLength(s, 'utf8')

/* ───────────────────────── 载入被测文件 ───────────────────────── */

if (!existsSync(TARGET)) {
  console.log(`\n✗ 找不到被测文件：${TARGET}`)
  console.log('  （工程师还没写出 lib/client.js。用 DK_CLIENT=test/fixtures/good-client.js 可先标定测具。）\n')
  process.exit(2)
}
const CODE = readFileSync(TARGET, 'utf8')
const SIZE = statSync(TARGET).size
const MTIME = statSync(TARGET).mtime.toISOString()

/* ═══════════════════════════ 验收项 ═══════════════════════════ */

await row('A1', '跨会话保留（会话级镜像 + 不串会话）', async () => {
  const h = newHost()
  h.boot()
  h.openSession('A', '/ws1')
  h.mount('A')
  h.type('A', 'AAA 的未发送草稿')
  await advance(h, 1000)
  assert(h.pluginKeys().length > 0, 'A 打完字后，插件一个键都没写（镜像没落盘）')
  assert(h.hasStored('AAA 的未发送草稿'), `A 的草稿没有出现在任何插件键里；只看到 ${JSON.stringify(h.pluginKeys())}`)

  // 切到 B：B 是另一个会话，不得接到 A 的内容
  h.switchTo('A', 'B')
  h.type('B', 'BBB 的内容')
  await advance(h, 1000)
  const leak = draftCalls(h).filter((c) => c.sessionId === 'B' && String(c.args[0]).includes('AAA'))
  assert(leak.length === 0, `B 接到了 A 的草稿（跨会话污染 ${leak.length} 次）`)

  // 切回 A —— 并且把官方键删掉，逼实现只能用镜像恢复（否则本项是假绿：
  // 官方自己的 readConversationDraft 就能读回来，跟插件无关）
  h.ls.removeItem('dsh.conversation.A')
  h.resetCounters() // 只认"这次挂载之后"发生的恢复，避免把打字阶段的回声当成恢复
  h.mount('A')
  await advance(h, 1000)
  const back = draftCalls(h).filter((c) => c.sessionId === 'A' && String(c.args[0]).includes('AAA'))
  assert(back.length > 0, '切回 A 没有走 L1/L2 恢复（官方键已删，输入框会是空的）')
  assert(String(back[back.length - 1].args[0]) === 'AAA 的未发送草稿', `恢复内容不对：${JSON.stringify(String(back[back.length - 1].args[0]))}`)
  return { measured: `恢复通道=${back[back.length - 1].api}；会话B污染=0；镜像键=${h.pluginKeys().length} 个` }
})

await row('A2', '发送后不回灌（双闸门）', async () => {
  const h = newHost()
  h.boot()
  h.openSession('S', '/ws')
  h.mount('S')
  h.type('S', 'ZZTEST 已经发出去的话')
  await advance(h, 1000)
  assert(h.hasStored('ZZTEST 已经发出去的话'), '发送前草稿没落镜像')

  h.sendSuccess('S') // 官方 commit-draft → 编辑器清空 → persist 空 draft
  await advance(h, 1000)

  // 场景 1：新建会话窗口（官方键还没有）—— 历史 bug 的原形
  h.resetCounters()
  h.unmount('S')
  h.closeSession('S')
  h.ls.removeItem('dsh.conversation.S')
  h.mount('S')
  await advance(h, 1000)
  const backwash1 = draftCalls(h).filter((c) => String(c.args[0]).includes('ZZTEST'))

  // 场景 2：官方键还在（空白会话被复用，sessionId 没变）
  h.resetCounters()
  h.unmount('S')
  h.closeSession('S')
  h.ls.setItem('dsh.conversation.S', JSON.stringify({ draft: { references: [], text: '' }, view: null, viewRequest: null }))
  h.mount('S')
  await advance(h, 1000)
  const backwash2 = draftCalls(h).filter((c) => String(c.args[0]).includes('ZZTEST'))

  // 场景 3：真正的新 sessionId（新建会话 → Host 给新 id）
  h.resetCounters()
  h.closeSession('S')
  h.unmount('S')
  h.openSession('S2', '/ws')
  h.mount('S2')
  await advance(h, 1000)
  const backwash3 = draftCalls(h).filter((c) => String(c.args[0]).includes('ZZTEST'))

  assert(backwash1.length === 0, `发送后回灌（官方键缺失场景）：旧内容被写回输入框 ${backwash1.length} 次`)
  assert(backwash2.length === 0, `发送后回灌（空白会话复用场景）：旧内容被写回 ${backwash2.length} 次`)
  assert(backwash3.length === 0, `发送后回灌（新 sessionId 场景）：旧内容被写进新会话 ${backwash3.length} 次`)
  return { measured: `三种重建场景回灌次数 = 0/0/0` }
})

// 这条单独列：它测的是**时序边角**（发送成功与切走同时发生），
// 跟 A2 的主路径失败不是一回事，混在一起会淹没主信号。
await row('A2b', '「没看到 draft 变空」的时序边角（切走 / 崩溃正好撞上发送成功）', async () => {
  const TEXT = 'ZZTEST 发出去立刻切走'
  // 子场景 1：发送成功与切走同一拍 —— 组件来得及渲染空草稿之前就卸载了
  const h1 = newHost()
  h1.boot()
  h1.openSession('U', '/ws')
  h1.mount('U')
  h1.type('U', TEXT)
  await advance(h1, 1000)
  h1.setPhase('U', 'sending') // 发送中（冻结态）—— 这一帧会让插件渲染一次（真实 React 也如此）
  await advance(h1, 0)
  h1.type('U', '') // 官方清空 —— 这一帧的重渲染被压进 microtask
  h1.unmount('U') // 立刻卸载：effect 没机会观察到 draft === ''
  h1.closeSession('U')
  h1.resetCounters()
  h1.ls.removeItem('dsh.conversation.U')
  h1.mount('U')
  await advance(h1, 1000)
  const back1 = draftCalls(h1).filter((c) => String(c.args[0]).includes(TEXT))

  // 子场景 2：发送成功后立刻崩溃（进程没机会跑完那一帧 effect），重启后重进该会话
  const h2 = newHost()
  h2.boot()
  h2.openSession('W', '/ws')
  h2.mount('W')
  h2.type('W', TEXT)
  await advance(h2, 1000)
  h2.setPhase('W', 'sending')
  await advance(h2, 0) // Enter 之后到 Host 回话之间，插件必然已经渲染过 sending 态
  h2.type('W', '') // Host 接受 → 官方清空草稿
  h2.crash() // 还没跑完清空那一帧的 effect 就崩了（真实进程里排队中的重渲染也不会执行）
  h2.boot()
  h2.resetCounters()
  h2.mount('W')
  await advance(h2, 1000)
  const back2 = draftCalls(h2).filter((c) => String(c.args[0]).includes(TEXT))

  const problems = []
  if (back1.length) problems.push(`切走场景回灌 ${back1.length} 次`)
  if (back2.length) problems.push(`崩溃重启场景回灌 ${back2.length} 次`)
  assert(problems.length === 0, problems.join('；') + '（没观察到 draft 变空就永远不打"已消费"标记 → 镜像留着刚发出去的内容）')
  return { measured: `切走=0 回灌；崩溃重启=0 回灌` }
})

await row('A3', '崩溃恢复（内存全丢，只留 localStorage）', async () => {
  const h = newHost()
  h.boot()
  h.openSession('C', '/ws')
  h.mount('C')
  h.type('C', '崩溃前正在写的内容')
  await advance(h, 1000)

  h.crash() // 模块作用域、shell 内存、sessionStorage 全丢；localStorage 保留
  assert(h.pluginKeys().length > 0, '崩溃后插件键全没了（说明镜像没落在 localStorage）')
  h.boot()
  h.mount('C')
  await advance(h, 1000)
  // 子断言 1：官方键也活着，此时能读回不算插件功劳，但要确认没被弄坏
  const shellDraft1 = h.shellOf('C').state.draft
  assert(shellDraft1 === '崩溃前正在写的内容', `崩溃后官方草稿被破坏：${JSON.stringify(shellDraft1)}`)

  // 子断言 2（真信号）：官方键丢了，只有镜像能救
  h.crash()
  h.ls.removeItem('dsh.conversation.C')
  h.resetCounters()
  h.boot()
  h.mount('C')
  await advance(h, 1000)
  const restored = draftCalls(h).filter((c) => String(c.args[0]).includes('崩溃前正在写的内容'))
  assert(restored.length > 0, '崩溃且官方键缺失时，镜像没能恢复草稿（这一项就是产品的核心卖点）')
  return { measured: `官方键健在时读回=ok；官方键缺失时镜像恢复=${restored[restored.length - 1].api}` }
})

await row('A4', '会话/工作区隔离（BRIEF §6C：草稿跟随会话）', async () => {
  const h = newHost()
  h.boot()
  // (a) 不同 sessionId、相同 cwd → 两份草稿互不污染
  h.openSession('WA', '/ws1')
  h.mount('WA')
  h.type('WA', 'AAA')
  await advance(h, 1000)
  h.switchTo('WA', 'WB')
  h.type('WB', 'BBB')
  await advance(h, 1000)
  assert(h.hasStored('AAA') && h.hasStored('BBB'), 'WA/WB 两份草稿没有同时存在（互相覆盖了）')

  // (b) 同一 sessionId 换 cwd → BRIEF §6C「草稿跟随会话不跟随工作区」
  h.closeSession('WA')
  h.unmount('WB')
  h.closeSession('WB')
  h.ls.removeItem('dsh.conversation.WA')
  h.openSession('WA', '/ws2') // 同会话，新工作区
  h.resetCounters()
  h.mount('WA')
  await advance(h, 1000)
  const kept = draftCalls(h).filter((c) => String(c.args[0]) === 'AAA')
  assert(kept.length > 0, '同一会话换工作区后草稿没了（按 cwd 做命名空间 → 违反 BRIEF §6C）')
  return {
    measured: `(a) 双草稿共存 ok；(b) 换 cwd 后按 session 跟随 ok`,
    note: '任务书里「同一 sessionId 不同 cwd 互不污染」与 BRIEF §6C/impl-contract §3.5.2「草稿跟随会话」相反，本表按契约文档判（见回报）',
  }
})

await row('A5', '拼音输入（composition 期间不落盘 / end 后补存）', async () => {
  const h = newHost()
  h.boot()
  h.openSession('P', '/ws')
  h.mount('P')
  h.resetCounters()

  h.fireComposition('compositionstart')
  h.type('P', 'n')
  await advance(h, 400) // > debounce(300)：无保护的实现此刻就落盘了
  h.type('P', 'ni')
  await advance(h, 400)
  h.type('P', 'nih')
  await advance(h, 400)
  const during = pluginWrites(h).filter((w) => w.type === 'set')
  assert(during.length === 0, `composition 期间落盘 ${during.length} 次：${during.map((w) => JSON.stringify(w.value).slice(0, 60)).join(' , ')}`)

  h.type('P', '你好')
  h.fireComposition('compositionend', '你好')
  await advance(h, 1000)
  const after = pluginWrites(h).filter((w) => w.type === 'set')
  assert(after.length > 0, 'compositionend 之后没有补存（最后一个词的改动会丢）')
  const hit = after.some((w) => String(w.value).includes('你好'))
  assert(hit, `compositionend 后落盘的内容不含「你好」：${after.map((w) => JSON.stringify(w.value).slice(0, 60)).join(' , ')}`)
  const halfcut = after.some((w) => /"(n|ni|nih)"/.test(String(w.value)))
  assert(!halfcut, '落盘里出现了半截拼音')
  return { measured: `composition 期间 set=${during.length}；end 后 set=${after.length}，含「你好」=${hit}；半截拼音=无` }
})

await row('A7', '3 万字不卡（debounce ≥ 300ms，单次写入 < 5ms）', async () => {
  const h = newHost()
  h.boot()
  h.openSession('L', '/ws')
  h.mount('L')
  const unit = '把没发出去的草稿留在输入框里，切走再回来还能接着写。'
  let big = ''
  while (big.length < 30000) big += unit
  big = big.slice(0, 30000)
  assert(big.length === 30000, '构造的 3 万字长度不对')

  h.resetCounters()
  const CHUNK = 300 // 100 次渲染，贴近"用户连续打字"的粒度
  for (let i = CHUNK; i <= big.length; i += CHUNK) {
    h.type('L', big.slice(0, i))
    await h.clock.advance(20, { step: 5 })
  }
  const lastKeyAt = h.clock.now
  const duringBurst = pluginWrites(h).filter((w) => w.type === 'set').length
  assert(duringBurst === 0, `连打过程中落盘了 ${duringBurst} 次（debounce 没生效，30 万字会卡）`)

  const firedBefore = h.clock.fired.length
  await advance(h, 1000)
  const firedAfter = h.clock.fired.slice(firedBefore)
  const firstWrite = pluginWrites(h).filter((w) => w.type === 'set')
  assert(firstWrite.length > 0, '3 万字最终没有落盘')
  // 注意：一次落盘会连写 draft/history/meta 三个键，最后一条不一定是装着正文的那条 ——
  // 所以要断言"有写盘带上了最终草稿的尾巴"，而不是"最后一条写盘带上了"
  const tail = big.slice(-40)
  assert(firstWrite.some((w) => String(w.value).includes(tail)), '落盘内容与最终草稿不一致（尾部丢了）')

  // 单次写入耗时 = debounce 回调那次同步执行的真实毫秒（含 stringify + setItem）
  const maxReal = firedAfter.reduce((m, f) => Math.max(m, f.realMs), 0)
  const delays = firedAfter.map((f) => f.delay) // delay 已经是毫秒
  const debounceMeasured = delays.length ? Math.max(...delays) : 0

  const errs = allErrors(h)
  assert(errs.length === 0, `3 万字过程中抛了 ${errs.length} 个异常：${errs[0]?.message ?? ''}`)
  assert(maxReal < 5, `单次写入耗时 ${maxReal.toFixed(2)}ms ≥ 5ms`)
  assert(debounceMeasured >= 300, `debounce 只有 ${debounceMeasured}ms，要求 ≥ 300ms`)
  return { measured: `30,000 字；连打期落盘=0；debounce=${debounceMeasured}ms；单次写入=${maxReal.toFixed(2)}ms；渲染 ${h.react.renderPasses()} 次` }
})

await row('A8', '数据边界往返（\\n / \\u0000 / 零宽 / emoji 逐字节相等）', async () => {
  const text = '第一行\n第二行\t制表\u0000空字节\u200B零宽😀🧪　全角，标点。“引号”'
  const h = newHost()
  h.boot()
  h.openSession('E', '/ws')
  h.mount('E')
  h.type('E', text)
  await advance(h, 1000)
  h.crash()
  h.ls.removeItem('dsh.conversation.E') // 只留镜像
  h.resetCounters()
  h.boot()
  h.mount('E')
  await advance(h, 1000)
  const calls = draftCalls(h).filter((c) => c.sessionId === 'E')
  assert(calls.length > 0, '往返测试：镜像没恢复')
  const got = String(calls[calls.length - 1].args[0])
  const a = Buffer.from(got, 'utf8')
  const b = Buffer.from(text, 'utf8')
  if (Buffer.compare(a, b) !== 0) {
    const idx = [...text].findIndex((ch, i) => ch !== [...got][i])
    throw new Error(`往返后被改写：首次差异在第 ${idx} 个码点（原 ${JSON.stringify([...text][idx])} → 回 ${JSON.stringify([...got][idx])}）；字节 ${a.length} vs ${b.length}`)
  }
  return { measured: `${b.length} 字节 UTF-8 完全一致` }
})

await row('A9', '空草稿 / 纯空白不写入、不占空间', async () => {
  const h = newHost()
  h.boot()
  h.openSession('Z', '/ws')
  h.mount('Z')
  h.resetCounters()
  h.type('Z', '')
  await advance(h, 1000)
  const blank = '\n\n   \t\t\u3000\u3000  '
  h.type('Z', blank)
  await advance(h, 1000)
  const sets = pluginWrites(h).filter((w) => w.type === 'set')
  assert(sets.length === 0, `空白草稿被写入 ${sets.length} 次：${sets.map((w) => JSON.stringify(w.value).slice(0, 40)).join(' , ')}`)
  const dirty = h.pluginEntries().filter((e) => e.value.includes('\u3000'))
  assert(dirty.length === 0, `空白草稿进了键：${dirty.map((e) => e.key).join(', ')}`)
  return { measured: `plugin 键 ${h.pluginKeys().length} 个 / ${h.pluginBytes()} 字节` }
})

await row('A10', 'QuotaExceededError → 淘汰最旧 → 重试一次', async () => {
  const h = newHost()
  h.boot()
  const bigA = 'A'.repeat(20000)
  const bigB = 'B'.repeat(20000)
  const bigC = 'C'.repeat(20000)
  h.openSession('Q1', '/ws'); h.mount('Q1'); h.type('Q1', bigA); await advance(h, 600)
  h.switchTo('Q1', 'Q2'); h.type('Q2', bigB); await advance(h, 600)
  h.switchTo('Q2', 'Q3'); h.type('Q3', bigC); await advance(h, 600)
  const baseline = h.pluginBytes()
  assert(baseline > 50000, `基线镜像太小（${baseline} 字节），测试前提不成立`)

  // 只对"非官方键"记账：把预算卡在 基线 + 5KB，一条 20KB 的新草稿必然 QuotaExceeded
  h.ls.__policy.filter = (k) => !k.startsWith('dsh.conversation.')
  h.ls.__policy.maxTotal = baseline + 5000
  h.resetCounters()
  h.switchTo('Q3', 'Q4')
  h.type('Q4', 'D'.repeat(20000))
  await advance(h, 1500)

  const errs = allErrors(h)
  assert(errs.length === 0, `配额不足时抛了异常到 Console：${errs[0]?.message ?? ''}`)
  const after = h.pluginBytes()
  assert(after <= h.ls.__policy.maxTotal, `淘汰后仍超预算：${after} > ${h.ls.__policy.maxTotal}`)
  const keptD = h.pluginEntries().some((e) => e.value.includes('DDDD'))
  assert(keptD, '新草稿没写成功（淘汰了最旧却没重试）')
  const keptQ1 = h.pluginEntries().some((e) => e.value.includes('AAAA'))
  assert(!keptQ1, '最旧的 Q1 没被淘汰')
  return { measured: `基线 ${baseline}B → 预算 ${h.ls.__policy.maxTotal}B → 淘汰后 ${after}B；Q1 被淘汰、Q4 写入成功` }
})

await row('A11', '配额始终失败 → 静默放弃（不抛、不影响输入）', async () => {
  const h = newHost()
  h.boot()
  h.openSession('R', '/ws')
  h.mount('R')
  h.ls.__policy.failAll = true
  h.resetCounters()
  h.type('R', '永远写不进去的草稿')
  await advance(h, 1500)
  const errs = allErrors(h)
  assert(errs.length === 0, `写入永远失败时抛了异常：${errs[0]?.message ?? ''}`)
  const consoleErrors = h.console.error.length
  assert(consoleErrors === 0, `向 Console.error 报了 ${consoleErrors} 条（BRIEF §6E 要求不弹错）：${h.console.error[0]}`)
  // 输入不能被阻塞：还能继续打字、还能恢复
  let threw = null
  try {
    h.type('R', '继续打字')
    await advance(h, 600)
  } catch (e) { threw = e }
  assert(!threw, `配额失败后输入被阻塞：${threw?.message}`)
  return { measured: `异常 0；console.error ${consoleErrors} 条；失败后仍可继续输入` }
})

await row('A12', '容量上限 256KB 淘汰最旧', async () => {
  const h = newHost()
  h.boot()
  const chunk = 'X'.repeat(10000)
  const N = 30 // 30 × 10KB ≈ 300KB > 256KB
  for (let i = 0; i < N; i++) {
    const sid = `K${i}`
    h.openSession(sid, '/ws')
    if (i > 0) h.unmount(`K${i - 1}`)
    h.mount(sid)
    h.type(sid, chunk)
    await advance(h, 400)
    if (h.pluginBytes() > 256 * 1024) break
  }
  const total = h.pluginBytes()
  assert(total <= 256 * 1024, `镜像总量 ${total} 字节 > 256KB（没淘汰）`)
  // 容量上限不能靠"只留一条"来实现：最近几条必须都还在（BRIEF §5.5 槽位 + A4 多草稿共存）
  const lastThree = ['K27', 'K28', 'K29'].filter((sid) => h.pluginEntries().some((e) => e.key.includes(sid)))
  assert(lastThree.length === 3, `最近 3 条草稿只剩 ${lastThree.length} 条（${lastThree.join(',')}）→ 淘汰把该留的也清了`)
  const oldestGone = !h.pluginEntries().some((e) => /K0(\b|\.|$)/.test(e.key))
  assert(oldestGone, '最旧的 K0 还在（没有按 at 淘汰最旧）')
  return { measured: `${N} 个会话 × 10KB → 镜像 ${total}B（上限 ${256 * 1024}B）；最近 3 条都在；K0 已淘汰` }
})

await row('A13', '首次安装不覆盖用户已有草稿', async () => {
  const h = newHost()
  h.boot()
  const seeded = JSON.stringify({ draft: { references: [], text: '用户本来就有的草稿' }, view: 'trajectory', viewRequest: null })
  h.ls.setItem('dsh.conversation.F', seeded) // 插件装之前就存在
  h.resetCounters()
  h.mount('F') // shell 从官方键读回用户草稿
  await advance(h, 1000)
  const touched = draftCalls(h).filter((c) => c.sessionId === 'F')
  assert(touched.length === 0, `挂载时就对已有草稿调了 ${touched.length} 次 setDraft（可能覆盖用户内容）`)
  const rawOfficial = h.ls.__map.get('dsh.conversation.F')
  assert(rawOfficial !== undefined, '官方键在挂载后消失了（插件把它删了？）')
  const now = JSON.parse(rawOfficial)
  const txt = typeof now.draft === 'string' ? now.draft : now.draft?.text
  assert(txt === '用户本来就有的草稿', `官方键里的用户草稿被改动：${JSON.stringify(txt)}`)
  return { measured: `setDraft 调用 0 次；官方键原样保留` }
})

await row('A14', 'L1 优先（不裸写官方键）+ L3 兜底保住 view', async () => {
  const h = newHost()
  h.boot()
  // 先用正常通道攒一条镜像
  h.openSession('V', '/ws')
  h.mount('V')
  h.type('V', 'L3 兜底的内容')
  await advance(h, 1000)
  h.unmount('V')
  h.closeSession('V')

  // 铺一个带视图偏好的官方键（用户正在轨迹视图）
  h.ls.setItem('dsh.conversation.V', JSON.stringify({
    draft: { references: [], text: '' }, view: 'trajectory', viewRequest: { view: 'trajectory', focus: null },
  }))

  // 掐掉 L1 与 L2，逼实现走 L3
  h.disableL2 = true
  h.resetCounters()
  h.mount('V', { inputActions: undefined })
  await advance(h, 1000)

  const l1 = h.calls('L1.setDraft').length
  const official = h.officialWrites().filter((w) => w.type === 'set')
  const last = official.length ? official[official.length - 1] : null
  if (!last) {
    return { status: 'WARN', measured: `L1 调用 ${l1}；官方键一次都没写`, note: '没有 L3 兜底层（impl-contract §2.1 列为必备兜底；不实现不会丢数据，但契约未落地）' }
  }
  let parsed = null
  try { parsed = JSON.parse(last.value) } catch (_) {}
  const txt = typeof parsed?.draft === 'string' ? parsed.draft : parsed?.draft?.text
  if (txt !== 'L3 兜底的内容') {
    return { status: 'WARN', measured: `L1=${l1}；末次官方写入 draft=${JSON.stringify(txt)}`, note: 'L3 未把内容写进官方键（兜底缺失）' }
  }
  assert(parsed.view === 'trajectory', `L3 把 view 弄丢了：${JSON.stringify(parsed.view)}（用户会被强行拉回对话视图）`)
  assert(parsed.viewRequest && parsed.viewRequest.view === 'trajectory', `L3 把 viewRequest 弄丢了：${JSON.stringify(parsed.viewRequest)}`)
  return { measured: `L1 不可用时走 L3；写后 view=trajectory / viewRequest 保住` }
})

await row('A15', '宿主 API 缺失 → 降级不抛（BRIEF §6E）', async () => {
  const h = newHost()
  h.boot()
  h.openSession('N', '/ws')
  let threw = null
  try {
    // 只给 sessionId，其余宿主能力全无
    h.mount('N', { inputActions: undefined, useInput: undefined, useSessions: undefined, useConversation: undefined })
    await advance(h, 500)
    h.type('N', '没有宿主接口时的输入')
    await advance(h, 800)
  } catch (e) { threw = e }
  assert(!threw, `宿主 API 缺失时直接抛异常：${threw?.message}`)
  const errs = allErrors(h)
  assert(errs.length === 0, `宿主 API 缺失时抛了 ${errs.length} 个异常：${errs[0]?.message}`)
  return { measured: '缺 inputActions/useInput/useSessions 时未抛异常' }
})

await row('A16', '设置页槽位已注册（BRIEF §7-6 的前置）', async () => {
  const h = newHost()
  h.boot()
  const slots = h.slotEntries.filter((e) => e.Component).map((e) => e.slot)
  assert(slots.length > 0, 'apply() 之后一个槽都没注册（两阶段注册漏了？）')
  const hasSettings = slots.includes('settings.section')
  const sessionSlot = h.pickSessionComponent()
  assert(sessionSlot, `没有会话作用域的挂载点（已注册：${JSON.stringify(slots)}），A1~A15 无从谈起`)
  if (!hasSettings) {
    return { status: 'FAIL', measured: `已注册：${slots.join(', ')}`, note: '缺 settings.section → BRIEF §7-6「设置页能看列表/删除/清空」无法达成' }
  }
  return { measured: `已注册：${slots.join(', ')}；挂载点=${sessionSlot.slot}` }
})

await row('A17', 'Hook 法规（无条件调用 / 无未知 hook）', async () => {
  const viol = ALL_HOSTS.flatMap((h) => h.react.violations)
  const unknown = [...new Set(ALL_HOSTS.flatMap((h) => h.react.unknownHooks()))]
  const detail = viol.length ? `${viol[0].key}: ${viol[0].detail}` : ''
  assert(viol.length === 0, `hook 顺序违规 ${viol.length} 处（历史 P0：RangeError: Invalid array length）—— ${detail}`)
  if (unknown.length) return { status: 'WARN', measured: `未知 hook：${unknown.join(', ')}`, note: 'harness 未实现该 hook，请补 test/harness.mjs 再测' }
  return { measured: `跨 ${ALL_HOSTS.length} 个场景、${ALL_HOSTS.reduce((n, h) => n + h.react.renderPasses(), 0)} 次渲染无违规` }
})

/* ═══════════════════════════ 输出表 ═══════════════════════════ */

function width(s) {
  let w = 0
  for (const ch of String(s)) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
  return w
}
function pad(s, n) {
  s = String(s)
  const fill = n - width(s)
  return s + ' '.repeat(Math.max(0, fill))
}
function wrap(s, n) {
  const out = []
  let line = ''
  for (const ch of String(s)) {
    line += ch
    if (width(line) >= n) { out.push(line); line = '' }
  }
  if (line) out.push(line)
  return out.length ? out : ['']
}

const fails = rows.filter((r) => r.status === 'FAIL')
const warns = rows.filter((r) => r.status === 'WARN')

console.log('')
console.log('═'.repeat(118))
console.log('dsh-composer-draft-keeper · 验收测试台')
console.log(`  被测文件  ${TARGET}`)
console.log(`  体积/时间 ${(SIZE / 1024).toFixed(1)}KB · ${MTIME}${TARGET.includes('fixtures') ? '  ← 标定件（fixture），不是产品代码' : ''}`)
console.log(`  node      ${process.version}`)
console.log('═'.repeat(118))
console.log(`${pad('#', 5)}${pad('验收项', 52)}${pad('结果', 8)}${pad('实测量', 40)}耗时`)
console.log('─'.repeat(118))
for (const r of rows) {
  console.log(`${pad(r.id, 5)}${pad(r.title, 52)}${pad(r.status, 8)}${pad(r.measured || '—', 40)}${r.ms.toFixed(0)}ms`)
  if (r.note) for (const line of wrap(`↳ ${r.note}`, 110)) console.log(`     ${line}`)
}
console.log('─'.repeat(118))
const pass = rows.length - fails.length - warns.length
console.log(`合计 ${rows.length} 项：PASS ${pass} · FAIL ${fails.length} · WARN ${warns.length}`)
if (fails.length) {
  console.log('')
  console.log('FAIL 明细：')
  for (const r of fails) console.log(`  [${r.id}] ${r.title}\n       ${r.note}`)
}
const debugLines = [...new Set(ALL_HOSTS.flatMap((h) => h.console.error.concat(h.console.warn)))]
if (debugLines.length) {
  console.log('')
  console.log('Console error/warn（前 8 条）：')
  for (const l of debugLines.slice(0, 8)) console.log(`  · ${String(l).slice(0, 160)}`)
}
console.log('')
process.exitCode = fails.length ? 1 : 0
