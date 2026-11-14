/**
 * 静态契约核对（impl-contract 逐条的机械版）。
 *
 * 它不能替代 test/acceptance.mjs（那是行为证据），只负责抓"读一眼就能看出违背契约"的东西：
 * 文件体积、裸写官方键、网络调用、非 react 依赖、两阶段注册、冻结态字面量、条件 hook 气味。
 *
 * 跑法：node test/review.mjs [目标文件]      默认 lib/client.js
 * 退出码：有 P0 → 1
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const TARGET = process.argv[2] ? join(ROOT, process.argv[2]) : join(ROOT, 'lib', 'client.js')
if (!existsSync(TARGET)) {
  console.log(`找不到 ${TARGET}`)
  process.exit(2)
}
const src = readFileSync(TARGET, 'utf8')
const size = statSync(TARGET).size
const lines = src.split('\n')
const findings = []

const add = (level, id, title, line, why, fix) => findings.push({ level, id, title, line, why, fix })
const lineOf = (index) => src.slice(0, index).split('\n').length

/** 该位置是否在某个 try { ... } 里 */
function insideTry(index) {
  const stack = []
  for (let i = 0; i < index; i++) {
    const ch = src[i]
    if (ch === '{') {
      let j = i - 1
      while (j >= 0 && /\s/.test(src[j])) j--
      const before = src.slice(Math.max(0, j - 3), j + 1)
      stack.push({ isTry: /\btry$/.test(before) })
    } else if (ch === '}') stack.pop()
  }
  return stack.some((f) => f.isTry)
}

/** 每个匹配位置都查一遍：宿主 API / 存储调用是否被 try 包住 */
function requireTry(pattern, label) {
  const re = new RegExp(pattern, 'g')
  let m, bad = []
  while ((m = re.exec(src)) !== null) {
    if (!insideTry(m.index)) bad.push(lineOf(m.index))
  }
  if (bad.length) add('P1', 'TRY', `${label} 有 ${bad.length} 处不在 try 里`, bad.join(','), '宿主 API 一抛就会打断输入框子树（BRIEF §6E：任何宿主 API 缺失都要降级，不许抛到 Console）', '把调用点包进 try/catch，并在 catch 里 dbg 一条后继续')
  return bad.length
}

/* ── 1. 体积（BRIEF §6F：单文件 ≤ 40KB）── */
if (size > 40 * 1024) {
  add('P1', 'SIZE', `单文件 ${(size / 1024).toFixed(1)}KB > 40KB 上限`, '-', 'BRIEF §6F 硬要求；体积越大，宿主侧解析越慢、review 越难', '把 UI 层（设置卡片 + CSS 字符串）拆到第二个文件，或压缩注释与 CSS')
}

