// dsh-power-menu — browser half.
// Registers a power button in the session header utilities list (the
// top-right row, left of the native sidebar corner toggle) and a small
// Windows-style pull-down menu with three actions:
//
//   刷新页面 — rebuild the renderer only; the host, sessions and jobs survive
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
      '.dshpm-confirm{position:relative;box-sizing:border-box;display:flex;flex-direction:column;width:min(430px,calc(100vw - 40px));max-height:min(560px,calc(100vh - 80px));padding:20px 20px 16px;border-radius:16px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b20);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));box-shadow:0 26px 70px rgba(0,0,0,.32);animation:dshpm-pop .14s ease-out}',
      '.dshpm-confirm-title{margin:0 0 6px;font-size:16px;font-weight:600;line-height:1.4}',
      '.dshpm-confirm-sub{margin:0 0 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,#5f5f66)}',
      '.dshpm-tasklist{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;margin:0 0 16px;padding:0;list-style:none}',
      '.dshpm-task{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.035))}',
      '.dshpm-task-head{display:flex;align-items:baseline;gap:8px;font-size:13.5px;font-weight:600;line-height:1.35}',
      '.dshpm-task-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshpm-task-badge{flex:none;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#5f5f66);font-size:11px;font-weight:500}',
      '.dshpm-task-job{font-size:12.5px;line-height:1.45;color:var(--dsw-alias-label-secondary,#5f5f66);overflow-wrap:anywhere}',
      '.dshpm-task-meta{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary,#5f5f66);opacity:.85}',
      '.dshpm-actions{display:flex;flex:none;justify-content:flex-end;gap:10px}',
      '.dshpm-btn{height:34px;padding:0 16px;border:1px solid transparent;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1b1b20);font-family:inherit;font-size:13.5px;line-height:1;cursor:pointer}',
      '.dshpm-btn:hover{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.1))}',
      '.dshpm-btn:focus-visible{outline:2px solid var(--dsw-alias-state-focus,#4d6bfe);outline-offset:1px}',
      '.dshpm-btn-danger{background:var(--dsw-alias-state-error-primary,#c62828);color:#fff}',
      '.dshpm-btn-danger:hover{filter:brightness(.94);background:var(--dsw-alias-state-error-primary,#c62828)}',
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
      h('path', { d: 'M20.4 12a8.4 8.4 0 1 1-2.46-5.94' }),
      h('path', { d: 'M20.4 4.2v5h-5' }))
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

    /** Compact "how long has this been running" label. */
    function formatElapsed(startedAt) {
      if (!Number.isFinite(startedAt)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      if (seconds < 60) return `${String(seconds)} 秒`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${String(minutes)} 分 ${String(seconds % 60)} 秒`
      return `${String(Math.floor(minutes / 60))} 小时 ${String(minutes % 60)} 分`
    }

    function jobLine(job, key) {
      const label = typeof job.label === 'string' && job.label !== '' ? job.label : (job.kind || '后台任务')
      const progress = typeof job.progress === 'string' && job.progress !== '' ? ` · ${job.progress}` : ''
      const elapsed = formatElapsed(job.startedAt)
      const suffix = elapsed === '' ? '' : `（已运行 ${elapsed}）`
      return h('div', { className: 'dshpm-task-job', key }, label + progress + suffix)
    }

    /** The "what exactly is it doing" lines under one session row. */
    function sessionLines(session) {
      const rows = (Array.isArray(session.jobs) ? session.jobs : [])
        .map((job, index) => jobLine(job, 'j-' + String(session.id) + '-' + String(index)))
      if (rows.length === 0 && session.status === 'running') {
        rows.push(h('div', { className: 'dshpm-task-job', key: 'gen-' + String(session.id) }, '模型正在生成回复'))
      }
      return rows
    }

    function PowerMenuButton({ placement = 'footer' } = {}) {
      const [open, setOpen] = react.useState(false)
      const [anchor, setAnchor] = react.useState(null)
      const [phase, setPhase] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [confirming, setConfirming] = react.useState(null)
      /** Bumped once a second while the gate is open so the elapsed clocks keep moving. */
      const [, setClock] = react.useState(0)
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
        if (confirming === null) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setConfirming(null)
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [confirming])

      react.useEffect(() => {
        if (confirming === null) return undefined
        const timer = window.setInterval(() => {
          setClock((tick) => tick + 1)
        }, 1000)
        return () => {
          window.clearInterval(timer)
        }
      }, [confirming])

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

      /** Reload the renderer only: the host, its sessions and running jobs survive. */
      const reloadPage = () => {
        setOpen(false)
        try {
          window.location.reload()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(`刷新失败：${message}`)
          window.setTimeout(() => setError(null), 7000)
        }
      }

      /** Fire the transition after the gate above has been cleared. */
      const execute = async (mode) => {
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

      /**
       * Gate a transition on live work. The host answers with the same
       * agents+jobs snapshot the desktop build uses for its own quit prompt,
       * so an idle app keeps the one-click behavior and a busy one asks.
       */
      const ask = async (mode) => {
        if (phaseRef.current !== null) return
        setOpen(false)
        setError(null)
        let payload = null
        try {
          const response = await fetch('/api/dsh-power-menu/tasks', {
            method: 'GET',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (response.ok) payload = await response.json()
        } catch {
          payload = null
        }
        const sessions = payload !== null && Array.isArray(payload.sessions) ? payload.sessions : []
        const ownerless = payload !== null && Array.isArray(payload.ownerless) ? payload.ownerless : []
        if (payload === null || payload.available !== true || payload.active !== true || sessions.length + ownerless.length === 0) {
          void execute(mode)
          return
        }
        setConfirming({ mode, sessions, ownerless })
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
        icon: h(RefreshIcon, { size: 21 }),
        label: '刷新页面',
        itemRef: (el) => { itemRefs.current[0] = el },
        onSelect: reloadPage,
      }),
      h(MenuItem, {
        icon: h(PowerIcon, { size: 21 }),
        label: '关闭DSH',
        itemRef: (el) => { itemRefs.current[1] = el },
        onSelect: () => ask('shutdown'),
      }),
      h(MenuItem, {
        icon: h(RestartIcon, { size: 21 }),
        label: '重启DSH',
        itemRef: (el) => { itemRefs.current[2] = el },
        onSelect: () => ask('restart'),
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

      const confirmLayer = confirming !== null && h('div', {
        className: 'dshpm-overlay',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) setConfirming(null)
        },
      },
      h('div', {
        className: 'dshpm-confirm',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': confirming.mode === 'restart' ? '确认重启DSH' : '确认关闭DSH',
      },
      h('h2', { className: 'dshpm-confirm-title' },
        confirming.mode === 'restart' ? '还有任务在跑，确定重启 DSH？' : '还有任务在跑，确定关闭 DSH？'),
      h('p', { className: 'dshpm-confirm-sub' },
        `${confirming.mode === 'restart' ? '重启' : '关闭'}会立刻打断下面 ${String(confirming.sessions.length + confirming.ownerless.length)} 项工作，进行中的内容不会保留。`),
      h('ul', { className: 'dshpm-tasklist' },
        confirming.sessions.map((session) => h('li', { className: 'dshpm-task', key: 's-' + String(session.id) },
          h('div', { className: 'dshpm-task-head' },
            h('span', { className: 'dshpm-task-title', title: typeof session.title === 'string' ? session.title : '' },
              typeof session.title === 'string' && session.title !== '' ? session.title : '未命名会话'),
            session.status === 'running' ? h('span', { className: 'dshpm-task-badge' }, '生成中') : null),
          sessionLines(session))),
        confirming.ownerless.map((job, index) => h('li', { className: 'dshpm-task', key: 'o-' + String(index) },
          h('div', { className: 'dshpm-task-head' },
            h('span', { className: 'dshpm-task-title' }, '后台任务'),
            h('span', { className: 'dshpm-task-badge' }, '进行中')),
          jobLine(job, 'oj-' + String(index))))),
      h('div', { className: 'dshpm-actions' },
        h('button', {
          type: 'button',
          className: 'dshpm-btn',
          onClick: () => setConfirming(null),
        }, '取消'),
        h('button', {
          type: 'button',
          className: 'dshpm-btn dshpm-btn-danger',
          onClick: () => {
            const mode = confirming.mode
            setConfirming(null)
            void execute(mode)
          },
        }, confirming.mode === 'restart' ? '仍然重启' : '仍然关闭'))))
      const layers = h(react.Fragment, null, menu, overlay, errorToast, confirmLayer)
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
