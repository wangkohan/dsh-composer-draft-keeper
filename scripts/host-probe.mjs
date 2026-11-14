// dsh-composer-draft-keeper · 真宿主探针（CDP，只读）
//
// 用途：验收表里 test/acceptance.mjs 覆盖不到的宿主事实 —— 插件有没有真的被宿主加载、
//       U4（props.sessionId 非空）/ U5（props.inputActions 注入）有没有真的生效、
//       设置页卡片在不在、Console 有没有报错。
//
// ⚠️ 本脚本**只读**：不 kill 进程、不重启宿主、不改 profile。唯一例外是显式给 --type 时
//    会往输入框插一段文字（那会写到用户正在用的输入框里，默认关闭）。
//
// 跑法：
//   node scripts/host-probe.mjs                      # 自动找调试端口
//   node scripts/host-probe.mjs --port 9333 --watch 20
//   node scripts/host-probe.mjs --type "探针草稿ABC"   # 会真的插进输入框，慎用
//
// 退出码：0 全部 PASS / 1 有 FAIL / 3 没找到调试端口（需要先带 --remote-debugging-port 启动）

import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const has = (name) => argv.includes(`--${name}`)

const DEVTOOLS_FILE = 'C:/Users/84901/AppData/Roaming/@deepseek-ai/dsh-desktop/DevToolsActivePort'
const CANDIDATES = [flag('port', null), process.env.DSH_CDP_PORT, '9333', '9222'].filter(Boolean)

function readDevToolsPort() {
  try {
    const raw = readFileSync(DEVTOOLS_FILE, 'utf8').split('\n')[0].trim()
    return /^\d+$/.test(raw) ? raw : null
  } catch (_) { return null }
}

const rows = []
const add = (id, title, status, measured, note) => rows.push({ id, title, status, measured, note: note ?? '' })

async function fetchJson(url, ms = 3000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    return await res.json()
  } finally { clearTimeout(timer) }
}

async function resolvePort() {
  const tried = []
  const devtools = readDevToolsPort()
  const list = [...new Set([...CANDIDATES, devtools].filter(Boolean))]
  for (const port of list) {
    tried.push(port)
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, 1500)
      if (Array.isArray(list) && list.length > 0) return { port, targets: list }
    } catch (_) { /* 试下一个 */ }
  }
  return { port: null, tried }
}

const EXPR = {
  pluginCss: `document.getElementById('dsh-dk-css') !== null`,
  pluginScript: `[...document.querySelectorAll('script[src]')].map(s => s.src).filter(u => u.includes('draft-keeper')).length`,
  mirrorKeys: `Object.keys(localStorage).filter(k => k.startsWith('dsh.draft-keeper'))`,
  mirrorBytes: `Object.keys(localStorage).filter(k => k.startsWith('dsh.draft-keeper')).reduce((n,k) => n + k.length + String(localStorage.getItem(k)||'').length, 0)`,
  composer: `(() => { const el = document.querySelector('div[contenteditable="true"]'); return el ? { present: true, text: (el.innerText||'').slice(0,60), editable: el.getAttribute('contenteditable') } : { present: false } })()`,
  settingsCard: `document.querySelectorAll('.dsh-dk-card').length`,
  slotErrors: `[...document.querySelectorAll('[data-slot-error]')].map(e => e.getAttribute('data-slot-error')).filter(Boolean)`,
  officialKeys: `Object.keys(localStorage).filter(k => k.startsWith('dsh.conversation.')).length`,
}

