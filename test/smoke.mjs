/**
 * 烟雾测试：不需要宿主、不需要浏览器。
 *
 *   node test/smoke.mjs
 *
 * 三层覆盖：
 *   1) 语法/切片：lib/client.js 能被 vm 解析、能按 __ModuleLoader__.load 的格式执行
 *   2) 装载：假 window / localStorage / document / react，跑出 factory，确认 apply() 注册两张卡不抛
 *   3) 逻辑：用 __internals 直接测存储层与闸门（镜像读写、容量淘汰、孤儿清理、空白不写、发送后不回灌）
 *
 * 退出码：0 全过 / 1 有用例失败。任何失败都打印断言原文，方便验证员对照。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT = join(ROOT, "lib", "client.js");

let passed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("  ✓ " + name);
    return true;
  }
  failures.push({ name, detail });
  console.log("  ✗ " + name + (detail === undefined ? "" : "  → " + JSON.stringify(detail)));
  return false;
}

function eq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  return ok(name, same, same ? undefined : { actual, expected });
}

function section(title) {
  console.log("\n" + title);
}

// ── 假 localStorage（可选配额，模拟 QuotaExceededError）──────────────────────
function createStore(options = {}) {
  const limit = typeof options.limit === "number" ? options.limit : Infinity;
  const map = new Map();
  let used = 0;
  const bytes = (key, value) => Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
  return {
    get length() {
      return map.size;
    },
    key(index) {
      const keys = [...map.keys()];
      return index >= 0 && index < keys.length ? keys[index] : null;
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      const text = String(value);
      const prev = map.has(key) ? bytes(key, map.get(key)) : 0;
      const next = used - prev + bytes(key, text);
      if (next > limit) {
        const error = new Error("quota exceeded");
        error.name = "QuotaExceededError";
        throw error;
      }
      used = next;
      map.set(key, text);
    },
    removeItem(key) {
      if (!map.has(key)) return;
      used -= bytes(key, map.get(key));
      map.delete(key);
    },
    _map: map,
    _used: () => used,
  };
}

// ── 假 react（只满足"定义期不抛"，不实现真渲染语义）─────────────────────────
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props, children };
  },
  useState(initial) {
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  useRef(initial) {
    return { current: initial };
  },
  useEffect() {},
  useMemo(factory) {
    return factory();
  },
  useCallback(fn) {
    return fn;
  },
};

function loadClient(store) {
  const code = readFileSync(CLIENT, "utf8");
  let captured = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) {
          captured = mod;
        },
      },
    },
    localStorage: store,
    document: {
      head: { appendChild() {} },
      getElementById() {
        return null;
      },
      createElement() {
        return { id: "", textContent: "" };
      },
      addEventListener() {},
      removeEventListener() {},
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    Symbol,
    Object,
    JSON,
    Date,
    Math,
    String,
    Number,
    Array,
    RegExp,
    Error,
  };
  const script = new vm.Script(code, { filename: "lib/client.js" });
  script.runInNewContext(sandbox, { timeout: 5000 });
  if (captured === null) throw new Error("client.js 没有调用 window.__ModuleLoader__.load");
  const module = { exports: {} };
  const factoryRequire = (id) => {
    if (id === "react") return reactStub;
    throw new Error("unexpected require: " + id);
  };
  const exported = captured.factory(factoryRequire);
  Object.assign(module.exports, exported);
  return { mod: captured, exported, code };
}

// ══════════════════════════════════════════════════════════════════════════
section("1) 语法与切片");
const raw = readFileSync(CLIENT, "utf8");
let parseError = null;
try {
  new vm.Script(raw, { filename: "lib/client.js" });
} catch (error) {
  parseError = error;
}
ok("lib/client.js 可被 vm 解析（无语法错误）", parseError === null, parseError && parseError.message);
const stripped = raw.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "");
ok("按 __ModuleLoader__.load 格式包裹（跳过文件头注释）", stripped.indexOf("window.__ModuleLoader__.load({") === 0, stripped.slice(0, 40));
ok("模块 id 正确", raw.indexOf('id: "dsh-composer-draft-keeper"') > 0);
ok("文件体积 ≤ 40KB", Buffer.byteLength(raw, "utf8") <= 40 * 1024, { bytes: Buffer.byteLength(raw, "utf8") });

// ══════════════════════════════════════════════════════════════════════════
section("2) 装载与注册");
const store = createStore();
let loaded = null;
let loadError = null;
try {
  loaded = loadClient(store);
} catch (error) {
  loadError = error;
}
ok("factory 执行不抛", loadError === null, loadError && (loadError.stack || loadError.message));

const exported = loaded ? loaded.exported : {};
ok("导出 apply 函数", typeof exported.apply === "function");
eq("导出 inject = ['slots']", exported.inject, ["slots"]);
ok("__internals 存在且不可枚举", typeof exported.__internals === "object" && !Object.keys(exported).includes("__internals"));

const I = exported.__internals || {};
const registered = [];
const slotsStub = {
  inject(name, fn) {
    fn(); // 真宿主是延迟执行；这里立刻执行，只为验证 register 不抛
  },
  register(opts, component) {
    registered.push({ opts, component });
    return () => {};
  },
};
let applyError = null;
try {
  exported.apply({
    get(key) {
      return key === "slots" ? slotsStub : undefined;
    },
  });
} catch (error) {
  applyError = error;
}
ok("apply() 不抛", applyError === null, applyError && applyError.message);
eq(
  "注册了两个槽",
  registered.map((row) => row.opts.name).sort(),
  ["conversation.input.dock", "settings.section"]
);
const dock = registered.find((row) => row.opts.name === "conversation.input.dock");
const settings = registered.find((row) => row.opts.name === "settings.section");
ok("dock 槽带 id（list 槽硬要求）", dock && typeof dock.opts.id === "string" && dock.opts.id.length > 0, dock && dock.opts);
ok("settings 槽带 id/order/label", settings && settings.opts.id && typeof settings.opts.label === "string", settings && settings.opts);

// 组件本体能渲染（不抛），dock 必须是零渲染
// dock 注册的是 renderDock(props) = createElement(DraftKeeper, props)，
// 所以先拿 element 的 type（真组件）再调一次，验证它自己 return null。
const dockProps = {
  sessionId: "session-abc",
  inputActions: { setDraft() {}, persistDraft() {} },
  useInput: (selector) => selector({ draft: "", phase: "plain", draftRev: 1 }),
  useSessions: (selector) => selector({ byId: { "session-abc": { cwd: "/tmp/ws" } } }),
};
let dockError = null;
let dockOutput = "未执行";
try {
  const element = dock.component(dockProps);
  ok("dock 渲染的是 DraftKeeper 组件", typeof element.type === "function", { type: typeof element.type });
  dockOutput = element.type(element.props);
} catch (error) {
  dockError = error;
}
ok("DraftKeeper 渲染不抛", dockError === null, dockError && (dockError.stack || dockError.message));
ok("DraftKeeper 零渲染（return null）", dockOutput === null, { dockOutput });

let settingsError = null;
try {
  settings.component();
} catch (error) {
  settingsError = error;
}
ok("SettingsCard 渲染不抛", settingsError === null, settingsError && settingsError.message);

// 宿主缺 slots 时必须安静降级，不能抛
let degradeError = null;
try {
  exported.apply({ get: () => undefined });
  exported.apply({}); // 连 get 都没有
} catch (error) {
  degradeError = error;
}
ok("缺 slots 服务时安静降级", degradeError === null, degradeError && degradeError.message);

// ══════════════════════════════════════════════════════════════════════════
section("3) 存储层：命名空间与基础");
eq("命名空间", I.NS, "dsh.draft-keeper.v1");
eq("镜像键名", I.KEY.draft("session-x"), "dsh.draft-keeper.v1.drafts.session-x");
eq("历史键名", I.KEY.history("session-x"), "dsh.draft-keeper.v1.history.session-x");

const s1 = createStore();
eq("空白：空串不写", I.writeDraft(s1, "sid", "").reason, "blank");
eq("空白：纯空格不写", I.writeDraft(s1, "sid", "   \n\t ").reason, "blank");
eq("空白：NUL 不写", I.writeDraft(s1, "sid", "\u0000\u0000").reason, "blank");
eq("空白：零宽字符不写", I.writeDraft(s1, "sid", "\u200b\u200c").reason, "blank");
eq("空白：无 sid 不写", I.writeDraft(s1, "", "hello").reason, "no-session");
eq("空白不写后键不存在", I.pluginKeys(s1), []);

eq("写入成功", I.writeDraft(s1, "sid", "hello", { now: 1000 }).ok, true);
eq("读回文本", I.readDraft(s1, "sid").text, "hello");
eq("读回时间戳", I.readDraft(s1, "sid").at, 1000);
eq("列表一条", I.listDrafts(s1).length, 1);
eq("历史一条", I.readHistory(s1, "sid").length, 1);
ok("容量统计 > 0", I.usageBytes(s1) > 0, { usage: I.usageBytes(s1) });

const weird = "第一行\n第二行\t制表 😀🎉 \u0000尾";
I.writeDraft(s1, "sid2", weird, { now: 1001 });
eq("换行/emoji/NUL 原样往返", I.readDraft(s1, "sid2").text, weird);
eq("utf8Bytes(😀) = 4", I.utf8Bytes("😀"), 4);

eq("读取不存在的会话", I.readDraft(s1, "nope"), null);
ok("坏 JSON 按空处理", (() => {
  s1.setItem(I.KEY.draft("broken"), "{not json");
  try {
    return I.readDraft(s1, "broken") === null;
  } finally {
    s1.removeItem(I.KEY.draft("broken"));
  }
})());

// ══════════════════════════════════════════════════════════════════════════
section("4) 存储层：历史槽位与配置");
const s2 = createStore();
for (const text of ["aaa", "bbb", "ccc", "ddd", "eee"]) I.writeDraft(s2, "sid", text, { maxHistory: 3 });
const hist = I.readHistory(s2, "sid");
eq("历史条数被限制在 3", hist.length, 3);
eq("历史最新在前", hist[0].text, "eee");
eq("连续同文本不重复占槽", (() => {
  const s = createStore();
  I.writeDraft(s, "x", "same", { maxHistory: 10 });
  I.writeDraft(s, "x", "same", { maxHistory: 10 });
  return I.readHistory(s, "x").length;
})(), 1);

const cfg = I.readConfig(createStore());
eq("默认开启", cfg.enabled, true);
eq("默认历史 10 条", cfg.maxHistory, 10);
eq("默认容量 256KB", cfg.capacityBytes, 256 * 1024);
const s3 = createStore();
I.writeConfig(s3, { enabled: false, maxHistory: 5 });
eq("配置可写可读", I.readConfig(s3), { ...cfg, enabled: false, maxHistory: 5 });
eq("配置非法值被忽略（回落默认 10）", I.writeConfig(s3, { maxHistory: -1 }).maxHistory, 10);

// ══════════════════════════════════════════════════════════════════════════
section("5) 存储层：容量淘汰与配额");
const s4 = createStore();
for (let i = 0; i < 6; i += 1) I.writeDraft(s4, "old-" + i, "x".repeat(120), { now: 1000 + i, capacityBytes: 1024 * 1024 });
eq("6 条都在", I.listDrafts(s4).length, 6);
I.writeDraft(s4, "fresh", "y".repeat(120), { now: 2000, capacityBytes: 900 });
const kept = I.listDrafts(s4).map((row) => row.sessionId);
ok("超容量时淘汰最旧", kept.length < 6 && kept.includes("fresh"), { kept });
ok("刚写的那条不会被自己淘汰", kept.includes("fresh"), { kept });
ok("淘汰按 at 升序（先删最旧）", kept.includes("old-5") && !kept.includes("old-0"), { kept });

const tiny = createStore({ limit: 400 });
let quotaResult = null;
try {
  quotaResult = I.writeDraft(tiny, "sid", "z".repeat(400));
} catch (error) {
  quotaResult = { threw: error.message };
}
eq("配额爆炸：静默放弃（不抛）", quotaResult.reason, "quota");
ok("配额失败不抛异常", quotaResult.threw === undefined);

// 配额刚好能放下一条：写第二条 → 淘汰最旧 → 重试成功
const tight = createStore({ limit: 900 });
I.writeDraft(tight, "a", "A".repeat(200), { now: 1 });
I.writeDraft(tight, "b", "B".repeat(200), { now: 2 });
const retried = I.writeDraft(tight, "c", "C".repeat(200), { now: 3 });
ok("配额不足时淘汰最旧并重试成功", retried.ok === true, retried);

// ══════════════════════════════════════════════════════════════════════════
section("6) 存储层：孤儿标记与清理");
const s5 = createStore();
I.writeDraft(s5, "alive", "a", { now: 1 });
I.writeDraft(s5, "dead1", "b", { now: 2 });
I.writeDraft(s5, "dead2", "c", { now: 3 });
eq("空 aliveIds 时绝不动手", I.sweepOrphans(s5, [], { now: 10 }).skipped, true);
eq("空 aliveIds 后条目未变", I.listDrafts(s5).length, 3);
const mark = I.sweepOrphans(s5, ["alive"], { now: 10, ttlMs: 1000 });
eq("第一轮只标记不删", mark.marked, 2);
eq("标记后条目仍在", I.listDrafts(s5).length, 3);
ok("孤儿条目被打了 orphanAt", I.readDraft(s5, "dead1").orphanAt === 10);
eq("活着的那条没被打标", I.readDraft(s5, "alive").orphanAt, 0);
const purge = I.sweepOrphans(s5, ["alive"], { now: 10 + 1001, ttlMs: 1000 });
eq("TTL 过后被清理", purge.removed, 2);
eq("只剩活着的那条", I.listDrafts(s5).map((row) => row.sessionId), ["alive"]);

// ══════════════════════════════════════════════════════════════════════════
section("7) 闸门：镜像判定");
const M = I.decideMirror;
eq("frozen(sending) 不写", M({ enabled: true, sessionId: "s", phase: "sending", draft: "x", composing: false, prevDraft: "" }).reason, "frozen");
eq("frozen(adjudicating) 不写", M({ enabled: true, sessionId: "s", phase: "adjudicating", draft: "x", prevDraft: "" }).reason, "frozen");
eq("frozen(submitting) 不写", M({ enabled: true, sessionId: "s", phase: "submitting", draft: "x", prevDraft: "" }).reason, "frozen");
eq("composition 期间不写", M({ enabled: true, sessionId: "s", phase: "plain", draft: "nihao", composing: true, prevDraft: "" }).reason, "composing");
eq("正常输入要写", M({ enabled: true, sessionId: "s", phase: "plain", draft: "x", composing: false, prevDraft: "" }).action, "write");
eq("空转空不写", M({ enabled: true, sessionId: "s", phase: "plain", draft: "", prevDraft: "" }).reason, "blank");
eq("非空变空 → 打已消费标记", M({ enabled: true, sessionId: "s", phase: "plain", draft: "", prevDraft: "已发送" }).action, "consume");
eq("总开关关闭 → 不写", M({ enabled: false, sessionId: "s", phase: "plain", draft: "x", prevDraft: "" }).reason, "disabled");
eq("phase 未知也要按非冻结处理", I.isFrozen(undefined), false);
eq("plain 不冻结", I.isFrozen("plain"), false);
eq("claimed 不冻结", I.isFrozen("claimed"), false);
ok("sending 冻结", I.isFrozen("sending"));

// ══════════════════════════════════════════════════════════════════════════
section("8) 闸门：恢复判定（双闸门 + 不回灌）");
const R = I.decideRestore;
const record = { text: "恢复我", at: 100, cwd: "", consumedAt: 0, orphanAt: 0 };
eq("闸门二：官方有内容就不动", R({ enabled: true, sessionId: "s", phase: "plain", draft: "用户自己打的", restored: false, record }).reason, "draft-not-empty");
eq("闸门一：本页已恢复过就不再来", R({ enabled: true, sessionId: "s", phase: "plain", draft: "", restored: true, record }).reason, "already-restored");
eq("冻结态不恢复", R({ enabled: true, sessionId: "s", phase: "sending", draft: "", restored: false, record }).reason, "frozen");
eq("没有镜像记录就不动", R({ enabled: true, sessionId: "s", phase: "plain", draft: "", restored: false, record: null }).reason, "no-record");
eq("镜像为空文本也不动", R({ enabled: true, sessionId: "s", phase: "plain", draft: "", restored: false, record: { text: "  ", at: 1, consumedAt: 0, orphanAt: 0 } }).reason, "no-record");
eq("已消费的草稿不回灌", R({ enabled: true, sessionId: "s", phase: "plain", draft: "", restored: false, record: { text: "发出去的", at: 100, consumedAt: 200, orphanAt: 0 } }).reason, "consumed");
eq("正常恢复", R({ enabled: true, sessionId: "s", phase: "plain", draft: "", restored: false, record }).action, "restore");
eq("恢复带出文本", R({ enabled: true, sessionId: "s", phase: "plain", draft: "", restored: false, record }).text, "恢复我");
eq("claimed 态也允许恢复", R({ enabled: true, sessionId: "s", phase: "claimed", draft: "", restored: false, record }).action, "restore");

// 消费标记的完整链路：写入 → 发空 → 标记 → 恢复判定被跳过
const s6 = createStore();
I.writeDraft(s6, "sid", "发出去的内容", { now: 100 });
eq("标记前可恢复", R({ enabled: true, sessionId: "sid", phase: "plain", draft: "", restored: false, record: I.readDraft(s6, "sid") }).action, "restore");
I.markConsumed(s6, "sid", 200);
eq("标记后不再恢复", R({ enabled: true, sessionId: "sid", phase: "plain", draft: "", restored: false, record: I.readDraft(s6, "sid") }).reason, "consumed");
eq("标记不动原文（历史还要用）", I.readDraft(s6, "sid").text, "发出去的内容");
I.writeDraft(s6, "sid", "新写的内容", { now: 300 });
eq("再写新内容后消费标记作废", I.readDraft(s6, "sid").consumedAt, 0);

// ══════════════════════════════════════════════════════════════════════════
section("9) 写入通道：L1 优先 / L3 兜底保 view");
const s7 = createStore();
const calls = [];
const actions = {
  setDraft(text) {
    calls.push(["setDraft", text]);
  },
  persistDraft() {
    calls.push(["persistDraft"]);
  },
};
eq("L1 返回标记", I.restoreVia(actions, "sid", "hello", s7), "L1");
eq("L1 先 setDraft", calls[0], ["setDraft", "hello"]);
eq("L1 必须显式 persistDraft（immer 无变化不通知）", calls[1], ["persistDraft"]);
eq("L1 不写官方键", s7.getItem("dsh.conversation.sid"), null);

const s8 = createStore();
s8.setItem("dsh.conversation.sid", JSON.stringify({ draft: { references: [], text: "" }, view: "trajectory", viewRequest: { view: "trajectory", focus: 3 } }));
eq("L3 返回标记", I.restoreVia(null, "sid", "退回的草稿", s8), "L3");
const afterL3 = JSON.parse(s8.getItem("dsh.conversation.sid"));
eq("L3 写入 draft", afterL3.draft, "退回的草稿");
eq("L3 保住 view", afterL3.view, "trajectory");
eq("L3 保住 viewRequest", afterL3.viewRequest, { view: "trajectory", focus: 3 });

const s9 = createStore();
s9.setItem("dsh.conversation.sid", "{坏 JSON");
eq("L3 遇坏 JSON 按空基底", I.restoreVia(null, "sid", "x", s9), "L3");
eq("L3 不把坏值留在盘上", JSON.parse(s9.getItem("dsh.conversation.sid")).draft, "x");

// ══════════════════════════════════════════════════════════════════════════
section("10) 清理入口");
const s10 = createStore();
I.writeDraft(s10, "a", "1", { now: 1 });
I.writeDraft(s10, "b", "2", { now: 2 });
I.writeConfig(s10, { enabled: true });
ok("清理前有键", I.pluginKeys(s10).length > 0);
const removed = I.clearAll(s10);
ok("清理返回删除数量", removed >= 3, { removed });
eq("清理后命名空间为空", I.pluginKeys(s10), []);
eq("删除单条只删自己", (() => {
  const s = createStore();
  I.writeDraft(s, "a", "1", { now: 1 });
  I.writeDraft(s, "b", "2", { now: 2 });
  I.removeDraft(s, "a");
  return I.listDrafts(s).map((row) => row.sessionId);
})(), ["b"]);

// ══════════════════════════════════════════════════════════════════════════
console.log("\n────────────────────────────────────────────");
if (failures.length === 0) {
  console.log("全部通过：" + passed + " 项");
  process.exit(0);
}
console.log("失败 " + failures.length + " 项 / 通过 " + passed + " 项：");
for (const failure of failures) console.log("  - " + failure.name + (failure.detail === undefined ? "" : "  → " + JSON.stringify(failure.detail)));
process.exit(1);
