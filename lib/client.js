// dsh-power-menu — browser half.
// Registers a power button in the session header utilities list (the
// top-right row, left of the native sidebar corner toggle) and a small
// Windows-style pull-down menu with exactly two actions:
//
//   关闭DSH — end the whole desktop app (graceful host shutdown)
//   重启DSH — end it and relaunch the same executable
//
// Both actions POST to the host half, which hands the process transition to a
// detached helper. The page then dims with a "shutting down / restarting"
// overlay until the window goes away (shutdown) or the app comes back.
//
// Bundle format required by DSH's client module loader.
window.__ModuleLoader__.load({
  id: 'dsh-power-menu',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const h = react.createElement

    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal
    } catch {
      createPortal = null
    }

    const inject = ['slots']

    const CSS_ID = 'dsh-power-menu-css'
    const CSS = [
      '.dshpm-root{display:inline-flex;align-items:center;justify-content:center;-webkit-app-region:no-drag}',
      '.dshpm-floating{position:fixed;z-index:2147481000;pointer-events:auto}',
      '.dshpm-trigger{display:flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#5f5f66);cursor:pointer;-webkit-app-region:no-drag;transition:background .14s ease,color .14s ease}',
      '.dshpm-trigger:hover,.dshpm-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1b1b20)}',
      '.dshpm-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-focus,#4d6bfe);outline-offset:1px}',
      '.dshpm-menu{position:fixed;z-index:2147482000;box-sizing:border-box;min-width:172px;padding:6px;border-radius:13px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));box-shadow:0 14px 36px rgba(0,0,0,.18),0 3px 10px rgba(0,0,0,.08);-webkit-app-region:no-drag;animation:dshpm-pop .12s ease-out}',
      '.dshpm-item{display:flex;align-items:center;gap:14px;width:100%;height:44px;padding:0 14px;border:none;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary,#1b1b20);font-family:inherit;font-size:15px;line-height:1;text-align:left;cursor:pointer;outline:none}',
      '.dshpm-item:hover,.dshpm-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dshpm-item:active{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.1))}',
      '.dshpm-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none;color:var(--dsw-alias-label-secondary,#5f5f66)}',
      '.dshpm-item:hover .dshpm-icon,.dshpm-item:focus-visible .dshpm-icon{color:var(--dsw-alias-label-primary,#1b1b20)}',
      '.dshpm-label{flex:1;white-space:nowrap}',
      '.dshpm-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(10,10,14,.22);backdrop-filter:blur(1.5px);-webkit-backdrop-filter:blur(1.5px);animation:dshpm-fade .16s ease-out}',
      '.dshpm-toast{display:flex;align-items:center;gap:12px;padding:16px 22px;border-radius:13px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b20);font-size:14px;box-shadow:0 16px 44px rgba(0,0,0,.24)}',
      '.dshpm-spinner{width:16px;height:16px;flex:none;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:dshpm-spin .8s linear infinite}',
      '.dshpm-error{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483001;max-width:min(520px,calc(100vw - 32px));box-sizing:border-box;padding:10px 14px;border-radius:10px;background:var(--dsw-alias-state-error-primary,#c62828);color:#fff;font-size:13px;line-height:1.45;box-shadow:0 10px 28px rgba(0,0,0,.24)}',
      '@keyframes dshpm-pop{from{opacity:0;transform:translateY(-4px) scale(.985)}to{opacity:1;transform:none}}',
      '@keyframes dshpm-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes dshpm-spin{to{transform:rotate(360deg)}}',
    ].join('')

    function ensureCss() {
      if (typeof document === 'undefined') return
      let tag = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.pluginCss = CSS_ID
        document.head.append(tag)
      }
      if (tag.textContent !== CSS) tag.textContent = CSS
    }

    function PowerIcon({ size = 20 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M12 3.2v8.4' }),
      h('path', { d: 'M6.15 6.55a8 8 0 1 0 11.7 0' }))
    }

    function RestartIcon({ size = 20 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
      h('path', { d: 'M3 3v5h5' }))
    }

    function RefreshIcon({ size = 20 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }),
        h('path', { d: 'M20 5v6h-6' }))
    }

    function MenuItem({ icon, label, onSelect, itemRef }) {
      return h('button', {
        type: 'button',
        role: 'menuitem',
        tabIndex: -1,
        ref: itemRef,
        className: 'dshpm-item',
        onClick: onSelect,
      },
      h('span', { className: 'dshpm-icon' }, icon),
      h('span', { className: 'dshpm-label' }, label))
    }

    function PowerMenuButton({ placement = 'footer' } = {}) {
      const [open, setOpen] = react.useState(false)
      const [anchor, setAnchor] = react.useState(null)
      const [phase, setPhase] = react.useState(null)
      const [error, setError] = react.useState(null)
      const triggerRef = react.useRef(null)
      const menuRef = react.useRef(null)
      const itemRefs = react.useRef([])
      const phaseRef = react.useRef(null)

      ensureCss()

      const place = react.useCallback(() => {
        const el = triggerRef.current
        if (el === null) return
        const rect = el.getBoundingClientRect()
        const menuWidth = 200
        const menuHeight = 172
        const openUp = window.innerHeight - rect.bottom < menuHeight + 16
        const openLeft = window.innerWidth - rect.right < menuWidth + 16
        setAnchor({
          ...(openUp
            ? { bottom: Math.max(8, Math.round(window.innerHeight - rect.top + 8)) }
            : { top: Math.round(rect.bottom + 8) }),
          ...(openLeft
            ? { right: Math.max(8, Math.round(window.innerWidth - rect.right)) }
            : { left: Math.round(rect.right + 8) }),
        })
      }, [])

      react.useEffect(() => {
        if (!open) return undefined
        place()
        const onResize = () => place()
        window.addEventListener('resize', onResize)
        window.addEventListener('scroll', onResize, true)
        return () => {
          window.removeEventListener('resize', onResize)
          window.removeEventListener('scroll', onResize, true)
        }
      }, [open, place])

      react.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (menuRef.current?.contains(event.target)) return
          if (triggerRef.current?.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
            triggerRef.current?.focus()
          }
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      react.useEffect(() => {
        if (!open) return
        const first = itemRefs.current[0]
        if (first !== null && first !== undefined) first.focus()
      }, [open])

      const onMenuKeyDown = (event) => {
        const items = itemRefs.current.filter(Boolean)
        if (items.length === 0) return
        const index = items.indexOf(document.activeElement)
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          items[(index + 1 + items.length) % items.length].focus()
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          items[(index - 1 + items.length) % items.length].focus()
        } else if (event.key === 'Home') {
          event.preventDefault()
          items[0].focus()
        } else if (event.key === 'End') {
          event.preventDefault()
          items[items.length - 1].focus()
        } else if (event.key === 'Tab') {
          setOpen(false)
        }
      }

      const run = async (mode) => {
        if (phaseRef.current !== null) return
        phaseRef.current = mode
        setOpen(false)
        setError(null)
        setPhase(mode)
        try {
          const response = await fetch(`/api/dsh-power-menu/${mode}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          let payload = {}
          try {
            payload = await response.json()
          } catch {
            payload = {}
          }
          if (!response.ok || payload.ok === false) {
            throw new Error(payload.error || `HTTP ${response.status}`)
          }
        } catch (err) {
          phaseRef.current = null
          setPhase(null)
          const message = err instanceof Error ? err.message : String(err)
          setError(`操作未执行：${message}`)
          window.setTimeout(() => setError(null), 7000)
        }
      }

      const menu = open && h('div', {
        ref: menuRef,
        className: 'dshpm-menu',
        role: 'menu',
        'data-dshpm-menu': '',
        'aria-label': '电源菜单',
        style: anchor === null ? { top: 60, right: 16 } : anchor,
        onKeyDown: onMenuKeyDown,
      },
      h(MenuItem, {
        icon: h(RefreshIcon, { size: 20 }),
        label: '刷新页面',
        itemRef: (el) => { itemRefs.current[0] = el },
        onSelect: () => {
          setOpen(false)
          try { window.location.reload() } catch (_e) {}
        },
      }),
      h(MenuItem, {
        icon: h(PowerIcon, { size: 21 }),
        label: '关闭DSH',
        itemRef: (el) => { itemRefs.current[1] = el },
        onSelect: () => run('shutdown'),
      }),
      h(MenuItem, {
        icon: h(RestartIcon, { size: 21 }),
        label: '重启DSH',
        itemRef: (el) => { itemRefs.current[2] = el },
        onSelect: () => run('restart'),
      }))

      const overlay = phase !== null && h('div', { className: 'dshpm-overlay' },
        h('div', { className: 'dshpm-toast', role: 'status', 'aria-live': 'assertive' },
          h('span', { className: 'dshpm-spinner' }),
          h('span', null, phase === 'restart' ? '正在重启DSH…' : '正在关闭DSH…')))

      const errorToast = error !== null && h('div', { className: 'dshpm-error', role: 'alert' }, error)

      const trigger = h('div', {
        className: 'dshpm-root',
      },
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'dshpm-trigger',
          title: '电源',
          'aria-label': '电源菜单',
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          'data-dshpm-slot': placement,
          onClick: () => {
            setError(null)
            setOpen((value) => !value)
          },
        }, h(PowerIcon, { size: 16 })))

      const layers = h(react.Fragment, null, menu, overlay, errorToast)
      const canPortal = createPortal !== null && typeof document !== 'undefined'
      return h(react.Fragment, null,
        trigger,
        canPortal ? createPortal(layers, document.body) : layers)
    }

    function PowerMenuSlot() {
      const [mount, setMount] = react.useState(null)

      react.useLayoutEffect(() => {
        let node = null
        let observer = null
        const ensure = () => {
          const corner = document.querySelector('[data-conversation-header-corner]')
          if (corner === null) {
            if (node !== null) {
              node.remove()
              node = null
              setMount(null)
            }
            return
          }
          let appended = false
          if (node === null) {
            node = document.createElement('span')
            node.setAttribute('data-dshpm-mount', '')
            node.style.cssText = 'display:inline-flex;align-items:center;margin-left:4px;'
            setMount(node)
            appended = true
          }
          if (node.parentElement !== corner || corner.lastElementChild !== node) {
            corner.appendChild(node)
            appended = true
          }
          if (appended) {
            // 0.1.16 also forced a header reflow after appending. Without it,
            // the welcome screen's native left panel icon only appears after
            // the user manually resizes the window.
            void corner.offsetHeight
            window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
          }
        }
        ensure()
        // 0.1.16 caught the welcome header's delayed corner with a 500ms
        // interval. Observe the document instead: the corner can appear after
        // the first layout (the welcome screen does this), and a resize alone
        // is not guaranteed to fire.
        observer = new MutationObserver(() => ensure())
        observer.observe(document.body, { childList: true, subtree: true })
        window.addEventListener('resize', ensure)
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', ensure)
          if (node !== null) node.remove()
        }
      }, [])

      if (mount === null || createPortal === null) return null
      return createPortal(h(PowerMenuButton, { placement: 'header' }), mount)
    }

    function apply(ctx) {
      ensureCss()
      // 0.1.16 mounted this through `shell.overlay`, which is root-scoped and
      // therefore present on the no-session welcome screen too. The component
      // itself waits for `[data-conversation-header-corner]` and appends the
      // power button inside it, after the native sidebar toggle.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-power-menu',
        order: 100,
        registrant: 'dsh-power-menu',
      }, PowerMenuSlot))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
