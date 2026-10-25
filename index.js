/**
 * Host half of the usage panel.
 *
 * Two plans are read today, from the same endpoints each vendor's own client uses:
 *
 *  - Zhipu GLM Coding Plan — `GET <base>/api/monitor/usage/quota/limit`, which returns
 *    a 5-hour token window, a weekly token window and the tool-call budget.
 *  - OpenCode Zen (Go) — `GET <base>/usage`, which returns rolling, weekly and monthly
 *    percentages together with the moment each window resets.
 *
 * The provider is taken from the session's own `model/selection` events, so the panel
 * follows the model the session is really running rather than the composer default.
 * Keys are resolved through the Host credential service and never leave this process:
 * the browser half only ever sees normalized windows.
 */

/** Route registered for the browser half; it is addressed document-relatively. */
const ROUTE = '/api/usage-panel'

/** How long one upstream answer is reused before asking again. */
const MIN_REFRESH_SECONDS = 10

/** Upper bound on a single upstream request. */
const REQUEST_TIMEOUT_MS = 8000

/**
 * @typedef {object} QuotaSettings
 * @property {string} apiKeyEnv - credential reference holding the Zhipu key.
 * @property {string} baseUrl - Zhipu API origin, without a trailing slash.
 * @property {number} refreshSeconds - cache lifetime for one upstream read.
 * @property {'auto' | 'glm' | 'opencode'} source - which plan to read.
 * @property {string} opencodeApiKeyEnv - credential reference holding the OpenCode key.
 * @property {string} opencodeBaseUrl - OpenCode API origin, without a trailing slash.
 */

/**
 * Read the settings a loader may override, falling back to the coding-plan defaults.
 * @param {Record<string, unknown>} config - raw loader config.
 * @returns {QuotaSettings} resolved settings.
 */
function resolveSettings(config) {
  const merged = {
    apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
    baseUrl: 'https://api.z.ai',
    refreshSeconds: 20,
    source: 'auto',
    opencodeApiKeyEnv: 'OPENCODE_GO_API_KEY',
    opencodeBaseUrl: 'https://opencode.ai/zen/go/v1',
  }
  if (typeof config.apiKeyEnv === 'string' && config.apiKeyEnv !== '') merged.apiKeyEnv = config.apiKeyEnv
  if (typeof config.baseUrl === 'string' && /^https?:\/\//.test(config.baseUrl)) {
    merged.baseUrl = config.baseUrl.replace(/\/+$/, '')
  }
  if (typeof config.opencodeApiKeyEnv === 'string' && config.opencodeApiKeyEnv !== '') {
    merged.opencodeApiKeyEnv = config.opencodeApiKeyEnv
  }
  if (typeof config.opencodeBaseUrl === 'string' && /^https?:\/\//.test(config.opencodeBaseUrl)) {
    merged.opencodeBaseUrl = config.opencodeBaseUrl.replace(/\/+$/, '')
  }
  if (config.source === 'glm' || config.source === 'opencode' || config.source === 'auto') {
    merged.source = config.source
  }
  const refresh = Number(config.refreshSeconds)
  if (Number.isFinite(refresh)) merged.refreshSeconds = Math.max(MIN_REFRESH_SECONDS, Math.round(refresh))
  return merged
}

/**
 * Describe one upstream limit in the terms the panel renders.
 * @param {any} limit - one entry of `data.limits`.
 * @returns {{ id: string, type: string, unit?: number, number?: number, usedPercent?: number, total?: number, current?: number, resetAt?: number } | undefined}
 */
function describeLimit(limit) {
  if (limit === null || typeof limit !== 'object' || typeof limit.type !== 'string') return undefined
  const usedPercent = typeof limit.percentage === 'number' ? limit.percentage : undefined
  const entry = {
    id: 'unknown',
    type: limit.type,
    ...(typeof limit.unit === 'number' ? { unit: limit.unit } : {}),
    ...(typeof limit.number === 'number' ? { number: limit.number } : {}),
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(typeof limit.usage === 'number' ? { total: limit.usage } : {}),
    ...(typeof limit.currentValue === 'number' ? { current: limit.currentValue } : {}),
    ...(typeof limit.nextResetTime === 'number' ? { resetAt: limit.nextResetTime } : {}),
  }
  if (limit.type === 'TIME_LIMIT') return { ...entry, id: 'tools' }
  if (limit.type === 'TOKENS_LIMIT' && limit.unit === 3) return { ...entry, id: 'fiveHour' }
  if (limit.type === 'TOKENS_LIMIT' && limit.unit === 6) return { ...entry, id: 'weekly' }
  return entry
}