/* ── 2. L1 通道存在且 setDraft 后跟 persistDraft ── */
{
  const hasSet = /\.setDraft\s*\(/.test(src)
  const hasPersist = /\.persistDraft\s*\(/.test(src)
  if (!hasSet) add('P0', 'L1', '没有调用 inputActions.setDraft —— 恢复没有走 L1', '-', '不走 L1 就只能裸写官方键，会被官方内存态在用户下一次按键时整键覆盖（impl-contract §3.1.6）', '恢复路径改为 inputActions.setDraft(text) + persistDraft()')
  else if (!hasPersist) add('P0', 'L1b', 'setDraft 之后没有 persistDraft', '-', 'immer 在内容无变化时返回原引用 → zustand 的 Object.is 守卫不通知 → 不写盘，等于没恢复（impl-contract §3.1.3）', 'setDraft 后无条件补一次 persistDraft()')
}

/* ── 3. 官方键：只允许"读-改-写"，且必须保住 view/viewRequest ── */
{
  const officialWrite = /setItem\s*\(\s*(officialKey\s*\(|"dsh\.conversation\.|`dsh\.conversation\.)/g
  let m
  let bad = 0
  while ((m = officialWrite.exec(src)) !== null) {
    const line = lineOf(m.index)
    const around = src.slice(Math.max(0, m.index - 1400), m.index)
    const readsBack = /JSON\.parse/.test(around)
    const spreads = /\.\.\.\s*base|Object\.assign\(\s*\{\s*\}\s*,\s*base/.test(src.slice(m.index - 200, m.index + 400))
    if (!readsBack || !spreads) {
      bad++
      add('P0', 'L3-VIEW', `L3 直写官方键疑似丢了原字段（第 ${line} 行附近）`, line, '只写 {draft} 会清掉 view / viewRequest → 用户下次进会话被强行从「轨迹」拉回「对话」（impl-contract §3.6.1）', '必须 JSON.parse 原值 → 只替换 draft → 其余字段原样写回')
    }
  }
  if (officialWrite.exec === null && officialWrite.lastIndex === 0) { /* 没有 L3：不算错 */ }
  if (bad === 0) {
    const hasReadModifyWrite = /JSON\.parse/.test(src) && /base/.test(src)
    if (!hasReadModifyWrite) {
      add('WARN', 'L3', '没有找到 L3 兜底层', '-', 'impl-contract §2.1 把 localStorage 读-改-写列为第三层兜底；不实现不会丢数据，但契约缺一层', '补 writeOfficialDraftRaw(env, sid, text)，只替换 draft')
    }
  }
}

/* ── 4. 「sessionId 变了」不能当新建判据（§Q4 的坑）── */
{
  const smells = [
    /(lastSessionId|prevSessionId|previousSessionId|上一次.*sessionId)/,
    /sessionId\s*!==\s*(last|prev|previous)/,
    /\b(isNewSession|sessionChanged|newSession)\b\s*[=(]/,
  ]
  for (const re of smells) {
    const m = re.exec(src)
    if (m) add('P0', 'Q4', `疑似拿「sessionId 变了」当新建会话判据：${m[0]}`, lineOf(m.index), '新建会话会复用空白会话的同一个 id（impl-contract §3.4.2），按 id 变化判新建必然把刚发出去的草稿塞回输入框', '判据只能是「当前 draft 为空 ∧ 本页未恢复过该 sid ∧ 镜像条目未被消费」')
  }
}

/* ── 5. 冻结态（adjudicating / submitting / sending 一个都不能少）── */
{
  const missing = ['adjudicating', 'submitting', 'sending'].filter((p) => !src.includes(p))
  if (missing.length) add('P1', 'FROZEN', `冻结态判断缺 ${missing.join(' / ')}`, '-', 'phase 有 5 个值、后 3 个是只读冻结态（impl-contract §3.2.3）；漏一个就会在发送中跟官方抢草稿', '用常量表 [adjudicating, submitting, sending] 统一判')
}

/* ── 6. 条件调用 hook（历史 P0）── */
{
  const re = /if\s*\([^)\n]*\)\s*(?:\{[^}]{0,80})?\b(use[A-Z]\w*)\s*\(/g
  let m
  let hits = 0
  while ((m = re.exec(src)) !== null) {
    if (m[1] === 'useState' && /^\s*\/\//.test(lines[lineOf(m.index) - 1] ?? '')) continue
    hits++
    add('P1', 'HOOKS', `疑似条件调用 ${m[1]}`, lineOf(m.index), '条件调用 hook 会让 hook 数量在两次渲染间变化 → RangeError: Invalid array length，崩掉整个输入框子树（历史 P0）', '把 hook 提到组件顶层无条件调用，条件只放在 effect 内部；需要"锁死有没有"时用 useRef 首帧判定（见禁则：判定结果此后不得改变）')
  }
  if (!hits) {
    // 用 ref 首帧锁定的写法是允许的，但要能看出它"只判一次"
    const latched = /gate\.current\s*===\s*null|useRef\(null\)[\s\S]{0,120}usable/.test(src)
    if (!latched) add('WARN', 'HOOKS2', '没有看到"首帧锁死可用性"的写法', '-', '可选宿主 hook 缺席时如果不锁死，很容易写成条件 hook', '用 useRef 首帧记录 usable，此后不再改变分支')
  }
}

/* ── 7. 零网络（BRIEF §5.8 纯本地）── */
{
  const nets = [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /navigator\.sendBeacon/, /\bimport\s*\(/]
  for (const re of nets) {
    const m = re.exec(src)
    if (m) add('P0', 'NET', `出现网络/动态加载调用：${m[0]}`, lineOf(m.index), 'BRIEF §5.8 要求纯本地、零网络；任何外联都会被市场审核和用户质疑', '删掉；插件只需 localStorage')
  }
}

/* ── 8. 除 react 外零依赖 ── */
{
  const re = /require\s*\(\s*["']([^"']+)["']\s*\)/g
  let m
  const deps = new Set()
  while ((m = re.exec(src)) !== null) deps.add(m[1])
  const extra = [...deps].filter((d) => d !== 'react')
  if (extra.length) add('P0', 'DEPS', `非 react 的运行时依赖：${extra.join(', ')}`, '-', 'BRIEF §6F：除 react 外零外部依赖', '删掉该依赖或改为可选探测（typeof xxx !== "undefined"）')
}

/* ── 9. 两阶段注册（裸 register 永不渲染且零报错）── */
{
  const injects = (src.match(/slots\.inject\s*\(/g) ?? []).length
  const registers = (src.match(/slots\.register\s*\(/g) ?? []).length
  if (registers === 0) add('P0', 'SLOT', '没有任何 slots.register —— 插件不会渲染任何东西', '-', '两阶段注册是硬要求（BRIEF §3.9）', 'slots.inject(name, () => slots.register(opts, Component))')
  else if (injects === 0) add('P1', 'SLOT2', '有 register 但没有 inject', '-', '裸 register 永不渲染、也不报错（BRIEF §3.9 的坑）', '包进 slots.inject')
}

/* ── 10. 宿主 API 调用是否都在 try 里 ── */
{
  const n1 = requireTry('localStorage\\s*\\.\\s*(getItem|setItem|removeItem)', 'localStorage 调用')
  const n2 = requireTry('(?:store|env|ls)\\s*\\.\\s*(getItem|setItem|removeItem)\\s*\\(', '存储对象调用')
  const n3 = requireTry('inputActions\\s*\\.\\s*setDraft\\s*\\(', 'inputActions.setDraft')
  if (n1 + n2 + n3 === 0) { /* 全部包好了 */ }
}

/* ── 11. 输入法保护 ── */
{
  if (!src.includes('compositionstart')) add('P0', 'IME', '没有任何 composition 处理', '-', 'BRIEF §6A：composition 期间落盘会把半截拼音存进去（中文用户的生死线）', 'document 级监听 compositionstart/compositionend，期间不落盘、end 后补存一次')
  else if (!src.includes('compositionend')) add('P0', 'IME2', '监听了 compositionstart 但没有 compositionend', '-', 'BRIEF §6A：compositionend 之后必须补一次保存，否则最后一个词的改动丢', '补 compositionend 处理')
}

/* ── 12. 测试钩子（验证员要用）── */
if (!src.includes('__internals') && !src.includes('__test')) {
  add('INFO', 'HOOK', '没有导出 __internals 测试钩子', '-', '不影响宿主，但验证员/工程师都没法在 node 里单测闸门函数', 'Object.defineProperty(exports, "__internals", { value: {...}, enumerable: false })')
}

/* ── 输出 ── */
const P0 = findings.filter((f) => f.level === 'P0')
const P1 = findings.filter((f) => f.level === 'P1')
const warn = findings.filter((f) => f.level === 'WARN' || f.level === 'INFO')

console.log('')
console.log('═'.repeat(100))
console.log(`静态契约核对 · ${TARGET} · ${(size / 1024).toFixed(1)}KB · ${lines.length} 行`)
console.log('═'.repeat(100))
if (findings.length === 0) console.log('✓ 机械检查全部通过（行为证据仍以 test/acceptance.mjs 为准）')
for (const f of findings) {
  console.log(`\n[${f.level}] ${f.id} 第 ${f.line} 行 · ${f.title}`)
  console.log(`   为什么：${f.why}`)
  console.log(`   怎么改：${f.fix}`)
}
console.log('')
console.log(`合计：P0 ${P0.length} · P1 ${P1.length} · WARN/INFO ${warn.length}`)
console.log('')
process.exitCode = P0.length ? 1 : 0
