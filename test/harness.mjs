/**
 * 假宿主环境：在纯 node 里加载 DSH 前端插件 `lib/client.js`。
 *
 * 设计原则（为什么这么写）：
 *  1. **断言建立在行为上，不建立在自述上。** 我们不相信任何 `__internals` 口头契约：
 *     凡是"谁写了 localStorage"、"谁调了官方 API"、"谁被渲染了几次"，全部由假宿主留痕。
 *     插件只要不真的走 L1（inputActions.setDraft / persistDraft），测试就看不见官方输入框变化 → FAIL。
 *  2. **官方持久化语义必须照抄真的。** impl-contract §3.1.3 实测：官方 persist 是**同步**的、
 *     每次 state 变化整键重写 `{draft,view,viewRequest}`。假宿主照此实现，
 *     这样"外部裸写官方键会被覆盖"的坑才能被真实复现出来。
 *  3. **时间必须是虚拟时钟。** debounce / 输入法 / 30 万字耗时都要可判定，
 *     真等 300ms 会让测试跑成分钟级；虚拟时钟还能精确报出"第几毫秒落了盘"。
 *  4. **崩溃可复现。** 重新 `new Function` 一份插件源码 = 全新模块作用域（模块级变量清零），
 *     而 localStorage 保留；sessionStorage 按 web 语义清空 —— 用 sessionStorage 做镜像的实现
 *     会在这里被抓出来。
 */

const REAL_SETTIMEOUT = globalThis.setTimeout.bind(globalThis)
const REAL_CLEAR_TIMEOUT = globalThis.clearTimeout.bind(globalThis)
const REAL_SETIMMEDIATE = globalThis.setImmediate.bind(globalThis)

/* ────────────────────────────── 虚拟时钟 ────────────────────────────── */

export function createClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  const errors = []
  const fired = [] // {at, ms, realMs} —— 每次回调的虚拟触发时刻与真实耗时

  const setTimeoutFake = (fn, ms = 0, ...args) => {
    const id = ++seq
    timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args, every: null, delay: Math.max(0, Number(ms) || 0) })
    return id
  }
  const clearTimeoutFake = (id) => { timers.delete(id) }
  const setIntervalFake = (fn, ms = 0, ...args) => {
    const id = ++seq
    const every = Math.max(1, Number(ms) || 1)
    timers.set(id, { at: now + every, fn, args, every, delay: every })
    return id
  }

  function runDue() {
    const due = [...timers.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)
    for (const [id, t] of due) {
      if (!timers.has(id)) continue
      if (t.every) t.at = now + t.every
      else timers.delete(id)
      const t0 = process.hrtime.bigint()
      try { t.fn(...t.args) } catch (e) { errors.push(e) }
      const realMs = Number(process.hrtime.bigint() - t0) / 1e6
      fired.push({ at: now, delay: t.delay, realMs })
    }
  }

  async function drain() {
    // setImmediate 会把已排队的 promise job 全部跑完（dequeue 语义），比 await 一次 setTimeout 更彻底
    for (let i = 0; i < 3; i++) await new Promise((r) => REAL_SETIMMEDIATE(r))
  }

  return {
    get now() { return now },
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    setInterval: setIntervalFake,
    clearInterval: clearTimeoutFake,
    requestAnimationFrame: (fn) => setTimeoutFake(() => fn(now), 16),
    cancelAnimationFrame: clearTimeoutFake,
    performanceNow: () => now,
    errors,
    fired,
    pending: () => timers.size,
    /** 推进虚拟时间；step 越小越接近真实调度粒度 */
    async advance(ms, { step = 5 } = {}) {
      await drain() // 调用方之前排队的东西（React 重渲染、promise 链）先跑完，再走时间
      const target = now + ms
      while (now < target) {
        now = Math.min(target, now + step)
        runDue()
        await drain()
      }
      runDue()
      await drain()
    },
    /** 推进到某个绝对虚拟时刻 */
    async advanceTo(at) { if (at > now) await this.advance(at - now) },
    /** 真实等待（只在需要验证"插件用了真 setTimeout"的兜底路径里用） */
    async realWait(ms) {
      const t0 = Date.now()
      await new Promise((r) => REAL_SETTIMEOUT(r, ms))
      return Date.now() - t0
    },
  }
}

/* ──────────────────────────── 假 localStorage ──────────────────────────── */

