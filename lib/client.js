/**
 * dsh-composer-draft-keeper 前端半：把没发出去的草稿镜像到自己的命名空间，
 * 切会话 / 强杀重启之后放回输入框。
 * 为什么是「镜像 + 一次性恢复」：官方 persist 同步写盘（§3.1.3），外部直写官方键
 * 会被下一个按键整键覆盖 —— 官方键唯一合法写者是官方内存态。
 * 我们只在「恢复」那一刻驱动它（L1）。A 存储层 / B 同步层 / C UI 层。*/
window.__ModuleLoader__.load({
  id: "dsh-composer-draft-keeper",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    const h = react.createElement;

    // ══════ A · 存储层（纯函数，可注入假 store） ══════

    /** 插件命名空间；官方键 dsh.conversation.<sid> 永不长期占用。 */
    const NS = "dsh.draft-keeper.v1";
    const KEY = {
      draft: (sid) => NS + ".drafts." + sid,
      history: (sid) => NS + ".history." + sid,
      meta: NS + ".meta",
      config: NS + ".config",
    };
    const DEFAULTS = {
      enabled: true,
      maxHistory: 10,
      capacityBytes: 262144,
      orphanTtlMs: 604800000, // 会话没了 → 标孤儿 → 7 天后清
      debounceMs: 300,
      retryDelayMs: 250,
    };

    let consoleBroken = false;

    /** 唯一降级出口：宿主 API 缺失都走这里，绝不抛出去。 */
    function dbg(message, detail) {
      if (consoleBroken) return;
      try {
        const fn = typeof console.debug === "function" ? console.debug : console.log;
        if (typeof fn === "function") fn.call(console, "[draft-keeper] " + message, detail === undefined ? "" : detail);
      } catch (_e) {
        consoleBroken = true;
      }
    }

    let cachedStore;
    let storeResolved = false;

    /** 探一次 setItem 而非只看 typeof：隐私模式写入必抛，那整层降级为空操作。 */
    function defaultStore() {
      if (storeResolved) return cachedStore;
      storeResolved = true;
      cachedStore = null;
      try {
        if (typeof localStorage !== "undefined" && localStorage) {
          localStorage.setItem(NS + ".probe", "1");
          localStorage.removeItem(NS + ".probe");
          cachedStore = localStorage;
        }
      } catch (error) {
        dbg("localStorage 不可写，镜像降级为空操作", error);
      }
      return cachedStore;
    }

    function pick(env) {
      if (env && typeof env.getItem === "function" && typeof env.setItem === "function") return env;
      return defaultStore();
    }

    /** UTF-8 字节：LevelDB 里 key 也占空间（§2.4）。 */
    function utf8Bytes(text) {
      if (typeof text !== "string" || text === "") return 0;
      try {
        if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
      } catch (_e) {}
      let total = 0;
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        total += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? 4 : code >= 0xdc00 && code <= 0xdfff ? 0 : 3;
      }
      return total;
    }

    /** 空白含 NUL / 零宽：无可见内容，存下来只显示空行。 */
    function isBlank(text) {
      if (typeof text !== "string") return true;
      return /^[\s\u0000\u200b-\u200f\u2028\u2029\ufeff]*$/.test(text);
    }

    function isQuotaError(error) {
      if (!error) return false;
      const name = String(error.name || "");
      return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22 || error.code === 1014;
    }

    function readJSON(env, key, fallback) {
      const store = pick(env);
      if (!store) return fallback;
      try {
        const raw = store.getItem(key);
        if (typeof raw !== "string" || raw === "") return fallback;
        const parsed = JSON.parse(raw);
        return parsed == null ? fallback : parsed;
      } catch (error) {
        // 坏 JSON 按空处理：坏值留在盘上才是灾难（官方 rehydrate 也不清它）
        dbg("读取 " + key + " 失败，按空处理", error);
        return fallback;
      }
    }

    /** {ok, error}：要区分配额问题才能决定是否淘汰重试。 */
    function writeJSON(env, key, value) {
      const store = pick(env);
      if (!store) return { ok: false, error: null };
      try {
        store.setItem(key, JSON.stringify(value));
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error };
      }
    }

    function pluginKeys(env) {
      const store = pick(env);
      const keys = [];
      if (!store) return keys;
      try {
        const length = typeof store.length === "number" ? store.length : 0;
        for (let i = 0; i < length; i += 1) {
          const key = store.key(i);
          if (typeof key === "string" && key.indexOf(NS + ".") === 0) keys.push(key);
        }
      } catch (error) {
        dbg("枚举 storage key 失败，按空列表处理", error);
      }
      return keys;
    }

    function usageBytes(env) {
      const store = pick(env);
      if (!store) return 0;
      let total = 0;
      for (const key of pluginKeys(store)) {
        let value = "";
        try {
          value = store.getItem(key) || "";
        } catch (_e) {
          value = "";
        }
        total += utf8Bytes(key) + utf8Bytes(value);
      }
      return total;
    }

    /** 统一构造镜像 payload：只取已知字段（row 来自 listDrafts，带 sessionId 等）。 */
    const rowPayload = (row, extra) =>
      Object.assign({ text: row.text, at: row.at, cwd: row.cwd, consumedAt: row.consumedAt, orphanAt: row.orphanAt, inflight: row.inflight || "" }, extra);

    /** 返回 null = 没有可信记录，与「记录为空文本」严格区分。 */
    function readDraft(env, sid) {
      const store = pick(env);
      if (!store || typeof sid !== "string" || sid === "") return null;
      const row = readJSON(store, KEY.draft(sid), null);
      if (!row || typeof row !== "object" || typeof row.text !== "string") return null;
      const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
      return {
        text: row.text,
        at: num(row.at),
        cwd: typeof row.cwd === "string" ? row.cwd : "",
        consumedAt: num(row.consumedAt),
        orphanAt: num(row.orphanAt),
        inflight: typeof row.inflight === "string" ? row.inflight : "",
      };
    }

    function listDrafts(env) {
      const store = pick(env);
      if (!store) return [];
      const prefix = NS + ".drafts.";
      const rows = [];
      for (const key of pluginKeys(store)) {
        if (key.indexOf(prefix) !== 0) continue;
        const sid = key.slice(prefix.length);
        const row = readDraft(store, sid);
        if (row !== null) rows.push(Object.assign({ sessionId: sid }, row));
      }
      rows.sort((a, b) => b.at - a.at); // 最新的在前
      return rows;
    }

    function readHistory(env, sid) {
      const store = pick(env);
      if (!store) return [];
      const list = readJSON(store, KEY.history(sid), []);
      if (!Array.isArray(list)) return [];
      return list
        .filter((row) => row && typeof row.text === "string" && !isBlank(row.text))
        .map((row) => ({ text: row.text, at: typeof row.at === "number" ? row.at : 0 }));
    }

    function pushHistory(env, sid, text, at, max) {
      const store = pick(env);
      if (!store || typeof text !== "string" || isBlank(text)) return 0;
      const limit = typeof max === "number" && max > 0 ? max : DEFAULTS.maxHistory;
      const rows = readHistory(store, sid);
      if (rows.length > 0 && rows[0].text === text) rows[0].at = at; // 连续同内容不重复占槽
      else rows.unshift({ text: text, at: at });
      while (rows.length > limit) rows.pop();
      writeJSON(store, KEY.history(sid), rows);
      return rows.length;
    }

    function removeDraft(env, sid) {
      const store = pick(env);
      if (!store || typeof sid !== "string" || sid === "") return false;
      try {
        store.removeItem(KEY.draft(sid));
        store.removeItem(KEY.history(sid));
        return true;
      } catch (error) {
        dbg("删除镜像失败", error);
        return false;
      }
    }

    function clearAll(env) {
      const store = pick(env);
      if (!store) return 0;
      let removed = 0;
      for (const key of pluginKeys(store)) {
        try {
          store.removeItem(key);
          removed += 1;
        } catch (_e) {
        }
      }
      return removed;
    }

    function readConfig(env) {
      const store = pick(env);
      const raw = store ? readJSON(store, KEY.config, null) : null;
      const config = Object.assign({}, DEFAULTS);
      if (!raw || typeof raw !== "object") return config;
      for (const field of Object.keys(DEFAULTS)) {
        const value = raw[field];
        const want = typeof DEFAULTS[field];
        if (want === "boolean" && typeof value === "boolean") config[field] = value;
        else if (want === "number" && typeof value === "number" && isFinite(value) && value > 0) config[field] = value;
      }
      return config;
    }

    /** 回读而非回传 merge：非法值写入后立刻被 DEFAULTS 兜回。 */
    function writeConfig(env, patch) {
      const store = pick(env);
      writeJSON(store, KEY.config, Object.assign(readConfig(store), patch || {}));
      return readConfig(store);
    }

    function writeMeta(env, now) {
      const store = pick(env);
      if (!store) return null;
      const at = typeof now === "number" ? now : Date.now();
      const prev = readJSON(store, KEY.meta, null);
      const meta = { version: 1, totalBytes: usageBytes(store), installedAt: prev && typeof prev.installedAt === "number" ? prev.installedAt : at, updatedAt: at };
      writeJSON(store, KEY.meta, meta);
      return meta;
    }

    /** 淘汰最旧一条，但绝不淘汰 keepSid。 */
    function evictOldest(env, keepSid) {
      const store = pick(env);
      if (!store) return null;
      const rows = listDrafts(store).filter((row) => row.sessionId !== keepSid);
      if (rows.length === 0) return null;
      const oldest = rows[rows.length - 1];
      removeDraft(store, oldest.sessionId);
      return oldest.sessionId;
    }

    function enforceCapacity(env, keepSid, limit) {
      const store = pick(env);
      if (!store) return 0;
      const cap = typeof limit === "number" && limit > 0 ? limit : DEFAULTS.capacityBytes;
      let removed = 0;
      // 上限 64 轮：配置异常也不能卡住渲染线程
      for (let i = 0; i < 64 && usageBytes(store) > cap; i += 1) {
        if (evictOldest(store, keepSid) === null) break;
        removed += 1;
      }
      return removed;
    }

    /** 唯一写入口。空白拒绝；配额爆炸淘汰最旧重试一次，再失败静默放弃。 */
    function writeDraft(env, sid, text, opts) {
      const store = pick(env);
      const o = opts || {};
      if (!store) return { ok: false, reason: "no-storage" };
      if (typeof sid !== "string" || sid === "") return { ok: false, reason: "no-session" };
      if (typeof text !== "string") return { ok: false, reason: "bad-text" };
      if (isBlank(text)) return { ok: false, reason: "blank" };
      const at = typeof o.now === "number" ? o.now : Date.now();
      const prev = readDraft(store, sid);
      const payload = {
        text,
        at,
        cwd: typeof o.cwd === "string" ? o.cwd : prev ? prev.cwd : "",
        consumedAt: 0, // 有新内容 = 上一次的「已消费」标记作废
        orphanAt: 0, // 有新内容说明会话还活着
        inflight: "", // 同理：上一轮的「在飞」标记作废
      };
      let result = writeJSON(store, KEY.draft(sid), payload);
      let evicted = null;
      if (!result.ok) {
        evicted = evictOldest(store, sid);
        result = writeJSON(store, KEY.draft(sid), payload);
        if (!result.ok) {
          dbg("镜像写入失败（淘汰后仍失败），本轮静默放弃", result.error);
          return { ok: false, reason: isQuotaError(result.error) ? "quota" : "write-failed" };
        }
      }
      pushHistory(store, sid, text, at, o.maxHistory);
      writeMeta(store, at);
      return { ok: true, evicted: evicted, trimmed: enforceCapacity(store, sid, o.capacityBytes) };
    }

    /**
     * 打「已消费」标记：draft 由非空变空 → 这条不该再被恢复（回灌 P1 正解）。
     * 只打标记不动 text（历史还要用），恢复判定靠 consumedAt >= at 跳过。
     */
    function markConsumed(env, sid, now) {
      const store = pick(env);
      if (!store || typeof sid !== "string" || sid === "") return false;
      const row = readDraft(store, sid);
      if (row === null) return false;
      return writeJSON(store, KEY.draft(sid), rowPayload(row, { consumedAt: typeof now === "number" ? now : Date.now() })).ok;
    }

    /**
     * 打「在飞」标记：冻结态且草稿非空时先记一笔 —— 发送成功与切走/崩溃撞同一拍，
     * 组件看不到 draft 变空 → consumedAt 永远 0 → 下次挂载把刚发出去的话塞回输入框（P0）。
     * 失败路径不必管：draft 非空时闸门二不恢复，再输入时 writeDraft 把标记归零。
     */
    function markInFlight(env, sid, text) {
      const store = pick(env);
      if (!store || typeof sid !== "string" || sid === "" || typeof text !== "string" || isBlank(text)) return false;
      const row = readDraft(store, sid);
      if (row === null || row.text !== text) return false; // 只标记"确实是这条内容在发"
      return writeJSON(store, KEY.draft(sid), rowPayload(row, { inflight: text })).ok;
    }

    /**
     * 孤儿清理。aliveIds 为空时什么都不做 —— 列表未 hydrate 时全量标记会误删全部。
     * 标记会把用户全部草稿判成孤儿，那是最坏的一种数据丢失。
     */
    function sweepOrphans(env, aliveIds, opts) {
      const store = pick(env);
      const o = opts || {};
      const now = typeof o.now === "number" ? o.now : Date.now();
      const ttl = typeof o.ttlMs === "number" && o.ttlMs > 0 ? o.ttlMs : DEFAULTS.orphanTtlMs;
      const alive = {};
      const ids = Array.isArray(aliveIds) ? aliveIds : [];
      for (const id of ids) if (typeof id === "string" && id !== "") alive[id] = true;
      const summary = { aliveCount: ids.length, marked: 0, removed: 0, skipped: ids.length === 0 };
      if (!store || summary.skipped) return summary;
      for (const row of listDrafts(store)) {
        if (alive[row.sessionId] === true) continue;
        if (row.orphanAt === 0) {
           // 第一次发现不在会话列表：只标记不删（可能只是这轮没列出）
          writeJSON(store, KEY.draft(row.sessionId), rowPayload(row, { orphanAt: now }));
          summary.marked += 1;
        } else if (now - row.orphanAt >= ttl) {
          removeDraft(store, row.sessionId);
          summary.removed += 1;
        }
      }
      return summary;
    }

    function officialKey(sid) {
      return "dsh.conversation." + sid;
    }

    /**
     * L3 兜底：读-改-写官方键，必须保住 view / viewRequest（只写 {draft} 会清视图偏好）。
     * 视图偏好，下次进会话被强行拉回对话视图（impl-contract §3.6）。
     */
    function writeOfficialDraftRaw(env, sid, text) {
      const store = pick(env);
      if (!store || typeof sid !== "string" || sid === "" || typeof text !== "string") return false;
      const key = officialKey(sid);
      let base = {};
      try {
        const raw = store.getItem(key);
        if (typeof raw === "string" && raw !== "") {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed;
        }
      } catch (_e) {
        base = {}; // 坏 JSON 按空基底，别把坏值留在盘上
      }
      try {
        store.setItem(key, JSON.stringify(Object.assign({}, base, { draft: text })));
        return true;
      } catch (error) {
        dbg("L3 写官方键失败", error);
        return false;
      }
    }

    // ══════ B · 同步层（闸门纯函数，组件只接线） ══════

    /** 冻结态：编辑器只读，此时写草稿会跟官方抢状态（§3.2.3）。 */
    const FROZEN_PHASES = ["adjudicating", "submitting", "sending"];

    function isFrozen(phase) {
      return FROZEN_PHASES.indexOf(phase) >= 0;
    }

    /** 这一帧要不要写镜像：write（落盘）／consume（变空 → 打标记）／skip。 */
    function decideMirror(input) {
      const s = input || {};
      if (s.enabled === false) return { action: "skip", reason: "disabled" };
      if (typeof s.sessionId !== "string" || s.sessionId === "") return { action: "skip", reason: "no-session" };
      if (isFrozen(s.phase)) return { action: "skip", reason: "frozen" };
      if (s.composing === true) return { action: "skip", reason: "composing" };
      if (typeof s.draft !== "string") return { action: "skip", reason: "unknown-draft" };
      if (isBlank(s.draft)) {
        const prev = typeof s.prevDraft === "string" ? s.prevDraft : "";
        return isBlank(prev) ? { action: "skip", reason: "blank" } : { action: "consume", reason: "emptied" };
      }
      return { action: "write", reason: "ok" };
    }

    /**
     * 这一帧要不要恢复 —— 双闸门 + 消费标记。闸门一：本 session 本页只恢复一次；
     * 闸门二：官方 draft 非空就不动（首次安装不吃用户已有草稿）。★判据只能是「draft
     * 为空且镜像有值」，不能拿「sessionId 变了」当判据（会复用空白会话 id）。
     * createInWorkspace() 会复用空白会话的同一 id（impl-contract §3.4.2）。
     */
    function decideRestore(input) {
      const s = input || {};
      if (s.enabled === false) return { action: "skip", reason: "disabled" };
      if (typeof s.sessionId !== "string" || s.sessionId === "") return { action: "skip", reason: "no-session" };
      if (isFrozen(s.phase)) return { action: "skip", reason: "frozen" };
      if (typeof s.draft !== "string") return { action: "skip", reason: "unknown-draft" };
      if (s.draft !== "") return { action: "skip", reason: "draft-not-empty" };
      if (s.restored === true) return { action: "skip", reason: "already-restored" };
      const row = s.record;
      if (!row || typeof row.text !== "string" || isBlank(row.text)) return { action: "skip", reason: "no-record" };
      if (row.consumedAt > 0 && row.consumedAt >= row.at) return { action: "skip", reason: "consumed" };
      // 「在飞」：这条内容正在发送，绝不能再塞回输入框
      if (row.inflight !== "" && row.inflight === row.text) return { action: "skip", reason: "inflight" };
      return { action: "restore", reason: "ok", text: row.text };
    }

    /**
     * 驱动官方：L1 首选 / L3 兜底。L1 之后必须再调一次 persistDraft —— 官方 update
     * 走 immer produce，内容无变化返回原引用，zustand 的 Object.is 守卫不通知
     * → 不写盘（impl-contract §3.1.3）。
     */
    function restoreVia(inputActions, sid, text, env) {
      try {
        if (inputActions && typeof inputActions.setDraft === "function") {
          inputActions.setDraft(text);
          if (typeof inputActions.persistDraft === "function") inputActions.persistDraft();
          return "L1";
        }
      } catch (error) {
        dbg("L1 setDraft 失败，回落 L3", error);
      }
      const wrote = writeOfficialDraftRaw(env, sid, text);
      dbg("L1 不可用，已走 L3 直写官方键", { sessionId: sid, wrote: wrote });
      return wrote ? "L3" : "none";
    }

    /** composition 是文档级事件，跟会话无关，所以放模块级。 */
    const composing = { depth: 0 };

    /**
     * 可选 selector hook 的安全包装（宿主 uiSession.provide 把标准源映射成
     * props.useInput / props.useSessions，impl-contract §3.5.3）。它们可能版本缺席，
     * 所以首帧锁死「有没有」之后不再改分支：hook 次数必须恒定，条件调 hook 会崩掉
     * 整个输入框子树（历史 P0：RangeError: Invalid array length）。
     */
    function useStableHook(hookProp, selector) {
      const gate = react.useRef(null);
      if (gate.current === null) gate.current = { usable: typeof hookProp === "function" };
      return gate.current.usable ? hookProp(selector) : undefined;
    }

    const selDraft = (s) => (s && typeof s === "object" ? s.draft : undefined);
    const selPhase = (s) => (s && typeof s === "object" ? s.phase : undefined);
    const selRev = (s) => (s && typeof s === "object" ? s.draftRev : undefined);
    // 拼字符串而非数组：数组每次新建引用会让宿主 selector 每帧都认为变了
    const selIds = (s) => (s && typeof s === "object" && s.byId && typeof s.byId === "object" ? Object.keys(s.byId).join("\u0000") : "");
    const selCwd = (sid) => (s) => {
      if (!s || typeof s !== "object" || !s.byId || typeof sid !== "string" || sid === "") return undefined;
      const row = s.byId[sid];
      return row && typeof row.cwd === "string" ? row.cwd : undefined;
    };

    /**
     * 零渲染观测组件，挂 conversation.input.dock（list 槽，scope: session）。
     * 为什么非它不可：settings.section 的 props 里没有 sessionId / inputActions /
     * useInput，只有 session 作用域槽拿得到这三件套（impl-contract §3.5.1）。
     */
    function DraftKeeper(props) {
      const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
      const inputActions = props.inputActions;

      // 观测：全部无条件调用、顺序固定
      const draft = useStableHook(props.useInput, selDraft);
      const phase = useStableHook(props.useInput, selPhase);
      const rev = useStableHook(props.useInput, selRev);
      const sessionIds = useStableHook(props.useSessions, selIds);
      const cwd = useStableHook(props.useSessions, selCwd(sessionId));

      const [config] = react.useState(() => readConfig(undefined));

      // 全部可变量收在一个 ref 里：hook 次数越少越不容易踩 hook 法规，声明块也短
      const R = react.useRef(null);
      if (R.current === null) {
        // restored = 闸门一：本页每 session 只恢复一次
        R.current = { restored: {}, timer: null, immediate: false, prevDraft: typeof draft === "string" ? draft : "", sawSending: false, verify: null, latest: null };
      }
      R.current.latest = { sessionId: sessionId, draft: draft, cwd: cwd, phase: phase };

      /** 立刻落盘 pending 的最后一次内容（卸载 / compositionend 用）。 */
      const usable = (x) => x !== null && typeof x.draft === "string" && !isBlank(x.draft) && !isFrozen(x.phase);

      function flushLatest() {
        if (R.current.timer !== null) {
          clearTimeout(R.current.timer);
          R.current.timer = null;
        }
        const last = R.current.latest;
        if (!usable(last) || typeof last.sessionId !== "string" || last.sessionId === "") return false;
        return writeDraft(undefined, last.sessionId, last.draft, Object.assign({ cwd: last.cwd }, config)).ok;
      }

      // 1) 镜像：草稿变化 → 写自己的命名空间（永不长期写官方键）
      react.useEffect(() => {
        if (phase === "sending") R.current.sawSending = true;
        // 冻结态且草稿非空：先打在飞标记，别等看到 draft 变空（那拍可能永远不来）
        if (isFrozen(phase) && typeof draft === "string" && sessionId !== "") markInFlight(undefined, sessionId, draft);
        if (!config.enabled || sessionId === "") return undefined;
        if (typeof draft !== "string") return undefined; // hook 缺席 / 快照未知，什么都不做

        const decision = decideMirror({
          enabled: config.enabled,
          sessionId,
          phase,
          draft,
          composing: composing.depth > 0,
          prevDraft: R.current.prevDraft,
        });
        R.current.prevDraft = draft;
        if (decision.action === "consume") {
          markConsumed(undefined, sessionId, Date.now());
          return undefined;
        }
        if (decision.action !== "write") return undefined;

        // compositionend 之后不再多等 300ms（这一帧 draft 已是最终内容）
        const delay = R.current.immediate ? 0 : Math.max(300, config.debounceMs);
        R.current.immediate = false;
        if (R.current.timer !== null) clearTimeout(R.current.timer);
        R.current.timer = setTimeout(() => {
          R.current.timer = null;
          const last = R.current.latest;
          if (!usable(last) || last.sessionId !== sessionId) return;
          writeDraft(undefined, last.sessionId, last.draft, Object.assign({ cwd: last.cwd }, config));
        }, delay);
        return undefined;
      }, [sessionId, draft, rev, phase, cwd, config.enabled, config.debounceMs, config.maxHistory, config.capacityBytes]);

      // 2) 恢复：双闸门 + 一次性
      react.useEffect(() => {
        const decision = decideRestore({
          enabled: config.enabled,
          sessionId,
          phase,
          draft,
          restored: R.current.restored[sessionId] === true,
          record: sessionId === "" ? null : readDraft(undefined, sessionId),
        });
        if (decision.action !== "restore") {
          // 终态失败要记住，否则每帧重复读盘；frozen / no-session / disabled 不记
          if (["no-record", "draft-not-empty", "consumed", "already-restored", "unknown-draft"].indexOf(decision.reason) >= 0) {
            R.current.restored[sessionId] = true;
          }
          return undefined;
        }
        R.current.restored[sessionId] = true; // 先占位，防重入
        if (restoreVia(inputActions, sessionId, decision.text, undefined) !== "L1") return undefined;
        // U6 兜底：persistDraft 在官方 bindDraftPersistence 之前会空转。只在「确实没写
        // 进去且没发生过发送」时补一次 —— 发生过 sending 绝不回灌。
        if (R.current.verify !== null) clearTimeout(R.current.verify);
        R.current.verify = setTimeout(() => {
          R.current.verify = null;
          const last = R.current.latest;
          if (!last || last.sessionId !== sessionId) return;
          if (R.current.sawSending || isFrozen(last.phase)) return;
          if (typeof last.draft !== "string" || last.draft !== "") return; // 已经进去了
          restoreVia(inputActions, sessionId, decision.text, undefined);
        }, Math.max(100, config.retryDelayMs));
        return undefined;
      }, [sessionId, draft, phase, config.enabled, config.retryDelayMs, inputActions]);

      // 3) 输入法保护（§6A）：composition 期间不落盘，end 之后补存一次。
      react.useEffect(() => {
        if (typeof document === "undefined" || typeof document.addEventListener !== "function") return undefined;
        const onStart = () => {
          composing.depth += 1;
        };
        const onEnd = () => {
          if (composing.depth > 0) composing.depth -= 1;
          R.current.immediate = true; // 下一帧 draft 变化直接落盘（delay=0）
          // 不在 end 时同步 flushLatest：那一拍 latest 还是半截拼音，同步写会把 "nih"
          // 存进镜像并永久占掉一个历史槽位。推到下一 tick 读终值。
          setTimeout(flushLatest, 0);
        };
        try {
          document.addEventListener("compositionstart", onStart, true);
          document.addEventListener("compositionend", onEnd, true);
        } catch (error) {
          dbg("注册 composition 监听失败，输入法保护降级", error);
          return undefined;
        }
        return () => {
          try {
            document.removeEventListener("compositionstart", onStart, true);
            document.removeEventListener("compositionend", onEnd, true);
          } catch (_e) {}
          composing.depth = 0;
        };
      }, []);

      // 4) 卸载补写：打完字立刻切走时，debounce 窗口里的最后一次不能丢
      react.useEffect(
        () => () => {
          if (R.current.verify !== null) {
            clearTimeout(R.current.verify);
            R.current.verify = null;
          }
          flushLatest();
        },
        []
      );

      // 5) 孤儿清理（低频；拿不到会话清单绝不动手）
      react.useEffect(() => {
        if (!config.enabled || typeof sessionIds !== "string" || sessionIds === "") return undefined;
        const ids = sessionIds.split("\u0000");
        const run = () => {
          try {
            sweepOrphans(undefined, ids, { ttlMs: config.orphanTtlMs });
          } catch (error) {
            dbg("孤儿清理失败（不影响输入）", error);
          }
        };
        const first = setTimeout(run, 5000);
        const every = setInterval(run, 600000);
        return () => {
          clearTimeout(first);
          clearInterval(every);
        };
      }, [sessionIds, config.enabled, config.orphanTtlMs]);

      return null; // 零渲染：唯一目的就是拿到 session 作用域的 props
    }

    // ══════ C · UI 层（settings.section 一张卡） ══════

    const CSS = `
.dsh-dk-card{display:flex;flex-direction:column;gap:10px}
.dsh-dk-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-dk-hint,.dsh-dk-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.dsh-dk-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto}
.dsh-dk-item{border:1px solid var(--dsw-alias-border-l1);padding:8px 10px}
.dsh-dk-item-head{display:flex;align-items:center;gap:8px;justify-content:space-between}
.dsh-dk-text{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word;margin:4px 0 0}
.dsh-dk-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
.dsh-dk-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-dk-danger{color:var(--dsw-alias-state-error-primary)}
`;

    let cssInjected = false;

    function injectCss() {
      if (cssInjected) return;
      cssInjected = true;
      try {
        if (typeof document === "undefined" || !document.head) return;
        if (document.getElementById("dsh-dk-css") !== null) return;
        const tag = document.createElement("style");
        tag.id = "dsh-dk-css";
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (error) {
        dbg("注入样式失败（非致命）", error);
      }
    }

    const fmtTime = (at) => {
      if (typeof at !== "number" || at <= 0) return "—";
      const d = new Date(at), p = (n) => String(n).padStart(2, "0");
      return d.getMonth() + 1 + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    };

    const fmtBytes = (b) => ((b = typeof b === "number" && b > 0 ? b : 0) < 1024 ? b + " B" : (b / 1024).toFixed(1) + " KB");

    const preview = (t) => ((t = String(t).replace(/\s+/g, " ")), t.length > 90 ? t.slice(0, 90) + "…" : t);

    function SettingsCard() {
      const [tick, setTick] = react.useState(0);
      const [config, setConfig] = react.useState(() => readConfig(undefined));
      const [expanded, setExpanded] = react.useState("");
      const [confirming, setConfirming] = react.useState(false);
      const refresh = react.useCallback(() => setTick((n) => n + 1), []);

      react.useEffect(() => {
        injectCss();
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        const onStorage = (event) => {
          if (!event || typeof event.key !== "string" || event.key.indexOf(NS) === 0) refresh();
        };
        try {
          window.addEventListener("storage", onStorage);
        } catch (error) {
          dbg("监听 storage 失败，多窗口刷新降级", error);
          return undefined;
        }
        return () => {
          try {
            window.removeEventListener("storage", onStorage);
          } catch (_e) {}
        };
      }, [refresh]);

      // tick 是刻意的依赖：写操作后靠它强制重算（存储层是同步纯函数，无订阅）
      const rows = react.useMemo(() => listDrafts(undefined), [tick]);
      const total = react.useMemo(() => usageBytes(undefined), [tick]);
      const patch = (fields) => {
        setConfig(writeConfig(undefined, fields));
        refresh();
      };

      const num = (k, min, max, toValue, fromValue) =>
        h("input", {
          key,
          type: "number",
          min,
          max,
          className: "dsh-dk-num",
          value: fromValue,
          onChange: (event) => {
            const raw = parseInt(event.target.value, 10);
            if (isFinite(raw) && raw >= min && raw <= max) patch(toValue(raw));
          },
        });

      const parts = [
        h(
          "label",
          { key: "toggle", className: "dsh-dk-row" },
          h("input", { type: "checkbox", checked: config.enabled !== false, onChange: (e) => patch({ enabled: e.target.checked }) }),
          h("span", null, "启用草稿保留（关闭只停镜像）")
        ),
        h(
          "p",
          { key: "stat", className: "dsh-dk-hint" },
          rows.length + " 条草稿 · 占用 " + fmtBytes(total) + " / 上限 " + fmtBytes(config.capacityBytes) + " · 每会话保留最近 " + config.maxHistory + " 条历史"
        ),
        h(
          "div",
          { key: "limits", className: "dsh-dk-row" },
          h("span", { className: "dsh-dk-hint" }, "历史条数"),
          num("hist", 1, 100, (v) => ({ maxHistory: v }), config.maxHistory),
          h("span", { className: "dsh-dk-hint" }, "容量上限(KB)"),
          num("cap", 16, 8192, (v) => ({ capacityBytes: v * 1024 }), Math.round(config.capacityBytes / 1024))
        ),
      ];

      if (rows.length === 0) {
        parts.push(h("p", { key: "empty", className: "dsh-dk-hint" }, "还没有保留中的草稿。"));
      } else {
        parts.push(
          h(
            "ul",
            { key: "list", className: "dsh-dk-list" },
            rows.map((row) => {
              const open = expanded === row.sessionId;
              const history = open ? readHistory(undefined, row.sessionId) : [];
              return h(
                "li",
                { key: row.sessionId, className: "dsh-dk-item" },
                h(
                  "div",
                  { className: "dsh-dk-item-head" },
                  h(
                    "span",
                    { className: "dsh-dk-meta", title: row.sessionId },
                    (row.cwd ? row.cwd + " · " : "") + fmtTime(row.at) + (row.orphanAt > 0 ? " · 会话已不存在" : "")
                  ),
                  h(
                    "span",
                    { className: "dsh-dk-row" },
                    h("button", { type: "button", className: "dsh-dk-btn", onClick: () => setExpanded(open ? "" : row.sessionId) }, open ? "收起" : "历史"),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "dsh-dk-btn dsh-dk-danger",
                        onClick: () => {
                          removeDraft(undefined, row.sessionId);
                          refresh();
                        },
                      },
                      "删除"
                    )
                  )
                ),
                h("p", { className: "dsh-dk-text" }, preview(row.text)),
                open
                  ? h(
                      "ul",
                      { className: "dsh-dk-hist" },
                      history.length === 0
                        ? h("li", null, "（无历史）")
                        : history.map((entry, i) => h("li", { key: String(i) }, fmtTime(entry.at) + " · " + preview(entry.text)))
                    )
                  : null
              );
            })
          )
        );
      }

      parts.push(
        h(
          "div",
          { key: "clear", className: "dsh-dk-row" },
          confirming
            ? h(
                "span",
                { className: "dsh-dk-row" },
                h("span", { className: "dsh-dk-hint" }, "确认清空全部 " + rows.length + " 条镜像？官方键不受影响。"),
                h(
                  "button",
                  {
                    type: "button",
                    className: "dsh-dk-btn dsh-dk-danger",
                    onClick: () => {
                      clearAll(undefined);
                      setConfirming(false);
                      refresh();
                    },
                  },
                  "确认清空"
                ),
                h("button", { type: "button", className: "dsh-dk-btn", onClick: () => setConfirming(false) }, "取消")
              )
            : h("button", { type: "button", className: "dsh-dk-btn", disabled: rows.length === 0, onClick: () => setConfirming(true) }, "一键清空")
        ),
        h(
          "p",
          { key: "foot", className: "dsh-dk-hint" },
          "草稿只存在本机存储，不联网不上传。卸载后官方草稿（dsh.conversation.*）原样保留，镜像可在此清空。"
        )
      );

      return h("div", { className: "dsh-dk-card" }, parts);
    }

    // ══════ 注册 ══════

    const inject = ["slots"];

    function apply(ctx) {
      let slots;
      try {
        slots = typeof ctx.get === "function" ? ctx.get("slots") : undefined;
      } catch (error) {
        dbg("取 slots 服务失败，本插件不注册 UI", error);
        return;
      }
      if (!slots || typeof slots.register !== "function") {
        dbg("宿主没有 slots 服务，草稿保留停用（不影响官方输入框）");
        return;
      }
      injectCss();
      const renderDock = (props) => h(DraftKeeper, props);

      // 观测点 conversation.input.dock（list 槽，scope session）：list 槽只需 id（缺则抛
      // `requires options.id`）；只有 chain 槽才要 select，故补 select 放在注册失败分支 ——
      // 无条件给 select 反而危险：list 槽拿它当条目时，null 就永不挂载。
      const DOCK = { name: "conversation.input.dock", id: "dsh-composer-draft-keeper-dock", order: 100 };
      try {
        slots.inject("conversation.input.dock", () => {
          try {
            return slots.register(DOCK, renderDock);
          } catch (error) {
            if (/select/i.test(String((error && error.message) || ""))) return slots.register({ ...DOCK, select: () => null }, renderDock);
            dbg("conversation.input.dock 注册失败", error);
            return undefined;
          }
        });
      } catch (error) {
        dbg("conversation.input.dock 注入失败", error);
      }

      // 唯一可见 UI：设置页一张卡（UI 面积最小化，§12.2）
      try {
        slots.inject("settings.section", () =>
          slots.register({ name: "settings.section", id: "dsh-composer-draft-keeper-settings", order: 40, label: "草稿保留" }, () => h(SettingsCard))
        );
      } catch (error) {
        dbg("settings.section 注册失败", error);
      }
    }

    exports.inject = inject;
    exports.apply = apply;

    // 测试钩子：验证员在 node 里直接测存储层与闸门。不可枚举，不影响宿主导出面。
    Object.defineProperty(exports, "__internals", {
      value: {
        NS, KEY, utf8Bytes,
        isBlank, isQuotaError, isFrozen, decideMirror, decideRestore,
        restoreVia, pluginKeys, usageBytes, readDraft,
        writeDraft, markConsumed, markInFlight, listDrafts, readHistory,
        removeDraft, clearAll, readConfig, writeConfig, writeMeta,
        enforceCapacity, sweepOrphans,
        writeOfficialDraftRaw,
      },
      enumerable: false,
    });

    return module.exports;
  },
});
