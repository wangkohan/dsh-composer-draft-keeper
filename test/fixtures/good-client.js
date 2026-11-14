/**
 * 参照实现（fixture）—— **不是产品代码，是测具的标定件**。
 *
 * 用途有两个，都很重要：
 *  1. **证明测试台不假绿**：一个按 impl-contract 写的正确实现，必须在 test/acceptance.mjs 里全 PASS。
 *     否则说明断言写错了，而不是工程师写错了。
 *  2. **给工程师一份可对照的骨架**：三层写入（L1/L2/L3）、双闸门恢复、输入法保护、
 *     容量淘汰、QuotaExceeded 重试，形状都在这里。
 *
 * 故意**不**抄任何实现细节给工程师去 copy-paste 到 lib/client.js —— 这只验证行为契约。
 */
window.__ModuleLoader__.load({
  id: 'dsh-composer-draft-keeper-fixture',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let react = require('react')

    const inject = ['slots']

    const NS = 'dsh.draft-keeper.v1'
    const KEY_DRAFT = (sid) => `${NS}.drafts.${sid}`
    const KEY_HIST = (sid) => `${NS}.history.${sid}`
    const PREFIX = `${NS}.`
    const LIMIT_BYTES = 256 * 1024
    const HISTORY_MAX = 10
    const DEBOUNCE_MS = 300
    const FROZEN = ['adjudicating', 'submitting', 'sending']

    // ── 模块级：输入法状态（compositionstart/end 的窗口）──
    let composing = false
    let compositionInstalled = false
    let lastKnown = null // { sessionId, draft, phase }

    const debug = (msg, e) => { try { if (e) console.debug('[draft-keeper]', msg, e && (e.message || e)); else console.debug('[draft-keeper]', msg) } catch (_) {} }

    function bytes(s) { return typeof s === 'string' ? s.length * 1 : 0 }

    function storage() {
      try { return typeof localStorage === 'undefined' ? null : localStorage } catch (_) { return null }
    }

    function readRaw(key) {
      const ls = storage()
      if (!ls) return null
      try { return ls.getItem(key) } catch (_) { return null }
    }

    function allKeys() {
      const ls = storage()
      if (!ls) return []
      const out = []
      try {
        for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (typeof k === 'string') out.push(k) }
      } catch (_) {}
      return out
    }

    function totalBytes() {
      let n = 0
      for (const k of allKeys()) if (k.startsWith(PREFIX)) n += bytes(k) + bytes(readRaw(k) ?? '')
      return n
    }

    function isQuotaError(e) {
      return Boolean(e) && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(String(e.message ?? '')))
    }

    /** 容量淘汰：按 at 升序删最旧，直到回到 LIMIT 以内 */
    function evictUntilFit(extra = 0) {
      let guard = 0
      while (totalBytes() + extra > LIMIT_BYTES && guard++ < 500) {
        const entries = allKeys()
          .filter((k) => k.startsWith(PREFIX))
          .map((k) => { let at = 0; try { at = JSON.parse(readRaw(k) ?? 'null')?.at ?? 0 } catch (_) {} ; return { k, at } })
          .sort((a, b) => a.at - b.at)
        if (entries.length === 0) break
        const ls = storage()
        try { ls.removeItem(entries[0].k); debug('evicted', entries[0].k) } catch (_) { break }
        if (entries.length === 1) break
      }
    }

    /** 按 at 升序删掉最旧的 n 条（不计代价，配额错误专用） */
    function evictOldest(n = 1) {
      const ls = storage()
      if (!ls) return 0
      const entries = allKeys()
        .filter((k) => k.startsWith(PREFIX))
        .map((k) => { let at = 0; try { at = JSON.parse(readRaw(k) ?? 'null')?.at ?? 0 } catch (_) {}; return { k, at } })
        .sort((a, b) => a.at - b.at)
      let removed = 0
      for (const e of entries) {
        if (removed >= n) break
        try { ls.removeItem(e.k); removed++; debug('quota: evicted', e.k) } catch (_) { break }
      }
      return removed
    }

    /**
     * 唯一的写入口：catch QuotaExceededError → 淘汰最旧 → 重试一次 → 静默放弃。
     * ★ 这里必须是"无条件淘汰最旧"，不能只用 evictUntilFit：
     *   浏览器配额可能小于我们自己的 256KB 上限（别的插件/官方键也在占），
     *   按自家上限算"没超"就什么都不删，重试必然再失败。
     */
    function safeSet(key, value) {
      const ls = storage()
      if (!ls) return false
      try { ls.setItem(key, value); return true } catch (e) {
        if (!isQuotaError(e)) { debug('setItem failed', e); return false }
      }
      evictOldest(1)
      try { ls.setItem(key, value); return true } catch (e) {
        debug('quota: giving up silently', e?.name)
        return false
      }
    }

    function safeRemove(key) {
      const ls = storage()
      if (!ls) return
      try { ls.removeItem(key) } catch (_) {}
    }

    /* ── 镜像读写（插件独占命名空间）── */

    function readDraft(sid) {
      const raw = readRaw(KEY_DRAFT(sid))
      if (raw === null) return null
      try {
        const v = JSON.parse(raw)
        if (!v || typeof v !== 'object' || typeof v.text !== 'string') return null
        return v
      } catch (_) { return null }
    }

    function writeDraft(sid, text, cwd) {
      if (typeof text !== 'string') return false
      // 空 / 纯空白：不写入、不占空间
      if (text.trim() === '') { safeRemove(KEY_DRAFT(sid)); return true }
      const prev = readDraft(sid)
      const payload = JSON.stringify({ text, at: Date.now(), cwd: cwd ?? null, ...(prev?.consumedAt ? { consumedAt: prev.consumedAt } : {}) })
      const ok = safeSet(KEY_DRAFT(sid), payload)
      if (ok) evictUntilFit()
      return ok
    }

    /**
     * 「正在发送」标记：phase 进入 sending/adjudicating/submitting 时，把当前非空草稿
     * 标成已消费。为什么必须**在飞的时候就标**：
     *   正常路径靠"观察到 draft 变空"来 consume，但如果发送成功与切走/崩溃撞在同一拍，
     *   组件可能来不及看到那一帧空草稿 → 镜像里留着刚发出去的内容 → 下次挂载就回灌。
     *   发送**失败**时 phase 会退回 plain，届时镜像会重写一次（consumedAt 自动复位），
     *   所以草稿不会因此丢。
     */
    function markInFlight(sid) {
      const record = readDraft(sid)
      if (!record || record.text.trim() === '' || record.consumedAt > 0) return
      safeSet(KEY_DRAFT(sid), JSON.stringify(Object.assign({}, record, { consumedAt: record.at })))
    }

    /** 发送成功（draft 非空→空）：清镜像 + 进历史 */
    function consumeDraft(sid, text) {
      safeRemove(KEY_DRAFT(sid))
      if (typeof text !== 'string' || text.trim() === '') return
      const raw = readRaw(KEY_HIST(sid))
      let list = []
      try { const p = JSON.parse(raw ?? '[]'); if (Array.isArray(p)) list = p } catch (_) {}
      list.unshift({ text, at: Date.now() })
      const trimmed = list.slice(0, HISTORY_MAX)
      safeSet(KEY_HIST(sid), JSON.stringify(trimmed))
      evictUntilFit()
    }

    /* ── L3 兜底：读-改-写官方键，保住 view / viewRequest ── */
    function writeOfficialDraftRaw(sid, text) {
      const ls = storage()
      if (!ls) return false
      const key = `dsh.conversation.${sid}`
      let base = {}
      try {
        const raw = ls.getItem(key)
        if (raw !== null) {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed
        }
      } catch (_) { base = {} }
      const next = Object.assign({}, base, { draft: text }) // ★ 只替换 draft
      try { ls.setItem(key, JSON.stringify(next)); return true } catch (_) { return false }
    }

    function frozen(phase) { return FROZEN.indexOf(phase) !== -1 }

    /* ── 恢复：三层通道，L1 优先 ── */
    function restoreViaL1(inputActions, text) {
      if (!inputActions || typeof inputActions.setDraft !== 'function') return false
      try {
        inputActions.setDraft(text)
        // immer 无实际变化不通知 → 必须显式再 persist 一次（impl-contract §3.1.3）
        if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft()
        return true
      } catch (e) { debug('L1 setDraft failed', e); return false }
    }

    function restoreViaL2(ctx, sid, text) {
      try {
        const conv = ctx && typeof ctx.get === 'function' ? ctx.get('conversation') : undefined
        const hub = conv && conv.input
        if (!hub || typeof hub.shell !== 'function') return false
        const shell = hub.shell(sid)
        if (!shell || typeof shell.setDraft !== 'function') return false
        shell.setDraft(text)
        if (typeof shell.persistDraft === 'function') shell.persistDraft()
        return true
      } catch (e) { debug('L2 failed', e); return false }
    }

    function restoreDraft(ctx, sid, inputActions, text) {
      if (restoreViaL1(inputActions, text)) return 'L1'
      if (restoreViaL2(ctx, sid, text)) return 'L2'
      debug('L1/L2 全失效，回落 L3')
      if (writeOfficialDraftRaw(sid, text)) return 'L3'
      return 'none'
    }

    /* ── debounce ── */
    const timers = new Map()
    function schedule(sid, text, cwd) {
      const prev = timers.get(sid)
      if (prev !== undefined) { try { clearTimeout(prev) } catch (_) {} }
      const id = setTimeout(() => {
        timers.delete(sid)
        // ★ 定时器落地时**再判一次** composition：期间开始输入法也不能落盘
        if (composing) { schedule(sid, text, cwd); return }
        if (lastKnown && frozen(lastKnown.phase)) return
        writeDraft(sid, text, cwd)
      }, DEBOUNCE_MS)
      timers.set(sid, id)
    }

    function cancelTimer(sid) {
      const prev = timers.get(sid)
      if (prev !== undefined) { try { clearTimeout(prev) } catch (_) {} ; timers.delete(sid) }
    }

    /* ── 输入法监听（document 级，capture）── */
    function ensureCompositionListeners() {
      if (compositionInstalled) return
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
      compositionInstalled = true
      try {
        document.addEventListener('compositionstart', () => { composing = true }, true)
        document.addEventListener('compositionend', () => {
          composing = false
          // 补一次保存：最后一个词的改动不能在 debounce 窗口里丢。
          // ★ 必须延后一拍再读状态：compositionend 触发时宿主多半还没把组合结果写进
          //   React state，同步读拿到的是上一拍的半截拼音（这正是"存进拼音字母"的来源）。
          const sid = lastKnown && lastKnown.sessionId
          if (!sid) return
          setTimeout(() => {
            if (composing) return
            if (!lastKnown || lastKnown.sessionId !== sid) return
            if (frozen(lastKnown.phase)) return
            if (lastKnown.draft.trim() === '') return
            writeDraft(sid, lastKnown.draft, lastKnown.cwd)
          }, 0)
        }, true)
      } catch (e) { debug('composition listeners failed', e) }
    }

    /* ── 组件：无 UI（只做观测），返回 null ── */
    function DraftKeeper(props) {
      const sid = typeof props.sessionId === 'string' ? props.sessionId : ''
      const inputActions = props.inputActions
      // 宿主 API 可能缺（BRIEF §6E）：缺了就用常量替身，绝不因为 props 少一个键而崩掉入口子树。
      // 注意：替身的"是不是函数"判定在组件一生中恒定，因此 hook 数量不变（不构成条件 hook）。
      const useInput = typeof props.useInput === 'function' ? props.useInput : () => undefined
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined
      // ★ 全部 hook 无条件在顶层调用（历史 P0：条件 hook → RangeError）
      const draft = useInput((s) => s.draft) ?? ''
      const phase = useInput((s) => s.phase) ?? 'plain'
      const rev = useInput((s) => s.draftRev)
      const cwd = useSessions((s) => (sid && s && s.byId ? s.byId[sid]?.cwd : undefined))
      const restoredRef = react.useRef(null)
      const lastTextRef = react.useRef('')

      if (restoredRef.current === null) restoredRef.current = new Set()

      lastKnown = { sessionId: sid, draft, phase, cwd }
      ensureCompositionListeners()

      // ① 镜像：草稿变化 → 写自己的命名空间（永不写官方键）
      react.useEffect(() => {
        if (!sid) return
        if (frozen(phase)) {
          if (draft.trim() !== '') markInFlight(sid)
          return
        }
        if (composing) return
        const prevText = lastTextRef.current
        lastTextRef.current = draft
        if (draft.trim() === '') {
          cancelTimer(sid)
          if (prevText.trim() !== '') consumeDraft(sid, prevText) // 发送成功 = 观察到 非空→空
          return
        }
        schedule(sid, draft, cwd)
      }, [sid, draft, phase, rev, cwd])

      // ② 恢复：一次性 + 只有可证明为空时才动
      react.useEffect(() => {
        if (!sid) return
        const done = restoredRef.current
        if (done.has(sid)) return
        if (frozen(phase)) return
        if (draft !== '') { done.add(sid); return } // 官方已有内容 → 不碰（首次安装不吃已有草稿）
        done.add(sid)
        const saved = readDraft(sid)
        if (!saved || saved.text.trim() === '') return
        if (typeof saved.consumedAt === 'number' && saved.consumedAt >= saved.at) return
        restoreDraft(clientCtx, sid, inputActions, saved.text)
      }, [sid, phase, draft])

      return null
    }

    let clientCtx = null

    function apply(ctx) {
      clientCtx = ctx
      const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      if (!slots || typeof slots.register !== 'function') { debug('slots 服务不可用，降级'); return }
      ensureCompositionListeners()
      try {
        slots.inject('conversation.input.dock', () => slots.register(
          { name: 'conversation.input.dock', id: 'dsh-draft-keeper-dock', select: () => null },
          (props) => react.createElement(DraftKeeper, props),
        ))
      } catch (e) { debug('dock 注册失败', e) }
      try {
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsh-draft-keeper-settings', order: 40, label: '草稿保留' },
          () => react.createElement(SettingsCard),
        ))
      } catch (e) { debug('settings 注册失败', e) }
    }

    /** 设置页卡片：列表 / 逐条删除 / 一键清空 / 开关（真宿主要验的 #6） */
    function listDrafts() {
      return allKeys()
        .filter((k) => k.startsWith(`${NS}.drafts.`))
        .map((k) => {
          let v = null
          try { v = JSON.parse(readRaw(k) ?? 'null') } catch (_) {}
          return { sessionId: k.slice(`${NS}.drafts.`.length), text: v?.text ?? '', at: v?.at ?? 0 }
        })
        .sort((a, b) => b.at - a.at)
    }

    function SettingsCard() {
      const [items, setItems] = react.useState(() => listDrafts())
      const refresh = () => setItems(listDrafts())
      react.useEffect(() => { refresh() }, [])
      return react.createElement('div', { className: 'dsh-dk-card' },
        react.createElement('button', { onClick: () => { for (const k of allKeys()) if (k.startsWith(PREFIX)) safeRemove(k); refresh() } }, '一键清空'),
        ...items.map((it) => react.createElement('button', {
          key: it.sessionId,
          onClick: () => { safeRemove(KEY_DRAFT(it.sessionId)); refresh() },
        }, `${it.sessionId}: ${it.text.slice(0, 20)}`)),
      )
    }

    exports.inject = inject
    exports.apply = apply
    Object.defineProperty(exports, '__test', {
      value: { readDraft, writeDraft, consumeDraft, listDrafts, totalBytes, writeOfficialDraftRaw, evictUntilFit, evictOldest, LIMIT_BYTES, DEBOUNCE_MS },
      enumerable: false,
    })
    return module.exports
  },
})