export function createStorage(name = 'localStorage') {
  const map = new Map()
  const ops = []
  /** 配额策略：只统计 filter(key) 为真的键，避免官方键占用预算导致测不准 */
  const policy = { maxTotal: Infinity, filter: () => true, failAll: false }

  const bytes = (s) => Buffer.byteLength(String(s), 'utf8')
  const total = (filter = policy.filter) => {
    let n = 0
    for (const [k, v] of map) if (filter(k)) n += bytes(k) + bytes(v)
    return n
  }
  const quotaError = () => {
    const e = new Error('The quota has been exceeded.')
    e.name = 'QuotaExceededError'
    e.code = 22
    return e
  }

  const api = {
    __name: name,
    getItem(key) {
      key = String(key)
      const v = map.has(key) ? map.get(key) : null
      ops.push({ type: 'get', key, ok: true, bytes: v === null ? 0 : bytes(v) })
      return v
    },
    setItem(key, value) {
      key = String(key)
      value = String(value)
      const next = (map.has(key) ? -1 : 0) // 覆盖时先扣旧值
      const oldBytes = map.has(key) ? bytes(key) + bytes(map.get(key)) : 0
      const incoming = bytes(key) + bytes(value)
      const projected = total() - (next === -1 ? oldBytes : 0) + incoming
      if (policy.failAll || (policy.filter(key) && projected > policy.maxTotal && policy.maxTotal !== Infinity)) {
        ops.push({ type: 'set', key, ok: false, bytes: incoming, value, stack: shortStack() })
        throw quotaError()
      }
      if (policy.failAll) { ops.push({ type: 'set', key, ok: false, bytes: incoming, value, stack: shortStack() }); throw quotaError() }
      map.set(key, value)
      ops.push({ type: 'set', key, ok: true, bytes: incoming, value, stack: shortStack() })
    },
    removeItem(key) {
      key = String(key)
      const had = map.has(key)
      map.delete(key)
      ops.push({ type: 'remove', key, ok: had })
    },
    clear() { map.clear(); ops.push({ type: 'clear', ok: true }) },
    key(i) { return [...map.keys()][i] ?? null },
    get length() { return map.size },
    // 测试辅助
    __map: map,
    __ops: ops,
    __bytes: bytes,
    __total: total,
    __keys: () => [...map.keys()],
    __policy: policy,
    __reset: () => { map.clear(); ops.length = 0 },
    __snapshot: () => Object.fromEntries(map),
  }
  return api
}

function shortStack() {
  const s = new Error().stack ?? ''
  return s.split('\n').slice(2, 6).join('\n')
}

/* ──────────────────────────── 假 DOM / 事件 ──────────────────────────── */

function createEventTarget(label) {
  const listeners = new Map()
  return {
    __label: label,
    __listeners: listeners,
    addEventListener(type, fn) {
      if (typeof fn !== 'function') return
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
    dispatchEvent(ev) {
      const set = listeners.get(ev?.type)
      if (set) for (const fn of [...set]) fn(ev)
      return true
    },
    __counts: () => Object.fromEntries([...listeners].map(([k, v]) => [k, v.size])),
  }
}

function createElement(tag = 'div') {
  const el = createEventTarget(`<${tag}>`)
  Object.assign(el, {
    tagName: String(tag).toUpperCase(),
    id: '', textContent: '', innerHTML: '', className: '', value: '',
    style: {}, dataset: {}, childNodes: [], parentElement: null, innerText: '',
    setAttribute() {}, getAttribute() { return null }, removeAttribute() {},
    appendChild(c) { el.childNodes.push(c); c.parentElement = el; return c },
    insertBefore(c) { el.childNodes.push(c); return c },
    removeChild(c) { el.childNodes = el.childNodes.filter((x) => x !== c); return c },
    remove() {}, contains() { return false }, focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 } },
    cloneNode() { return createElement(tag) },
    scrollIntoView() {},
  })
  el.classList = { add() {}, remove() {}, toggle() {}, contains() { return false } }
  return el
}

function createDocument() {
  const doc = createEventTarget('document')
  doc.readyState = 'complete'
  doc.visibilityState = 'visible'
  doc.title = 'dsh-test'
  doc.head = createElement('head')
  doc.body = createElement('body')
  doc.documentElement = createElement('html')
  doc.createElement = (tag) => createElement(tag)
  doc.createElementNS = (_ns, tag) => createElement(tag)
  doc.createTextNode = (t) => ({ nodeType: 3, textContent: String(t) })
  doc.getElementById = () => null
  doc.querySelector = (sel) => (String(sel).includes('contenteditable') ? doc.activeElement : null)
  doc.querySelectorAll = () => []
  doc.getElementsByTagName = () => []
  doc.activeElement = createElement('div')
  doc.activeElement.contentEditable = 'true'
  doc.hasFocus = () => true
  return doc
}

/* ──────────────────────────── 迷你 React ──────────────────────────── */

/**
 * 只实现插件真的会用到的那部分 React：hook 顺序、deps 比较、effect 提交、重渲染。
 * 额外职责（这是本文件最有价值的部分）：**记录 hook 顺序违规**。
 * 历史 P0「条件调用 hook → RangeError: Invalid array length」在这里表现为
 * 两次渲染的 hook 数量/类型不一致 —— 比人眼 review 可靠。
 */
