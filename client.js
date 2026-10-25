/**
 * Client half of the usage panel.
 *
 * The dock entry is one word next to the model selector: no numbers, no polling.
 * Clicking it reads the quota once (the Host answers from its cache unless asked to
 * refresh, so the click forces a fresh upstream read) and shows the ZCode-shaped card.
 * The entry only appears when the composer's model control names GLM, which is the
 * one signal the harness renders for the selected model.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-usage-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Route registered by the Host half, addressed document-relatively. */
    const ROUTE = 'api/usage-panel'

    /** A hover must last this long before it counts, so pass-through never fetches. */
    const HOVER_DELAY_MS = 150

    /** At most one upstream read per window, however often the pointer re-enters. */
    const MIN_FETCH_MS = 8000

    /** Grace period before closing, so the pointer can travel from the icon into the card. */
    const CLOSE_DELAY_MS = 160

    /** Windows in display order, with the accent the reference panel uses. */
    const WINDOWS = [
      { id: 'fiveHour', accent: '#2f6fed' },
      { id: 'weekly', accent: '#16a34a' },
      { id: 'tools', accent: '#7c3aed' },
      { id: 'monthly', accent: '#0891b2' },
    ]

    /** Labels for both shipped languages, registered into the app locale service. */
    const TEXT = {
      zh: {
        fiveHour: '5 小时',
        weekly: '每周',
        tools: '工具调用',
        monthly: '每月',
        planGlm: 'GLM Coding Plan',
        planOpencode: 'OpenCode Go',
        title: '剩余额度',
        level: '套餐',
        resets: '重置',
        failed: '额度不可用',
        remaining: '剩余',
        updated: '更新于',
        show: '查看额度',
        chip: '额度',
        loading: '读取中…',
        unconfigured: '未配置 API Key',
      },
      en: {
        fiveHour: '5h',
        weekly: 'Week',
        tools: 'Tools',
        monthly: 'Month',
        planGlm: 'GLM Coding Plan',
        planOpencode: 'OpenCode Go',
        title: 'Remaining quota',
        level: 'Plan',
        resets: 'resets',
        failed: 'Quota unavailable',
        remaining: 'remaining',
        updated: 'Updated',
        show: 'Show quota',
        chip: 'Usage',
        loading: 'Reading…',
        unconfigured: 'No API key',
      },
    }

    /**
     * The model the composer is actually showing, read from the model control's
     * accessible name. The Harness exposes no per-session model to plugins, so this
     * is the only signal that matches what the user sees; an unreadable label hides
     * the entry rather than guessing.
     * @returns {string} the model name, or '' when unreadable.
     */
    function composerModelText() {
      try {
        const node =
          document.querySelector('[aria-label^="选择模型"]') ??
          document.querySelector('[aria-label*="当前:"]') ??
          document.querySelector('[aria-label^="Select model"]') ??
          document.querySelector('[aria-label*="current:"]')
        if (node === null) return ''
        const aria = node.getAttribute('aria-label') ?? ''
        const named = aria.match(/(?:当前|current)\s*[:：]\s*([^，,]+)/i)
        return (named?.[1] ?? node.textContent ?? '').trim()
      } catch {
        return ''
      }
    }

    /**
     * Format a reset timestamp as a date in the active interface language.
     * @param {number} ms - epoch milliseconds.
     * @returns {string} a localized short date, or an empty string.
     */
    function formatReset(ms) {
      try {
        const tag = String(document.documentElement.lang ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
        return new Date(ms).toLocaleDateString(tag, { month: 'long', day: 'numeric' })
      } catch {
        return ''
      }
    }

    /**
     * Remaining share of one window.
     * @param {any} win - normalized window.
     * @returns {number|null} 0 to 100, or null when the API did not report it.
     */
    function remainingOf(win) {
      if (typeof win?.usedPercent !== 'number') return null
      return Math.max(0, Math.min(100, Math.round(100 - win.usedPercent)))
    }

    /**
     * One column of the card: label, value with its reset date, then the bar.
     * @param {{ win: any, accent: string, t: (key: string) => string }} props
     */
    function Column({ win, accent, t }) {
      const remaining = remainingOf(win)
      const reset = typeof win.resetAt === 'number' ? formatReset(win.resetAt) : ''
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0, flex: '1 1 0' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', opacity: 0.7 } },
          h('span', null, t(win.id)),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0 } },
          h(
            'span',
            {
              style: {
                fontSize: '20px',
                lineHeight: '24px',
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--dsh-text-primary, #111827)',
              },
            },
            remaining === null ? '—' : `${String(remaining)}%`,
          ),
          reset === ''
            ? null
            : h('span', { style: { fontSize: '11px', opacity: 0.55, whiteSpace: 'nowrap' } }, `· ${reset}`),
        ),
        h(
          'div',
          {
            style: {
              height: '5px',
              borderRadius: '999px',
              background: 'var(--dsh-border-subtle, rgba(120,120,120,0.18))',
              overflow: 'hidden',
            },
          },
          h('div', {
            style: {
              width: `${String(remaining ?? 0)}%`,
              height: '100%',
              borderRadius: '999px',
              background: accent,
              transition: 'width 240ms ease',
            },
          }),
        ),
      )
    }

    /**
     * The dock entry: a word that opens the quota card on demand.
     * @param {{ t: (key: string) => string, locale: { subscribe: Function, getSnapshot: Function }, sessionId?: string }} props
     */
    function QuotaEntry({ t, locale, sessionId }) {
      const [snapshot, setSnapshot] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [hovered, setHovered] = React.useState(false)
      const [modelText, setModelText] = React.useState(() => composerModelText())
      /** 'glm' | 'opencode' | null — which plan the Host says this session is running. */
      const [source, setSource] = React.useState(null)
      const rootRef = React.useRef(null)
      const closeTimer = React.useRef(null)
      const openTimer = React.useRef(null)
      const inFlight = React.useRef(false)
      const cache = React.useRef({ at: 0, body: null })
      /* Re-render on a language switch so the labels follow the app. */
      React.useSyncExternalStore(locale.subscribe, locale.getSnapshot, locale.getSnapshot)

      /* The label changes without a re-render here; a cheap read keeps the gate honest. */
      React.useEffect(() => {
        const timer = setInterval(() => setModelText(composerModelText()), 2000)
        return () => clearInterval(timer)
      }, [])

      /* Ask the Host which plan the current model belongs to. This is a local route
       * that reads session events only, so it costs nothing and never guesses from the
       * model name: `deepseek-v4.1-flash` exists on several providers. */
      React.useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const query = typeof sessionId === 'string' && sessionId !== ''
              ? `?probe=1&session=${encodeURIComponent(sessionId)}`
              : '?probe=1'
            const response = await fetch(`${ROUTE}${query}`, { headers: { accept: 'application/json' } })
            const body = await response.json()
            if (alive) setSource(typeof body.source === 'string' ? body.source : null)
          } catch {
            if (alive) setSource(null)
          }
        })()
        return () => {
          alive = false
        }
      }, [sessionId, modelText])

      React.useEffect(
        () => () => {
          if (closeTimer.current !== null) clearTimeout(closeTimer.current)
          if (openTimer.current !== null) clearTimeout(openTimer.current)
        },
        [],
      )

      /* Read the quota exactly once per opening, bypassing the Host cache. */
      React.useEffect(() => {
        if (open !== true) return undefined
        let alive = true
        /* A snapshot younger than the window is served from memory: re-hovering a few
         * times in a row must not hammer the upstream endpoint. */
        if (cache.current.body !== null && Date.now() - cache.current.at < MIN_FETCH_MS) {
          setSnapshot(cache.current.body)
        } else if (inFlight.current !== true) {
          inFlight.current = true
          void (async () => {
            try {
              const params = []
              if (typeof sessionId === 'string' && sessionId !== '') {
                params.push(`session=${encodeURIComponent(sessionId)}`)
              }
              params.push('refresh=1')
              const response = await fetch(`${ROUTE}?${params.join('&')}`, { headers: { accept: 'application/json' } })
              const body = await response.json()
              cache.current = { at: Date.now(), body }
              if (alive) setSnapshot(body)
            } catch (error) {
              if (alive) {
                setSnapshot({ configured: true, error: 'unreachable', message: String(error?.message ?? error) })
              }
            } finally {
              inFlight.current = false
            }
          })()
        }
        const onPointer = (event) => {
          if (rootRef.current !== null && rootRef.current.contains(event.target) !== true) setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
          alive = false
          document.removeEventListener('pointerdown', onPointer)
          document.removeEventListener('keydown', onKey)
        }
      }, [open, sessionId])

      /* The Host names the plan for this session; nothing else is read as a guess. */
      if (source === null) return null

      const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : []
      const columns = WINDOWS.map((entry) => ({ entry, win: windows.find((win) => win.id === entry.id) })).filter(
        (pair) => pair.win !== undefined,
      )
      const failed = typeof snapshot?.error === 'string'
      const missing = snapshot !== null && snapshot.configured === false

      return h(
        'div',
        {
          ref: rootRef,
          style: { position: 'relative', display: 'inline-flex', justifyContent: 'flex-end' },
          onMouseEnter: () => {
            if (closeTimer.current !== null) {
              clearTimeout(closeTimer.current)
              closeTimer.current = null
            }
            if (openTimer.current !== null) return
            openTimer.current = setTimeout(() => {
              openTimer.current = null
              setOpen(true)
            }, HOVER_DELAY_MS)
          },
          onMouseLeave: () => {
            if (openTimer.current !== null) {
              clearTimeout(openTimer.current)
              openTimer.current = null
            }
            if (closeTimer.current !== null) clearTimeout(closeTimer.current)
            closeTimer.current = setTimeout(() => {
              closeTimer.current = null
              setOpen(false)
            }, CLOSE_DELAY_MS)
          },
        },
        h(
          'button',
          {
            type: 'button',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': t('show'),
            title: t('show'),
            onClick: (event) => {
              event.preventDefault()
              setOpen(true)
            },
            onFocus: () => setOpen(true),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '22px',
              height: '22px',
              padding: 0,
              borderRadius: '6px',
              border: 'none',
              background: hovered === true || open === true ? 'var(--dsh-surface-raised, rgba(120,120,120,0.10))' : 'transparent',
              color: hovered === true || open === true
                ? 'var(--dsh-text-primary, #111827)'
                : 'var(--dsh-text-secondary, #6b7280)',
              cursor: 'pointer',
              transition: 'background 120ms ease, color 120ms ease',
            },
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
          },
          /* A small bar-chart mark: three ascending bars, drawn inline so no asset load is needed. */
          h(
            'svg',
            { width: '15', height: '15', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
            h('rect', { x: '2.4', y: '8.6', width: '2.7', height: '5.0', rx: '1', fill: 'currentColor' }),
            h('rect', { x: '6.65', y: '5.4', width: '2.7', height: '8.2', rx: '1', fill: 'currentColor' }),
            h('rect', { x: '10.9', y: '2.4', width: '2.7', height: '11.2', rx: '1', fill: 'currentColor' }),
          ),
        ),
        open !== true
          ? null
          : h(
              'div',
              {
                role: 'dialog',
                'aria-label': t('title'),
                style: {
                  position: 'absolute',
                  right: 0,
                  bottom: '100%',
                  marginBottom: '8px',
                  width: '352px',
                  padding: '16px 18px 12px',
                  borderRadius: '14px',
                  border: '1px solid var(--dsh-border-strong, rgba(0,0,0,0.10))',
                  background: 'var(--dsh-surface-overlay, #ffffff)',
                  boxShadow: '0 12px 32px rgba(0,0,0,0.16)',
                  color: 'var(--dsh-text-primary, #111827)',
                  fontFamily: 'inherit',
                  zIndex: 60,
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' } },
                h('span', { style: { fontSize: '14px', fontWeight: 600 } }, t('title')),
                (() => {
                  const plan = snapshot?.source === 'glm'
                    ? t('planGlm')
                    : snapshot?.source === 'opencode'
                      ? t('planOpencode')
                      : null
                  const badge = typeof snapshot?.level === 'string' && snapshot.level !== ''
                    ? `${plan ?? ''} ${snapshot.level}`.trim()
                    : plan
                  if (badge === null || badge === '') return null
                  return h(
                    'span',
                    {
                      style: {
                        fontSize: '11px',
                        padding: '1px 7px',
                        borderRadius: '999px',
                        background: 'rgba(124,58,237,0.10)',
                        color: '#6d28d9',
                        whiteSpace: 'nowrap',
                      },
                    },
                    badge,
                  )
                })(),
              ),
              snapshot === null
                ? h('div', { style: { fontSize: '12px', opacity: 0.6 } }, t('loading'))
                : missing === true
                  ? h('div', { style: { fontSize: '12px', opacity: 0.6 } }, t('unconfigured'))
                  : failed === true
                    ? h('div', { style: { fontSize: '12px', opacity: 0.6 } }, `${t('failed')} · ${snapshot.error}`)
                    : h(
                        'div',
                        { style: { display: 'flex', alignItems: 'flex-start', gap: '18px' } },
                        ...columns.map((pair) => h(Column, { key: pair.entry.id, win: pair.win, accent: pair.entry.accent, t })),
                      ),
              h(
                'div',
                {
                  style: {
                    marginTop: '14px',
                    paddingTop: '10px',
                    borderTop: '1px solid var(--dsh-border-subtle, rgba(120,120,120,0.14))',
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '11px',
                    opacity: 0.5,
                  },
                },
                h('span', null, t('remaining')),
                h('span', null, snapshot === null ? '—' : new Date(snapshot.fetchedAt ?? Date.now()).toLocaleTimeString()),
              ),
            ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('usage-panel', 'zh', TEXT.zh))
        ctx.effect(() => ctx.locale.register('usage-panel', 'en', TEXT.en))
        const t = ctx.locale.bind('usage-panel')
        const locale = {
          subscribe: (listener) => ctx.locale.subscribe(listener),
          getSnapshot: () => ctx.locale.getSnapshot(),
        }
        ctx.slots.inject('conversation.input.activity', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.activity',
              id: 'usage-panel',
            },
            (props) => h(QuotaEntry, { ...props, t, locale }),
          ),
        )
      },
    }
  },
})
