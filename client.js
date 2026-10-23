/**
 * Client half of the GLM quota bundle.
 *
 * The dock entry is a one-chip trigger; clicking it opens a popover card shaped like
 * the ZCode client's quota panel: the plan level, one column per window (label, the
 * remaining share, the reset date, a thin bar), and the refresh time. The Host half
 * owns the API key and the upstream call; this half only reads its snapshot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-usage-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Route registered by the Host half, addressed document-relatively. */
    const ROUTE = 'api/usage-panel'

    /** How often the popover refreshes while the page stays open. */
    const POLL_MS = 15000

    /** Windows in display order, with the accent the ZCode panel uses for each. */
    const WINDOWS = [
      { id: 'fiveHour', accent: '#2f6fed' },
      { id: 'weekly', accent: '#16a34a' },
      { id: 'tools', accent: '#7c3aed' },
    ]

    /** Labels for both shipped languages, registered into the app locale service. */
    const TEXT = {
      zh: {
        fiveHour: '5 小时',
        weekly: '每周',
        tools: '工具调用',
        title: '剩余额度',
        level: '套餐',
        resets: '重置',
        failed: '额度不可用',
        remaining: '剩余',
        updated: '更新于',
        show: '查看 GLM 额度',
      },
      en: {
        fiveHour: '5h',
        weekly: 'Week',
        tools: 'Tools',
        title: 'Remaining quota',
        level: 'Plan',
        resets: 'resets',
        failed: 'Quota unavailable',
        remaining: 'remaining',
        updated: 'Updated',
        show: 'Show GLM quota',
      },
    }

    /** Card geometry, so the popover reads like the reference panel. */
    const CARD = {
      width: '352px',
      radius: '14px',
      padding: '16px 18px 12px',
    }

    /**
     * The model the composer is actually showing.
     *
     * The Host exposes no current-model selection to plugins: `agentDefaultModel`
     * resolves to undefined here, the session snapshot and projections carry no model
     * field, and the model slot's owner props are only `{locked}`. The rendered label is
     * therefore the single trustworthy source, and an unreadable label hides the panel
     * rather than guessing.
     * @returns {string} the label text, or '' when it cannot be read.
     */
    function composerModelText() {
      try {
        /* The model control carries an accessible label naming the current model in
         * both shipped languages, which is far steadier than the hashed CSS classes. */
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
     * Format a reset timestamp the way the reference panel does: month and day,
     * written in the active interface language rather than the browser default.
     * @param {number} ms - epoch milliseconds.
     * @param {string} active - active locale id.
     * @returns {string} a localized short date, or an empty string.
     */
    function formatReset(ms, active) {
      try {
        const tag = String(active ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
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
    function Column({ win, accent, t, active }) {
      const remaining = remainingOf(win)
      const reset = typeof win.resetAt === 'number' ? formatReset(win.resetAt, active) : ''
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0, flex: '1 1 0' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', opacity: 0.7 } },
          h('span', null, t(win.id)),
          reset === ''
            ? null
            : h(
                'span',
                {
                  style: {
                    fontSize: '10px',
                    lineHeight: '14px',
                    padding: '0 5px',
                    borderRadius: '999px',
                    background: 'rgba(22,163,74,0.12)',
                    color: '#15803d',
                    whiteSpace: 'nowrap',
                  },
                },
                t('resets'),
              ),
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
     * The dock entry: a chip that opens the quota card.
     * @param {{ t: (key: string) => string, locale: { subscribe: Function, getSnapshot: Function } }} props
     */
    function QuotaEntry({ t, locale, sessionId }) {
      const [snapshot, setSnapshot] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [modelText, setModelText] = React.useState(() => composerModelText())
      const rootRef = React.useRef(null)
      /* Re-render on a language switch so the labels follow the app. */
      React.useSyncExternalStore(locale.subscribe, locale.getSnapshot, locale.getSnapshot)

      React.useEffect(() => {
        let alive = true
        const read = async () => {
          try {
            /* The session decides the model: a session keeps the model it was switched
             * to, which is not necessarily the composer's default. */
            const query = typeof sessionId === 'string' && sessionId !== '' ? `?session=${encodeURIComponent(sessionId)}` : ''
            const response = await fetch(`${ROUTE}${query}`, { headers: { accept: 'application/json' } })
            const body = await response.json()
            if (alive) setSnapshot(body)
          } catch (error) {
            if (alive) setSnapshot({ configured: true, error: 'unreachable', message: String(error?.message ?? error) })
          }
        }
        void read()
        const timer = setInterval(() => void read(), POLL_MS)
        const onFocus = () => void read()
        window.addEventListener('focus', onFocus)
        return () => {
          alive = false
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [sessionId])

      /* The label changes without a re-render here, so poll it cheaply. */
      React.useEffect(() => {
        const timer = setInterval(() => setModelText(composerModelText()), 2000)
        return () => clearInterval(timer)
      }, [])

      React.useEffect(() => {
        if (open !== true) return undefined
        const onPointer = (event) => {
          if (rootRef.current !== null && rootRef.current.contains(event.target) !== true) setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onPointer)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      if (snapshot === null || snapshot.configured === false) return null
      /* Only the GLM coding plan has a quota here; any other selection prints nothing. */
      if (!/glm/i.test(modelText)) return null
      const windows = Array.isArray(snapshot.windows) ? snapshot.windows : []
      const columns = WINDOWS.map((entry) => ({ entry, win: windows.find((win) => win.id === entry.id) })).filter(
        (pair) => pair.win !== undefined,
      )
      const failed = typeof snapshot.error === 'string'
      if (failed !== true && columns.length === 0) return null

      /* The chip headlines the tightest window, so the number has a meaning. */
      const tightest = columns
        .map((pair) => remainingOf(pair.win))
        .filter((value) => value !== null)
        .reduce((low, value) => (low === null || value < low ? value : low), null)
      /* The effort is only truthful when the configured default names the model on
       * screen; otherwise the session runs something the selection does not describe. */
      const effort =
        snapshot.defaultSelection !== null &&
        snapshot.defaultSelection !== undefined &&
        typeof snapshot.defaultSelection.model === 'string' &&
        snapshot.defaultSelection.model === modelText.trim() &&
        typeof snapshot.defaultSelection.reasoningEffort === 'string'
          ? snapshot.defaultSelection.reasoningEffort
          : null
      const chipColor =
        tightest === null ? 'var(--dsh-text-secondary, #6b7280)' : tightest <= 10 ? '#dc2626' : tightest <= 30 ? '#d97706' : '#16a34a'

      return h(
        'div',
        { ref: rootRef, style: { position: 'relative', display: 'inline-flex', justifyContent: 'flex-end' } },
        h(
          'button',
          {
            type: 'button',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            title: [t('show'), effort === null ? '' : `${t('effort')} ${effort}`].filter((part) => part !== '').join(' · '),
            onClick: (event) => {
              event.preventDefault()
              setOpen((value) => !value)
            },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '1px 8px',
              borderRadius: '999px',
              border: '1px solid var(--dsh-border-subtle, rgba(120,120,120,0.22))',
              background: 'transparent',
              color: 'var(--dsh-text-secondary, #6b7280)',
              fontFamily: 'inherit',
              fontSize: '11px',
              lineHeight: '16px',
              cursor: 'pointer',
            },
          },
          h('span', { style: { width: '6px', height: '6px', borderRadius: '50%', background: chipColor } }),
          h('span', null, 'GLM'),
          tightest === null
            ? null
            : h(
                'span',
                {
                  style: {
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--dsh-text-primary, #111827)',
                  },
                },
                `${String(tightest)}%`,
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
                  width: CARD.width,
                  padding: CARD.padding,
                  borderRadius: CARD.radius,
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
                {
                  style: {
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: '12px',
                    marginBottom: '14px',
                  },
                },
                h('span', { style: { fontSize: '14px', fontWeight: 600 } }, t('title')),
                typeof snapshot.level === 'string' && snapshot.level !== ''
                  ? h(
                      'span',
                      {
                        style: {
                          fontSize: '11px',
                          padding: '1px 7px',
                          borderRadius: '999px',
                          background: 'rgba(124,58,237,0.10)',
                          color: '#6d28d9',
                        },
                      },
                      `${t('level')} ${snapshot.level}`,
                    )
                  : null,
              ),
              failed === true
                ? h('div', { style: { fontSize: '12px', opacity: 0.6 } }, `${t('failed')} · ${snapshot.error}`)
                : h(
                    'div',
                    { style: { display: 'flex', alignItems: 'flex-start', gap: '18px' } },
                    ...columns.map((pair) =>
                      h(Column, {
                        key: pair.entry.id,
                        win: pair.win,
                        accent: pair.entry.accent,
                        t,
                        active: locale.getSnapshot().active,
                      }),
                    ),
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
                h('span', null, t('updated')),
                h(
                  'span',
                  null,
                  new Date(snapshot.fetchedAt ?? Date.now()).toLocaleTimeString(
                    String(locale.getSnapshot().active ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US',
                    { hour: '2-digit', minute: '2-digit' },
                  ),
                ),
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
        /* Bind the service methods: passing them detached loses `this`. */
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