export function createReactRuntime() {
  const instances = new Map()
  const renderQueue = new Set()
  const violations = []
  const unknownHooks = new Set()
  const errors = []
  let current = null
  let idSeq = 0
  let renderPasses = 0

  const sameDeps = (a, b) => {
    if (a === undefined || b === undefined) return false
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
    return true
  }

  function slot(type) {
    const inst = current
    if (!inst) throw new Error('HOOK_OUTSIDE_RENDER: hook 在组件函数外被调用')
    const i = inst.hookIndex++
    const h = inst.hooks[i]
    if (!h) { inst.hooks[i] = { type }; return [inst, i, inst.hooks[i]] }
    if (h.type !== type) {
      const msg = `hook #${i} 类型从 ${h.type} 变成 ${type}（条件调用 hook？）`
      violations.push({ key: inst.key, detail: msg })
      throw new Error(`HOOK_TYPE_MISMATCH: ${msg}`)
    }
    return [inst, i, h]
  }

  const useState = (init) => {
    const [inst, , h] = slot('useState')
    if (!('value' in h)) h.value = typeof init === 'function' ? init() : init
    const set = (next) => {
      const v = typeof next === 'function' ? next(h.value) : next
      if (!Object.is(v, h.value)) { h.value = v; requestRender(inst) }
    }
    return [h.value, set]
  }

  const useReducer = (reducer, init) => {
    const [inst, , h] = slot('useReducer')
    if (!('value' in h)) h.value = init
    const dispatch = (action) => {
      const v = reducer(h.value, action)
      if (!Object.is(v, h.value)) { h.value = v; requestRender(inst) }
    }
    return [h.value, dispatch]
  }

  const useEffect = (fn, deps) => {
    const [inst, , h] = slot('useEffect')
    const changed = !('deps' in h) || !sameDeps(h.deps, deps)
    h.deps = deps === undefined ? undefined : [...deps]
    if (changed) inst.pendingEffects.push({ h, fn })
  }

  const useLayoutEffect = useEffect

  const useMemo = (fn, deps) => {
    const [, , h] = slot('useMemo')
    if (!('deps' in h) || !sameDeps(h.deps, deps)) { h.deps = deps ? [...deps] : undefined; h.value = fn() }
    return h.value
  }

  const useCallback = (fn, deps) => useMemo(() => fn, deps)

  const useRef = (init) => {
    const [, , h] = slot('useRef')
    if (!('current' in h)) h.current = init
    return h
  }

  const useId = () => { const [, , h] = slot('useId'); if (!h.id) h.id = `:t${++idSeq}:`; return h.id }

  const createContext = (value) => ({ __ctx: true, value, Provider: (p) => p?.children ?? null, Consumer: () => null })
  const useContext = (c) => c?.value

  const useSyncExternalStore = (subscribe, getSnapshot) => {
    const [inst, , h] = slot('useSyncExternalStore')
    if (!('value' in h)) h.value = getSnapshot()
    useEffect(() => subscribe(() => {
      const v = getSnapshot()
      if (!Object.is(v, h.value)) { h.value = v; requestRender(inst) }
    }), [subscribe])
    return h.value
  }

  const hookTable = { useState, useReducer, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useId, useContext, useSyncExternalStore }

  /** 未知 hook：不静默放过，直接抛出来暴露给测试表 */
  const makeUnknown = (name) => (...args) => { unknownHooks.add(name); throw new Error(`UNSUPPORTED_HOOK: ${name}(${args.length}) — harness 未实现该 hook，请补 test/harness.mjs`) }

  const React = new Proxy({
    createElement: (type, props, ...children) => ({
      __el: true, type, props: props ? { ...props } : {}, children,
    }),
    Fragment: Symbol.for('react.fragment'),
    StrictMode: Symbol.for('react.strictmode') ,
    memo: (c) => c,
    forwardRef: (c) => { const f = (p) => c(p, { current: null }); f.__forwardRef = true; return f },
    createContext, useContext,
    cloneElement: (el, props) => ({ ...el, props: { ...el.props, ...props } }),
    Children: { toArray: (c) => (Array.isArray(c) ? c : c == null ? [] : [c]), map: (c, f) => (Array.isArray(c) ? c : [c]).map(f), only: (c) => c },
    isValidElement: (e) => Boolean(e && e.__el),
  }, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'string' && typeof hookTable[prop] === 'function') return hookTable[prop]
      if (typeof prop === 'string' && /^use[A-Z]/.test(prop)) return makeUnknown(prop)
      if (prop === 'default') return target
      return undefined
    },
  })

  function getInstance(key, fn, props) {
    let inst = instances.get(key)
    if (!inst) {
      inst = { key, fn, props: props ?? {}, hooks: [], hookIndex: 0, mounted: false, pendingEffects: [], lastHookCount: undefined, renders: 0, errors: [] }
      instances.set(key, inst)
    }
    return inst
  }

  function requestRender(inst) {
    if (!inst.mounted) return
    renderQueue.add(inst)
    scheduleFlush()
  }

  // 外部状态（输入框 draft/phase）变化发生在渲染之外，必须自己把重渲染排出去。
  // 用 microtask（对齐 React 18 的自动批处理语义），测试里 await clock.advance() 会把它抽干。
  let flushScheduled = false
  function scheduleFlush() {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(() => {
      flushScheduled = false
      try { flushRenders() } catch (e) { errors.push(e) }
    })
  }

  function commitEffects(inst) {
    const queue = inst.pendingEffects
    inst.pendingEffects = []
    for (const { h, fn } of queue) {
      if (typeof h.cleanup === 'function') { try { h.cleanup() } catch (e) { inst.errors.push(e) } }
      let r
      try { r = fn() } catch (e) { inst.errors.push(e); errors.push(e); continue }
      h.cleanup = typeof r === 'function' ? r : undefined
    }
  }

  function renderInstance(inst) {
    renderPasses++
    inst.renders++
    inst.hookIndex = 0
    inst.pendingEffects = []
    const prev = current
    current = inst
    let out
    try { out = inst.fn(inst.props) } finally { current = prev }
    const count = inst.hookIndex
    if (inst.lastHookCount !== undefined && inst.lastHookCount !== count) {
      violations.push({ key: inst.key, detail: `hook 数量从 ${inst.lastHookCount} 变成 ${count}（条件调用 hook？）` })
    }
    inst.lastHookCount = count
    commitEffects(inst)
    renderChildren(inst, out)
  }

  function renderChildren(parent, node) {
    let idx = 0
    const walk = (n) => {
      if (n == null || n === false || n === true) return
      if (Array.isArray(n)) { for (const c of n) walk(c); return }
      if (typeof n !== 'object' || !n.__el) return
      const key = `${parent.key}/${idx++}`
      if (typeof n.type === 'function') {
        const child = getInstance(key, n.type, { ...n.props, children: n.children.length > 1 ? n.children : n.children[0] })
        child.mounted = true
        renderInstance(child)
      } else if (typeof n.type === 'symbol') {
        for (const c of n.children) walk(c)
      }
    }
    walk(node)
  }

  let destroyed = false

  function flushRenders() {
    if (destroyed) return
    let guard = 0
    while (renderQueue.size > 0) {
      if (++guard > 200) { errors.push(new Error('RENDER_LOOP: 组件连续 200 轮仍在请求渲染')); renderQueue.clear(); break }
      const batch = [...renderQueue]
      renderQueue.clear()
      for (const inst of batch) if (inst.mounted) renderInstance(inst)
    }
  }

  return {
    React,
    /** 进程没了：之后任何排队中的重渲染 / effect 都不许再跑（它们不会真的执行） */
    destroy() { destroyed = true; renderQueue.clear() },
    violations,
    unknownHooks: () => [...unknownHooks],
    errors,
    renderPasses: () => renderPasses,
    instances,
    /** 挂载一个组件实例 */
    mount(key, fn, props) {
      const existing = instances.get(key)
      // 同一个 key 换了组件函数（例如崩溃后重新装载插件）→ 必须丢弃旧实例，否则会复用到旧闭包
      if (existing && existing.fn !== fn) { this.unmount(key) }
      const inst = getInstance(key, fn, props)
      inst.fn = fn
      inst.props = { ...props }
      inst.mounted = true
      renderInstance(inst)
      flushRenders()
      return inst
    },
    update(key, props) {
      const inst = instances.get(key)
      if (!inst) throw new Error(`no instance ${key}`)
      inst.props = { ...props }
      renderInstance(inst)
      flushRenders()
    },
    unmount(key) {
      const inst = instances.get(key)
      if (!inst) return
      // 先卸载子实例（逆序，模仿 React 的 cleanup 顺序）
      const children = [...instances.keys()].filter((k) => k.startsWith(`${key}/`)).sort().reverse()
      for (const k of children) {
        const c = instances.get(k)
        c.mounted = false
        for (const h of c.hooks) if (typeof h.cleanup === 'function') { try { h.cleanup() } catch (e) { errors.push(e) } ; h.cleanup = undefined }
        instances.delete(k)
      }
      inst.mounted = false
      for (const h of inst.hooks) if (typeof h.cleanup === 'function') { try { h.cleanup() } catch (e) { errors.push(e) } ; h.cleanup = undefined }
      instances.delete(key)
    },
    flushRenders,
    /** 取某个实例用到的 props 键（诊断 U4/U5 用） */
    propsOf(key) { return instances.get(key)?.props },
    hookCounts() { return [...instances.values()].map((i) => ({ key: i.key, hooks: i.lastHookCount, renders: i.renders })) },
  }
}

