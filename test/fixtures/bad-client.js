/**
 * 反面标定件（fixture）—— **故意写错**，用来证明 test/acceptance.mjs 真的会报红。
 *
 * 如果一个"处处是坑"的实现也能全绿，那这张验收表就是废纸。这里刻意塞进：
 *   · 不设 debounce：每次按键都写盘          → A7 应红
 *   · 不判 composition：拼音中间态写盘       → A5 应红
 *   · 恢复闸门只判 sessionId 变了就写回       → A2（回灌）应红
 *   · 全局单槽位，不按 session 分开          → A1/A4 应红
 *   · 空白草稿照写                            → A9 应红
 *   · 没有容量上限、没有配额兜底              → A10/A11/A12 应红
 *   · 条件调用 hook                           → A17 应红
 *   · 裸写官方键 {draft}，丢 view             → A14 应红
 */
window.__ModuleLoader__.load({
  id: 'dsh-draft-keeper-BAD-fixture',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let react = require('react')
    const inject = ['slots']
    const SLOT = 'dsh.draft-keeper.bad'

    function readLast() {
      try { const raw = localStorage.getItem(SLOT); return raw === null ? null : JSON.parse(raw) } catch (_) { return null }
    }

    function Dumb(props) {
      const sid = props.sessionId
      const draft = props.useInput((s) => s.draft)
      // 坑：条件 hook（历史 P0）—— 有字才调，hook 数量在两次渲染之间会变
      if (draft.length > 0) {
        react.useEffect(() => { globalThis.__badHook = (globalThis.__badHook || 0) + 1 }, [])
      }
      // 坑：无 debounce，每次变化即写；不判 phase / composing
      react.useEffect(() => {
        // 坑：空串跳过 → "发送后清空"这条信号被无视，旧内容永久留在镜像里（回灌温床）
        if (draft === '') return
        // 坑：纯空白照写
        localStorage.setItem(SLOT, JSON.stringify({ sid, text: draft }))
      }, [draft, sid])
      // 坑：只要 sid 变了就无脑写回（不管 phase、不管是不是刚发出去）
      react.useEffect(() => {
        const saved = readLast()
        if (saved && saved.sid === sid && saved.text) {
          props.inputActions.setDraft(saved.text)
          props.inputActions.persistDraft()
        }
      }, [sid])
      return null
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'bad-dock', select: () => null },
        (props) => react.createElement(Dumb, props),
      ))
      // 坑：裸写官方键，丢 view/viewRequest
      try { localStorage.setItem('dsh.conversation.probe', JSON.stringify({ draft: 'x' })) } catch (_) {}
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