async function main() {
  console.log('')
  console.log('═'.repeat(96))
  console.log('dsh-composer-draft-keeper · 真宿主探针（CDP / 只读）')
  console.log('═'.repeat(96))

  const { port, targets, tried } = await resolvePort()
  if (!port) {
    console.log(`\n✗ 没有可用的调试端口（试过：${(tried ?? []).join(', ')}）`)
    console.log('  当前宿主是不是没带 --remote-debugging-port 启动？这不是失败，是"还没开窗"。')
    console.log('  需要的动作（必须由队长与用户协调时机，把用户当前会话中断的代价算进去）：')
    console.log('    1) 让用户存手头的东西 → 完全退出 DeepSeek Harness（不是最小化）')
    console.log('    2) powershell -ExecutionPolicy Bypass -File D:\\agent-shared\\skills\\debug-dsh-plugin\\scripts\\win\\dsh_launch_cdp.ps1 -Port 9333')
    console.log('    3) node scripts/host-probe.mjs --port 9333')
    console.log(`  （历史 DevToolsActivePort 里记的是 ${readDevToolsPort() ?? '无'}，那个端口现在没人听）`)
    process.exitCode = 3
    return
  }

  const page = targets.find((t) => t.type === 'page' && /127\.0\.0\.1|localhost/.test(t.url ?? '')) ?? targets.find((t) => t.type === 'page')
  if (!page) { console.log('✗ 没有 page target'); process.exitCode = 3; return }
  console.log(`\n端口 ${port} · target ${page.url ?? '(无 url)'}`)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const consoleErrors = []
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('exception: ' + (msg.params?.exceptionDetails?.exception?.description ?? '').slice(0, 200))
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push('console.error: ' + (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
    }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id
    pending.set(myId, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)))
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws error')), { once: true }) })

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: false })
    if (r.exceptionDetails) throw new Error(`求值异常：${JSON.stringify(r.exceptionDetails).slice(0, 300)}`)
    return r.result.value
  }

  await send('Runtime.enable')

  // ── 1. 客户端半真的加载了吗 ──
  try {
    const css = await evaluate(EXPR.pluginCss)
    const scripts = await evaluate(EXPR.pluginScript)
    add('H1', '客户端半已加载（apply 跑过）', css ? 'PASS' : 'FAIL',
      `#dsh-dk-css=${css} · bundle 脚本数=${scripts}`,
      css ? '' : 'apply() 没跑过：bundle 没解析成功（看 H5/日志里的 skipping profile bundle），或插件没装进本 profile')
  } catch (e) { add('H1', '客户端半已加载', 'FAIL', '—', e.message) }

  // ── 2. 镜像有没有在写（间接证明 U4 props.sessionId 非空）──
  try {
    const keys = await evaluate(EXPR.mirrorKeys)
    const bytes = await evaluate(EXPR.mirrorBytes)
    add('H2', '镜像命名空间存在', keys.length > 0 ? 'PASS' : 'WARN',
      `${keys.length} 个键 / ${bytes} 字节`,
      keys.length ? `样例：${keys.slice(0, 2).join(' , ')}` : '还没写过草稿：先在输入框打几个字，等 >300ms 再看（U4 靠这一步间接验证）')
  } catch (e) { add('H2', '镜像命名空间存在', 'FAIL', '—', e.message) }

  // ── 3. 官方输入框健康（#9 的日常观测点）──
  try {
    const c = await evaluate(EXPR.composer)
    add('H3', '官方输入框可用', c.present ? 'PASS' : 'FAIL', JSON.stringify(c).slice(0, 90), c.present ? '' : '输入框不见了 —— 插件把 composer 子树搞崩了')
  } catch (e) { add('H3', '官方输入框可用', 'FAIL', '—', e.message) }

  // ── 4. 设置页卡片（#6 的存在性证据；需要先在 UI 里打开设置页）──
  try {
    const n = await evaluate(EXPR.settingsCard)
    add('H4', '设置卡片在 DOM 里', n > 0 ? 'PASS' : 'WARN', `.dsh-dk-card × ${n}`,
      n > 0 ? '' : '现在没打开设置页就会是 0：请手动打开 设置 → 插件/草稿保留 后再跑一次')
  } catch (e) { add('H4', '设置卡片在 DOM 里', 'FAIL', '—', e.message) }

  // ── 5. 插槽崩溃标记（宿主的红牌）──
  try {
    const errs = await evaluate(EXPR.slotErrors)
    const mine = errs.filter((s) => /draft|keeper/i.test(s))
    add('H5', '插槽无崩溃标记', mine.length === 0 ? 'PASS' : 'FAIL',
      `全部 error 槽=${errs.length}，属于本插件=${mine.length}`,
      mine.length ? `崩在槽：${mine.join(', ')}` : '')
  } catch (e) { add('H5', '插槽无崩溃标记', 'FAIL', '—', e.message) }

  // ── 6. Console 静默（BRIEF §6E）──
  const watch = Number(flag('watch', '0'))
  if (watch > 0) {
    console.log(`\n监听 Console ${watch}s（请在这段时间里正常打字/切会话）…`)
    await new Promise((r) => setTimeout(r, watch * 1000))
    const mine = consoleErrors.filter((s) => /draft-keeper/i.test(s))
    add('H6', `Console 静默（${watch}s）`, mine.length === 0 ? 'PASS' : 'FAIL',
      `总 error=${consoleErrors.length}，含 draft-keeper=${mine.length}`,
      mine[0] ?? (consoleErrors.length ? `其它插件的报错（不算本插件）：${consoleErrors[0]}` : ''))
  } else {
    add('H6', 'Console 静默', 'SKIP', '未开 --watch', '要验"连续输入无报错"就加 --watch 30')
  }

  // ── 7. （可选）往输入框插一段探针文字 —— 会写进用户正在用的输入框 ──
  const typed = flag('type', null)
  if (typed) {
    console.log(`\n⚠️  正要往输入框插入：${JSON.stringify(typed)}（这是真的写进用户会话）`)
    const focus = await evaluate(`(() => { const el = document.querySelector('div[contenteditable="true"]'); if (!el) return 'no-composer'; el.focus(); const s = getSelection(); s.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); s.addRange(r); return 'ok' })()`)
    if (focus === 'ok') {
      await send('Input.insertText', { text: typed })
      await new Promise((r) => setTimeout(r, 800))
      const values = await evaluate(`Object.keys(localStorage).filter(k=>k.startsWith('dsh.draft-keeper')).map(k=>String(localStorage.getItem(k)))`)
      const found = values.some((v) => v.includes(typed))
      add('H7', '探针文字已落镜像', found ? 'PASS' : 'FAIL', `${values.length} 个值`, found ? '' : '打字后 >300ms 才会落盘，若仍为 0 则镜像管线不通')
    } else {
      add('H7', '探针文字已落镜像', 'FAIL', focus, '找不到 contenteditable 输入框')
    }
  }

  ws.close()

  console.log('')
  console.log('─'.repeat(96))
  console.log('#    检查项                                   结果    实测')
  console.log('─'.repeat(96))
  for (const r of rows) {
    console.log(`${r.id.padEnd(5)}${r.title.padEnd(40)}${r.status.padEnd(8)}${r.measured}`)
    if (r.note) console.log(`     ↳ ${r.note}`)
  }
  const fails = rows.filter((r) => r.status === 'FAIL')
  console.log('─'.repeat(96))
  console.log(`合计：PASS ${rows.filter((r) => r.status === 'PASS').length} · FAIL ${fails.length} · WARN ${rows.filter((r) => r.status === 'WARN').length} · SKIP ${rows.filter((r) => r.status === 'SKIP').length}`)
  console.log('')
  process.exitCode = fails.length ? 1 : 0
}

main().catch((e) => { console.error('探针崩了：', e); process.exitCode = 1 })