/* ──────────────────────────── 假官方输入会话 ──────────────────────────── */

const CONVERSATION_KEY = (sid) => `dsh.conversation.${sid}`

export class FakeShell {
  constructor(host, sessionId) {
    this.host = host
    this.sessionId = sessionId
    this.listeners = new Set()
    this.state = { draft: '', phase: 'plain', draftRev: 0, attachmentIds: [], occurrences: [], queue: [] }
    this.view = null
    this.viewRequest = null
    this.disposed = false
    // 官方语义：shell 首次创建时 readConversationDraft 一次（impl-contract §3.3.1）
    const raw = host.ls.getItem(CONVERSATION_KEY(sessionId))
    if (raw !== null) {
      try {
        const stored = JSON.parse(raw)
        if (stored && typeof stored === 'object') {
          const d = stored.draft
          if (typeof d === 'string') this.state.draft = d
          else if (d && typeof d === 'object' && typeof d.text === 'string') this.state.draft = d.text
          if ('view' in stored) this.view = stored.view
          if ('viewRequest' in stored) this.viewRequest = stored.viewRequest
        }
      } catch { /* 坏 JSON：官方 return empty */ }
    }
    this.fromDisk = this.state.draft
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  notify() {
    for (const fn of [...this.listeners]) {
      try { fn() } catch (e) { this.host.errors.push(e) }
    }
  }

  /** 官方 persist：state 一变就整键同步重写（impl-contract §3.1.3 实测行为） */
  persist() {
    if (this.disposed) return
    const payload = {
      draft: { references: [], text: this.state.draft },
      view: this.view,
      viewRequest: this.viewRequest,
    }
    try { this.host.ls.setItem(CONVERSATION_KEY(this.sessionId), JSON.stringify(payload)) }
    catch (e) { this.host.officialWriteFailures.push({ sessionId: this.sessionId, error: String(e?.name ?? e) }) }
  }

  setState(patch, { persist = true } = {}) {
    Object.assign(this.state, patch)
    if (persist) this.persist()
    this.notify()
  }

  dispose() {
    // impl-contract §3.1.5：dispose 不 persist
    this.disposed = true
    this.listeners.clear()
  }
}

/* ──────────────────────────── 宿主 ──────────────────────────── */

export class FakeHost {
  constructor({ clientPath, code } = {}) {
    this.clientPath = clientPath
    this.code = code
    this.clock = createClock()
    this.ls = createStorage('localStorage')
    this.ss = createStorage('sessionStorage')
    this.react = createReactRuntime()
    this.document = createDocument()
    this.window = createEventTarget('window')
    this.shells = new Map()          // sessionId → FakeShell（内存态；crash 后清空）
    this.sessionMeta = new Map()     // sessionId → { cwd }
    this.slotEntries = []            // { slot, opts, Component, at }
    this.ctxAccess = new Set()
    this.api = []                    // 官方 API 调用流水
    this.errors = []
    this.officialWriteFailures = []
    this.console = { log: [], warn: [], error: [], debug: [] }
    this.depsRequested = new Set()
    this.moduleState = null
    this._seq = 0

    this.window.__ModuleLoader__ = { load: (def) => { this.captured = def } }
    this.window.document = this.document
    this.window.localStorage = this.ls
    this.window.sessionStorage = this.ss
    this.window.setTimeout = this.clock.setTimeout
    this.window.clearTimeout = this.clock.clearTimeout
    this.window.setInterval = this.clock.setInterval
    this.window.clearInterval = this.clock.clearInterval
    this.window.requestAnimationFrame = this.clock.requestAnimationFrame
    this.window.cancelAnimationFrame = this.clock.cancelAnimationFrame
    this.window.getComputedStyle = () => ({ getPropertyValue: () => '' })
    this.window.innerWidth = 1440
    this.window.innerHeight = 900
    this.window.devicePixelRatio = 1
  }