/**
 * Turn a Zhipu `quota/limit` body into the snapshot the panel consumes.
 * @param {any} body - parsed response.
 * @returns {{ level: string | null, windows: any[] }} normalized snapshot.
 */
function normalizeGlm(body) {
  const data = body?.data ?? {}
  const limits = Array.isArray(data.limits) ? data.limits : []
  const windows = limits.map(describeLimit).filter((entry) => entry !== undefined)
  const order = { fiveHour: 0, weekly: 1, tools: 2 }
  windows.sort((left, right) => (order[left.id] ?? 9) - (order[right.id] ?? 9))
  return { level: typeof data.level === 'string' ? data.level : null, windows }
}

/**
 * Turn an OpenCode `/usage` body into the same shape. OpenCode reports how much of a
 * window was **used**, which matches the Zhipu payload, so both stay in one convention.
 * @param {any} body - parsed response.
 * @returns {{ level: string | null, windows: any[] }} normalized snapshot.
 */
function normalizeOpencode(body) {
  const usage = body?.usage ?? {}
  const order = [
    ['rolling', 'fiveHour'],
    ['weekly', 'weekly'],
    ['monthly', 'monthly'],
  ]
  const windows = []
  for (const [key, id] of order) {
    const window = usage[key]
    if (window === null || typeof window !== 'object') continue
    const resetAt = Date.parse(String(window.resetsAt ?? ''))
    windows.push({
      id,
      type: key,
      ...(typeof window.percent === 'number' ? { usedPercent: window.percent } : {}),
      ...(Number.isFinite(resetAt) ? { resetAt } : {}),
      ...(typeof window.status === 'string' ? { status: window.status } : {}),
    })
  }
  return { level: typeof body?.plan === 'string' ? body.plan : null, windows }
}

/**
 * Which plan a provider/model pair belongs to.
 * @param {unknown} provider - provider id.
 * @param {unknown} model - model id.
 * @returns {'glm' | 'opencode' | null} the plan, or null when neither applies.
 */
function sourceFor(provider, model) {
  if (typeof provider === 'string' && /opencode/i.test(provider)) return 'opencode'
  if (typeof provider === 'string' && /zai|glm|zhipu|bigmodel/i.test(provider)) return 'glm'
  /* Fall back to the model name only when the provider id says nothing at all. */
  if ((provider === null || provider === undefined) && typeof model === 'string' && /glm/i.test(model)) {
    return 'glm'
  }
  return null
}

/**
 * The model one session is actually running, taken from its own `model/selection`
 * events. The composer's default selection is a different thing: a session keeps the
 * model it was switched to, so gating on the default would show the panel in a
 * session that is running something else.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
 * @param {string | undefined} sessionId - session the panel belongs to.
 * @returns {{ provider: string | null, model: string | null, origin: 'session' | 'default' | 'error' }} selection.
 */
function currentModel(ctx, sessionId) {
  try {
    if (typeof sessionId === 'string' && sessionId !== '') {
      const session = ctx.get('sessions')?.get?.(sessionId)
      const events = session?.snapshotEvents?.() ?? []
      let latest
      for (const event of events) {
        if (event.type === 'model/selection') latest = event.data
      }
      if (latest !== undefined) {
        const provider = typeof latest.provider === 'string' ? latest.provider : null
        const model = typeof latest.model === 'string' ? latest.model : null
        return { provider, model, origin: 'session' }
      }
    }
    const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
    const provider = typeof fallback?.provider === 'string' ? fallback.provider : null
    const model = typeof fallback?.model === 'string' ? fallback.model : null
    return { provider, model, origin: 'default' }
  } catch {
    return { provider: null, model: null, origin: 'error' }
  }
}

