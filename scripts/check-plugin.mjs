#!/usr/bin/env node
/**
 * check-plugin.mjs —— 直接读宿主 LevelDB，验证 dsh-composer-draft-keeper 是否真的在工作
 *
 * 为什么读磁盘而不是 CDP：桌面实例默认不开调试端口，而 localStorage 是插件写盘的终点。
 * 它写没写、写成什么样，问磁盘最硬。
 *
 * 编码坑（实测踩过）：Chromium 的 Local Storage 里，纯 ASCII 的值用 Latin-1 存（前缀 0x01），
 * 含中文的值整段用 **UTF-16LE** 存。所以同一个库里两种编码并存，解析必须都试，
 * 否则中文草稿会被当成坏数据丢掉。
 *
 * 用法：
 *   node scripts/check-plugin.mjs
 *   node scripts/check-plugin.mjs --watch 30    # 每 2 秒刷一次共 30 秒，边说边看
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DB = join(homedir(), "AppData", "Roaming", "@deepseek-ai", "dsh-desktop", "Local Storage", "leveldb");
const NS = "dsh.draft-keeper.v1";

/** 在 Buffer 里找 UTF-16LE 版本的字符串 */
function findUtf16(buf, str) {
  const pat = Buffer.from(str, "utf16le");
  const out = [];
  let i = 0;
  while ((i = buf.indexOf(pat, i)) !== -1) { out.push(i); i += 2; }
  return out;
}

/** 从 offset 起按 UTF-16LE 解一段并抠出第一个完整 JSON 对象/数组 */
function jsonAt(buf, off, open = "{") {
  const s = buf.subarray(off, off + 4000).toString("utf16le");
  const i = s.indexOf(open);
  if (i < 0 || i > 4) return null;
  const close = open === "{" ? "}" : "]";
  let d = 0, end = -1;
  for (let k = i; k < s.length; k++) {
    if (s[k] === open) d++;
    else if (s[k] === close) { d--; if (d === 0) { end = k + 1; break; } }
  }
  if (end < 0) return null;
  try { return JSON.parse(s.slice(i, end)); } catch { return null; }
}

/** 取 UTF-16LE 值的「所属键名」：往回找最近的 dsh. 开头 ASCII 串 */
function keyNameBefore(buf, off) {
  const back = buf.subarray(Math.max(0, off - 260), off);
  const s = back.toString("latin1");
  const m = [...s.matchAll(/(dsh\.(?:draft-keeper|conversation)[A-Za-z0-9._-]*)/g)];
  return m.length ? m[m.length - 1][1].replace(/[\s\S]*?(dsh\.)/, "$1") : "(unknown)";
}

function scan() {
  if (!existsSync(DB)) return { err: `找不到 LevelDB：${DB}` };
  const files = readdirSync(DB).filter((f) => /\.(ldb|log)$/.test(f));

  const mirrors = new Map();   // at -> record
  const history = new Map();   // at -> array
  const official = new Map();  // sessionId -> value
  let meta = null;

  for (const f of files) {
    let buf;
    try { buf = readFileSync(join(DB, f)); } catch { continue; }

    // 镜像草稿 {"text":  ... "at": ... "cwd": ... }
    for (const off of findUtf16(buf, '{"text":')) {
      const o = jsonAt(buf, off, "{");
      // 关键：history 数组里也有 {"text":...,"at":...} 的元素，只有镜像记录带 cwd 与 consumedAt。
      // 不带这个过滤，历史条目会被误当成"待恢复草稿"，报出假的回灌警报（踩过）。
      if (o && typeof o.at === "number" && typeof o.consumedAt === "number" && typeof o.cwd === "string") {
        mirrors.set(o.at, { ...o, _key: keyNameBefore(buf, off) });
      }
    }
    // 历史 [{"text": ...
    for (const off of findUtf16(buf, '[{"text":')) {
      const arr = jsonAt(buf, off, "[");
      if (Array.isArray(arr) && arr.length && typeof arr[0].at === "number") {
        history.set(arr[0].at, { arr, _key: keyNameBefore(buf, off) });
      }
    }
    // 官方 {"draft": ...
    for (const off of findUtf16(buf, '{"draft":')) {
      const o = jsonAt(buf, off, "{");
      if (o && "draft" in o) official.set(JSON.stringify(o), o);
    }
    // meta / probe 是纯 ASCII，用 Latin-1 找
    const latin = buf.toString("latin1");
    const mi = latin.lastIndexOf(`${NS}.meta`);
    if (mi >= 0) {
      const seg = latin.slice(mi, mi + 400);
      const j = seg.indexOf("{");
      if (j > 0 && j < 12) {
        const e = seg.indexOf("}", j);
        if (e > 0) { try { meta = JSON.parse(seg.slice(j, e + 1)); } catch {} }
      }
    }
  }
  return { mirrors, history, official, meta, nFiles: files.length };
}