  /* ── 会话 ── */

  openSession(sessionId, cwd = 'D:/ws') {
    this.sessionMeta.set(sessionId, { cwd })
    if (!this.shells.has(sessionId)) this.shells.set(sessionId, new FakeShell(this, sessionId))
    return this.shells.get(sessionId)
  }

  /** 关闭会话 = 释放 binding → shell dispose 并出内存（impl-contract §3.3.2） */
  closeSession(sessionId) {
    const shell = this.shells.get(sessionId)
    if (shell) { shell.dispose(); this.shells.delete(sessionId) }
  }

  shellOf(sessionId) { return this.shells.get(sessionId) }

  listState() {
    const byId = {}
    for (const [sid, meta] of this.sessionMeta) byId[sid] = { cwd: meta.cwd, blank: true, id: sid }
    return { byId, ids: [...this.sessionMeta.keys()] }
  }

  /* ── 输入动作 ── */

  /** 模拟用户敲字：draft 变化 + 官方 persist（与真实 publish() 一致） */
  type(sessionId, text) {
    const shell = this.shells.get(sessionId)
    if (!shell) throw new Error(`type(): 未打开会话 ${sessionId}`)
    shell.setState({ draft: String(text), draftRev: shell.state.draftRev + 1 })
    return shell.state.draft
  }