/**
 * Build the Host half.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
 * @param {Record<string, unknown>} config - loader config.
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  /** One cache entry per plan: asking for GLM must not evict the OpenCode answer. */
  const cache = new Map()

  /**
   * Resolve the credential a plan needs.
   * @param {string} reference - credential name.
   * @returns {Promise<{ value?: string, missing?: boolean, reason?: string }>} resolution.
   */
  async function resolveKey(reference) {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return { reason: 'credentials-unavailable' }
    let resolved
    try {
      resolved = await credentials.resolve(reference)
    } catch {
      return { reason: 'credentials-unavailable' }
    }
    if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value === '') {
      return { missing: true }
    }
    return { value: resolved.value }
  }

  /**
   * Swap a credential for a body, keeping the panels' shared error vocabulary.
   * @param {string} reference - credential name.
   * @param {string} url - endpoint to read.
   * @param {(value: string) => Record<string, string>} headers - header builder.
   * @param {(body: any) => boolean} failed - whether the body is an application-level error.
   * @returns {Promise<{ body?: any, error?: string, status?: number, message?: string, missing?: boolean, reason?: string }>} outcome.
   */
  async function callPlan(reference, url, headers, failed) {
    const key = await resolveKey(reference)
    if (key.reason !== undefined) return { reason: key.reason }
    if (key.missing === true) return { missing: true }
    let response
    try {
      response = await fetch(url, {
        headers: headers(key.value),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      return { error: 'network', message: String(error?.message ?? error) }
    }
    if (response.ok !== true) return { error: 'http', status: response.status }
    let body
    try {
      body = await response.json()
    } catch {
      return { error: 'invalid-json' }
    }
    if (failed(body) === true) {
      return { error: 'api', message: String(body?.msg ?? body?.error?.message ?? 'quota request failed') }
    }
    return { body }
  }

  /**
   * Read one plan, reusing its cache entry unless a refresh was asked for.
   * @param {'glm' | 'opencode'} source - which plan to read.
   * @param {boolean} force - ignore a fresh cache entry.
   * @returns {Promise<object>} the snapshot payload.
   */
  async function readSource(source, force) {
    const entry = cache.get(source)
    if (force !== true && entry !== undefined && Date.now() - entry.at < settings.refreshSeconds * 1000) {
      return entry.snapshot
    }

    let outcome
    let normalized
    let keyReference = settings.apiKeyEnv
    if (source === 'glm') {
      outcome = await callPlan(
        settings.apiKeyEnv,
        `${settings.baseUrl}/api/monitor/usage/quota/limit`,
        (value) => ({ authorization: value, accept: 'application/json' }),
        (body) => body?.success === false || (typeof body?.code === 'number' && body.code !== 200),
      )
      if (outcome.body !== undefined) normalized = normalizeGlm(outcome.body)
    } else {
      keyReference = settings.opencodeApiKeyEnv
      outcome = await callPlan(
        settings.opencodeApiKeyEnv,
        `${settings.opencodeBaseUrl}/usage`,
        (value) => ({ authorization: `Bearer ${value}`, accept: 'application/json' }),
        (body) => body?.usage === undefined,
      )
      if (outcome.body !== undefined) normalized = normalizeOpencode(outcome.body)
    }

    let snapshot
    if (normalized !== undefined) {
      snapshot = {
        configured: true,
        source,
        ...normalized,
        fetchedAt: Date.now(),
        baseUrl: source === 'glm' ? settings.baseUrl : settings.opencodeBaseUrl,
      }
    } else if (outcome.missing === true) {
      snapshot = { configured: false, reason: 'missing-key', source, key: keyReference }
    } else if (outcome.reason !== undefined) {
      snapshot = { configured: false, reason: outcome.reason, source }
    } else {
      snapshot = {
        configured: true,
        source,
        error: outcome.error,
        ...(outcome.status === undefined ? {} : { status: outcome.status }),
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
      }
    }

    cache.set(source, { at: Date.now(), snapshot })
    return snapshot
  }

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const params = new URL(request.url).searchParams
        const sessionId = params.get('session') ?? undefined
        try {
          const active = currentModel(ctx, sessionId)
          const source = settings.source === 'auto' ? sourceFor(active.provider, active.model) : settings.source

          /* The browser asks who the current plan is before it renders anything, so the
           * gate never guesses from a model name and never touches an upstream endpoint. */
          if (params.get('probe') === '1') {
            return Response.json(
              { source, provider: active.provider, model: active.model, origin: active.origin },
              { headers: { 'cache-control': 'no-store' } },
            )
          }

          if (source === null) {
            return Response.json(
              { configured: false, reason: 'unrelated-provider', source: null, activeModel: active },
              { headers: { 'cache-control': 'no-store' } },
            )
          }

          const snapshot = await readSource(source, params.get('refresh') === '1')
          return Response.json(
            {
              ...snapshot,
              activeModel: active,
              defaultSelection: (() => {
                try {
                  const selection = ctx.agentDefaultModel?.currentSelection?.()
                  return selection === undefined || selection === null
                    ? null
                    : {
                        provider: typeof selection.provider === 'string' ? selection.provider : null,
                        model: typeof selection.model === 'string' ? selection.model : null,
                        reasoningEffort:
                          typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : null,
                      }
                } catch {
                  return null
                }
              })(),
            },
            { headers: { 'cache-control': 'no-store' } },
          )
        } catch (error) {
          return Response.json({ configured: true, error: 'internal', message: String(error?.message ?? error) })
        }
      },
    }),
  )
}

export const name = 'usage-panel'
export const inject = ['connection', 'agentDefaultModel']