function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function report() {
  const r = scan();
  if (r.err) { console.error("✗ " + r.err); process.exit(1); }

  console.log("");
  console.log(`扫描 ${r.nFiles} 个 LevelDB 文件  @ ${fmtTime(Date.now())}`);
  console.log("─".repeat(84));

  const n = r.mirrors.size;
  if (n === 0) {
    console.log("镜像草稿：   0 条   ← 插件没写盘。可能：没加载 / 没打字 / 总开关关了");
  } else {
    console.log(`镜像草稿：   ${n} 条  ✓ 插件在工作`);
    console.log("");
    for (const at of [...r.mirrors.keys()].sort((a, b) => a - b).slice(-6)) {
      const o = r.mirrors.get(at);
      const flags = [
        o.consumedAt ? `已发送(${fmtTime(o.consumedAt)})` : "",
        o.orphanAt ? "孤儿" : "",
        o.inflight ? "在飞" : "",
      ].filter(Boolean).join(" ") || "待恢复";
      const body = String(o.text ?? "").replace(/\n/g, "⏎").slice(0, 46);
      const cwd = String(o.cwd ?? "").replace(/\\/g, "\\");
      console.log(`  ${fmtTime(o.at)}  ${flags.padEnd(20)} "${body}"`);
      console.log(`  ${" ".repeat(11)}└ cwd=${cwd}`);
    }
  }

  if (r.history.size) {
    console.log("");
    console.log("历史槽位：");
    for (const at of [...r.history.keys()].sort((a, b) => a - b).slice(-4)) {
      const { arr } = r.history.get(at);
      console.log(`  ${arr.length} 条  ` + arr.slice(0, 4).map((e) => `"${String(e.text ?? "").slice(0, 14)}"`).join("  ←  "));
    }
  }

  if (r.meta) console.log(`\n元数据：     ${JSON.stringify(r.meta)}`);

  console.log("");
  console.log(`官方键 dsh.conversation.*：${r.official.size} 个版本（完好 = 没破坏官方存储）`);
  const offs = [...r.official.values()];
  for (const o of offs.slice(-3)) {
    const d = o.draft;
    const t = typeof d === "string" ? d : d && d.text;
    console.log(`  draft="${String(t ?? "").replace(/\n/g, "⏎").slice(0, 52)}"  view=${JSON.stringify(o.view)}`);
  }

  console.log("─".repeat(84));
  const ok = r.mirrors.size > 0;
  console.log(ok ? "结论：插件确实在写盘 ✓" : "结论：没看到插件写入 —— 先在输入框打几个字再跑一次");
  return ok;
}

const args = process.argv.slice(2);
const w = args.indexOf("--watch");
if (w >= 0) {
  const secs = Number(args[w + 1] || 20);
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - t0 > secs * 1000) { clearInterval(timer); process.exit(0); }
    console.log("\n".repeat(2) + "=".repeat(84));
    report();
  }, 2000);
  report();
} else {
  process.exit(report() ? 0 : 1);
}