  setPhase(sessionId, phase) {
    const shell = this.shells.get(sessionId)
    shell.setState({ phase })
  }

  /** 发送成功：官方 commit-draft → 编辑器清空 → publish → persist（impl-contract §3.2.1） */
  sendSuccess(sessionId) {
    const shell = this.shells.get(sessionId)
    shell.setState({ phase: 'sending' })
    shell.setState({ draft: '', draftRev: shell.state.draftRev + 1, phase: 'plain' })
  }

  /** 发送失败：effects = []，草稿原封不动（impl-contract §3.2.2） */
  sendFailure(sessionId) {
    const shell = this.shells.get(sessionId)
    shell.setState({ phase: 'sending' })
    shell.setState({ phase: 'plain' })
  }

  /* ── 输入法事件 ── */

  fireComposition(type, data = '') {
    const ev = { type, data, isComposing: type !== 'compositionend', bubbles: true, target: this.document.activeElement }
    const targets = [this.document.activeElement, this.document, this.window]
    let delivered = 0
    for (const t of targets) {
      const before = Object.values(t.__counts?.() ?? {}).reduce((a, b) => a + b, 0)
      t.dispatchEvent(ev)
      const after = Object.values(t.__counts?.() ?? {}).reduce((a, b) => a + b, 0)
      if (after > 0 && before >= 0) delivered++
    }
    this.compositionDelivered = (this.compositionDelivered ?? 0) + (delivered > 0 ? 1 : 0)
    return delivered
  }

  /* ── 插件加载 ── */

  /** 装载 lib/client.js 并拿到 factory（不执行 apply） */
  loadFactory() {
    if (!this.code) throw new Error('没有插件源码：先传 code 或 clientPath')
    this.captured = null
    const h = this
    const params = [
      'window', 'document', 'localStorage', 'sessionStorage',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'navigator', 'console',
    ]
    const fn = new Function(...params, `${this.code}\n;return typeof exports !== 'undefined' ? exports : undefined;`)
    const consoleProxy = {
      log: (...a) => { h.console.log.push(a.map(String).join(' ')) },
      info: (...a) => { h.console.log.push(a.map(String).join(' ')) },
      debug: (...a) => { h.console.debug.push(a.map(String).join(' ')) },
      warn: (...a) => { h.console.warn.push(a.map(String).join(' ')) },
      error: (...a) => { h.console.error.push(a.map(String).join(' ')) },
      trace: () => {},
      group: () => {}, groupEnd: () => {},
      time: () => {}, timeEnd: () => {},
    }
    const perf = { now: () => this.clock.now, mark() {}, measure() {} }
    const nav = { userAgent: 'dsh-fake-host', language: 'zh-CN', platform: 'Win32', clipboard: {} }
    try {
      fn(
        this.window, this.document, this.ls, this.ss,
        this.clock.setTimeout, this.clock.clearTimeout,
        this.clock.setInterval, this.clock.clearInterval,
        this.clock.requestAnimationFrame, this.clock.cancelAnimationFrame,
        perf, nav, consoleProxy,
      )
    } catch (e) {
      this.errors.push(e)
      throw e
    }
    if (!this.captured) throw new Error('window.__ModuleLoader__.load 未被调用 —— 文件格式不对')
    return this.captured
  }

  /** 执行 factory(require)，返回 exports */
  instantiate() {
    const def = this.captured ?? this.loadFactory()
    const h = this
    const fakeRequire = (id) => {
      h.depsRequested.add(id)
      if (id === 'react') return this.react.React
      throw new Error(`UNEXPECTED_DEPENDENCY: require("${id}") —— 插件的非 react 外部依赖`)
    }
    const exportsObj = def.factory(fakeRequire)
    this.moduleState = { def, exports: exportsObj }
    return exportsObj
  }

