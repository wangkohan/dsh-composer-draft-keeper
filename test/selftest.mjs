/**
 * 测具的测具：标定 test/acceptance.mjs 本身。
 *
 * 为什么必须有这个文件：
 *   一张"什么都能过"的验收表等于没有。这里用两个 fixture 交叉标定 ——
 *   一个按 impl-contract 写对的（good），一个故意处处踩坑的（bad）。
 *   要求 good 全绿、bad 必须把指定几条打红。
 *
 * 跑法：node test/selftest.mjs        （不需要宿主，几秒钟）
 */

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const RUN = (client) => spawnSync(process.execPath, [join(ROOT, 'test', 'acceptance.mjs')], {
  cwd: ROOT,
  env: { ...process.env, DK_CLIENT: client },
  encoding: 'utf8',
})

function parse(out) {
  const rows = []
  for (const line of out.split('\n')) {
    const m = line.match(/^(A\d+)\s+(.*?)\s{2,}(PASS|FAIL|WARN|SKIP)\b/)
    if (m) rows.push({ id: m[1], status: m[3] })
  }
  const summary = out.match(/合计 (\d+) 项：PASS (\d+) · FAIL (\d+) · WARN (\d+)/)
  return {
    rows,
    total: summary ? Number(summary[1]) : 0,
    pass: summary ? Number(summary[2]) : 0,
    fail: summary ? Number(summary[3]) : 0,
    warn: summary ? Number(summary[4]) : 0,
  }
}

const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1 }

// ── 1. 正确实现必须全绿 ──
const good = RUN('test/fixtures/good-client.js')
const g = parse(good.stdout)
console.log(`good-client : ${g.total} 项 · PASS ${g.pass} · FAIL ${g.fail} · WARN ${g.warn}（exit ${good.status}）`)
if (g.total !== 17) fail(`good-client 只跑出 ${g.total} 项（应为 17），测试台本身有问题`)
if (g.fail !== 0) {
  fail(`good-client 有 ${g.fail} 项 FAIL —— 说明断言过严或有 bug，不是实现的问题：`)
  for (const r of g.rows.filter((x) => x.status === 'FAIL')) console.error(`    ${r.id}`)
}
if (good.status !== 0) fail(`good-client 的 exit code 是 ${good.status}，应为 0`)

// ── 2. 错误实现必须被抓住（每条都是"这一行真的会红"的证据）──
const bad = RUN('test/fixtures/bad-client.js')
const b = parse(bad.stdout)
console.log(`bad-client  : ${b.total} 项 · PASS ${b.pass} · FAIL ${b.fail} · WARN ${b.warn}（exit ${bad.status}）`)
const mustFail = {
  A1: '跨会话保留',
  A2: '发送后不回灌',
  A4: '会话隔离',
  A5: '拼音保护',
  A7: 'debounce / 3 万字',
  A9: '空白不写',
  A11: '配额静默放弃',
  A12: '256KB 淘汰',
  A13: '首次安装不覆盖',
  A15: '宿主 API 降级',
  A16: '设置页槽位',
  A17: 'hook 法规',
}
for (const [id, why] of Object.entries(mustFail)) {
  const r = b.rows.find((x) => x.id === id)
  if (!r) fail(`bad-client 结果里没有 ${id}`)
  else if (r.status !== 'FAIL') fail(`${id}（${why}）在坏实现上是 ${r.status} —— 这条断言抓不住 bug，等于假绿`)
}
if (bad.status === 0) fail('bad-client 的 exit code 是 0，FAIL 没有反映到退出码上')

// ── 3. 缺文件时给可执行的提示，不是崩栈 ──
const none = spawnSync(process.execPath, [join(ROOT, 'test', 'acceptance.mjs')], {
  cwd: ROOT, env: { ...process.env, DK_CLIENT: 'test/fixtures/__nope__.js' }, encoding: 'utf8',
})
console.log(`missing     : exit ${none.status}（期望 2 = 被测文件不存在）`)
if (none.status !== 2) fail(`被测文件缺失时 exit code 是 ${none.status}，应为 2`)

console.log(process.exitCode ? '\n✗ 测具标定未通过' : '\n✓ 测具标定通过：好实现全绿、坏实现必红')