  /** 假 cordis ctx：slots.inject/register 全部留痕 */
  makeCtx() {
    const h = this
    const slots = {
      inject(name, cb) {
        h.slotEntries.push({ slot: name, phase: 'inject' })
        let registered
        try { registered = cb() } catch (e) { h.errors.push(e); throw e }
        return registered
      },
      register(opts, Component) {
        const entry = { slot: opts?.name, opts, Component, at: ++h._seq }
        h.slotEntries.push(entry)
        return { dispose() { h.slotEntries = h.slotEntries.filter((x) => x !== entry) } }
      },
    }
    const ctx = {
      get(name) {
        h.ctxAccess.add(name)
        if (name === 'slots') return slots
        if (name === 'conversation') return h.conversationService()
        if (name === 'sessions') return { list: { getSnapshot: () => h.listState(), subscribe: (f) => { h.__sessionSubs ??= new Set(); h.__sessionSubs.add(f); return () => h.__sessionSubs.delete(f) } } }
        return undefined
      },
      inject(keys, cb) {
        for (const k of [].concat(keys)) h.ctxAccess.add(`inject:${k}`)
        if (typeof cb === 'function') cb(ctx)
      },
      effect(fn, label) {
        h.ctxAccess.add(`effect:${label ?? ''}`)
        try { const r = fn(); return typeof r === 'function' ? r : () => {} } catch (e) { h.errors.push(e); return () => {} }
      },
      on() {}, off() {}, emit() {}, once() {},
      set() {}, provide() {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      get slots() { return slots },
      root: null,
    }
    ctx.root = ctx
    return ctx
  }

  /** L2 通道：ctx.get('conversation').input.shell(sessionId)（impl-contract §3.5.4） */
  conversationService() {
    const h = this
    if (this.disableL2) return { input: undefined }
    const input = {
      shell(sessionId) {
        h.api.push({ api: 'conversation.input.shell', sessionId })
        const shell = h.shells.get(sessionId) ?? h.openSession(sessionId)
        return {
          get state() { return shell.state },
          setDraft(text) { h.record('L2.setDraft', [text]); shell.setState({ draft: String(text), draftRev: shell.state.draftRev + 1 }) },
          persistDraft() { h.record('L2.persistDraft', []); shell.persist() },
          get actions() { return h.makeActions(sessionId) },
        }
      },
      for() { throw new Error('not modeled') },
    }
    return { input, get() {}, releaseDraftAttachment() {} }
  }

  makeActions(sessionId) {
    const h = this
    const shell = () => h.shells.get(sessionId)
    return {
      setDraft(text) {
        h.record('L1.setDraft', [text], sessionId)
        const s = shell()
        if (!s) { h.errors.push(new Error(`setDraft on unknown session ${sessionId}`)); return }
        s.setState({ draft: String(text), draftRev: s.state.draftRev + 1 })
      },
      persistDraft() {
        h.record('L1.persistDraft', [], sessionId)
        shell()?.persist()
      },
      submit() { h.record('L1.submit', [], sessionId) },
      insertQuote() { return false },
      insertText() { return false },
      captureInsertion() { return { start: 0, end: 0 } },
      addAttachments() { return true },
      removeAttachment() {},
      pruneAttachments() {},
    }
  }

  record(api, args, sessionId) {
    this.api.push({ api, args, sessionId, at: this.clock.now })
  }

  /** 从 apply 的注册结果里挑出"会话作用域"的组件作为挂载点 */
  pickSessionComponent() {
    const regs = this.slotEntries.filter((e) => e.Component)
    if (regs.length === 0) return null
    const prefer = [
      'conversation.input.dock', 'conversation.composer.dock', 'conversation.session',
      'conversation.input.left', 'conversation.input.right', 'conversation.input.overlay',
      'conversation.composer.bar', 'conversation.session.header',
    ]
    for (const name of prefer) {
      const hit = regs.find((r) => r.slot === name)
      if (hit) return hit
    }
    const loose = regs.find((r) => /input|composer|session/i.test(r.slot ?? '') && !/settings|plugins/.test(r.slot ?? ''))
    return loose ?? null
  }

  /** 组件 props：全部包 Proxy，记录插件真的读了哪些键（诊断 U4/U5） */
  makeProps(sessionId, entry) {
    const h = this
    const shell = this.shells.get(sessionId)
    const touched = new Set()

    const mkHook = (getState) => (selector) => {
      const [, force] = h.react.React.useState(0)
      h.react.React.useEffect(() => {
        const subscribe = getState().subscribe
        return subscribe(() => force((v) => v + 1))
      }, [])
      const st = getState().get()
      return typeof selector === 'function' ? selector(st) : st
    }

    const raw = {
      sessionId,
      inputActions: this.makeActions(sessionId),
      useInput: mkHook(() => ({ get: () => shell.state, subscribe: (fn) => shell.subscribe(fn) })),
      useConversation: mkHook(() => ({ get: () => ({ blank: true, sessionId }), subscribe: () => () => {} })),
      useSession: mkHook(() => ({ get: () => ({ cwd: this.sessionMeta.get(sessionId)?.cwd, id: sessionId }), subscribe: () => () => {} })),
      useSessions: mkHook(() => ({ get: () => h.listState(), subscribe: (fn) => h.subscribeSessions(fn) })),
      useStore: undefined,
      slots: { register: () => ({ dispose() {} }), inject: () => {} },
      renderSlot: () => null,
      renderFactorySlot: () => null,
      t: (k) => k,
      open: () => {},
      close: () => {},
      inCard: false,
      ...(entry?.opts?.select ? { matched: undefined } : {}),
    }
    return new Proxy(raw, {
      get(t, key) {
        if (typeof key === 'string') touched.add(key)
        return t[key]
      },
      has(t, key) { return key in t },
    })
  }

  subscribeSessions(fn) {
    this.__sessionSubs ??= new Set()
    this.__sessionSubs.add(fn)
    return () => this.__sessionSubs.delete(fn)
  }

  /** 装载 + apply（= 宿主启动流程） */
  boot() {
    this.loadFactory()
    const exportsObj = this.instantiate()
    const ctx = this.makeCtx()
    if (typeof exportsObj?.apply === 'function') {
      try { exportsObj.apply(ctx) } catch (e) { this.errors.push(e); throw e }
    } else {
      this.errors.push(new Error('exports.apply 不存在 —— 插件没有注册入口'))
    }
    return exportsObj
  }

  /** 挂载 UI 到某个会话（= 导航到该会话）。propsPatch 用来掐掉某个宿主能力做降级测试 */
  mount(sessionId, propsPatch) {
    const entry = this.pickSessionComponent()
    if (!entry) throw new Error('没有找到会话作用域的插槽组件（注册表为空或只注册了 settings 槽）')
    this.openSession(sessionId)
    const key = `root:${sessionId}`
    const props = this.makeProps(sessionId, entry)
    if (propsPatch) for (const k of Object.keys(propsPatch)) props[k] = propsPatch[k]
    this.react.mount(key, entry.Component, props)
    return key
  }

  unmount(sessionId) {
    this.react.unmount(`root:${sessionId}`)
  }

  /** 完整"切到另一个会话"：卸载旧的 + 释放它的 binding（最严格场景）*/
  switchTo(fromSessionId, toSessionId, { releaseBinding = true } = {}) {
    if (fromSessionId) {
      this.unmount(fromSessionId)
      if (releaseBinding) this.closeSession(fromSessionId)
    }
    return this.mount(toSessionId)
  }

  /* ── 观测工具 ── */

  /** 插件自己建的键（实现无关：只排除官方键与我们认识的宿主键） */
  pluginKeys() {
    return this.ls.__keys().filter((k) => !k.startsWith('dsh.conversation.') && k !== 'dsh.sessions.current')
  }

  pluginEntries() {
    return this.pluginKeys().map((k) => ({ key: k, value: this.ls.__map.get(k) ?? '', bytes: Buffer.byteLength(k) + Buffer.byteLength(this.ls.__map.get(k) ?? '') }))
  }

  pluginBytes() { return this.pluginEntries().reduce((n, e) => n + e.bytes, 0) }

  /** 落盘流水：所有 set/remove，含 stack，可判"谁写的" */
  writes() { return this.ls.__ops.filter((o) => o.type === 'set' || o.type === 'remove') }

  officialWrites() { return this.writes().filter((o) => o.key.startsWith('dsh.conversation.')) }

  /** 官方 API 调用 */
  calls(api) { return this.api.filter((a) => a.api === api) }

  /** 所有插件落盘里出现 draft 文本的条目（用来断言"落盘了/没落盘"） */
  storedTexts() {
    return this.pluginEntries().map((e) => e.value)
  }

  hasStored(text) {
    return this.storedTexts().some((v) => v.includes(escapeForSearch(text)))
  }

  /**
   * 崩溃：清掉"进程内"的一切 —— React 树（含组件实例与 hook 状态）、shell 内存、
   * 插件模块作用域、槽注册表；保留 localStorage，按 web 语义清 sessionStorage。
   * 注意 React 运行时也必须重建：真实进程崩溃后不会有任何组件实例残留，
   * 否则 `restoredRef` 这类"每页生命周期一次"的闸门会假性延续，把恢复闸门糊住。
   */
  crash() {
    for (const s of this.shells.values()) s.dispose()
    this.shells.clear()
    this.ss.__reset()
    this.captured = null
    this.moduleState = null
    this.slotEntries = []
    this.react.destroy() // 先掐掉旧运行时排队中的重渲染
    this.react = createReactRuntime()
    this.api.length = 0
    this.officialWriteFailures.length = 0
  }

  resetCounters() {
    this.ls.__ops.length = 0
    this.api.length = 0
    this.console = { log: [], warn: [], error: [], debug: [] }
    this.errors.length = 0
    this.clock.fired.length = 0
  }
}

function escapeForSearch(s) { return s }

/* ──────────────────────────── 便捷构造 ──────────────────────────── */

export function augment(host) {
  return host
}

export { CONVERSATION_KEY }
