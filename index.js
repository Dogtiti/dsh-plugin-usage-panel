/**
 * Host half of the GLM quota bundle.
 *
 * The ZCode client reads the coding-plan quota from
 * `GET <base>/api/monitor/usage/quota/limit` with the API key in an
 * `authorization` header. That endpoint answers three windows for a coding plan:
 * a 5-hour token window, a weekly token window, and the tool-call budget. This
 * half resolves the key through the Host credential service, calls the endpoint,
 * normalizes the windows, and serves the snapshot on `/api/glm-quota` for the
 * browser half. The key never leaves the Host process.
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
 * @property {string} baseUrl - API origin, without a trailing slash.
 * @property {number} refreshSeconds - cache lifetime for one upstream read.
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
  }
  if (typeof config.apiKeyEnv === 'string' && config.apiKeyEnv !== '') merged.apiKeyEnv = config.apiKeyEnv
  if (typeof config.baseUrl === 'string' && /^https?:\/\//.test(config.baseUrl)) {
    merged.baseUrl = config.baseUrl.replace(/\/+$/, '')
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
 * Turn an upstream body into the snapshot the panel consumes.
 * @param {any} body - parsed `quota/limit` response.
 * @returns {{ level: string | null, windows: any[] }} normalized snapshot.
 */
function normalizeSnapshot(body) {
  const data = body?.data ?? {}
  const limits = Array.isArray(data.limits) ? data.limits : []
  const windows = limits.map(describeLimit).filter((entry) => entry !== undefined)
  const order = { fiveHour: 0, weekly: 1, tools: 2 }
  windows.sort((left, right) => (order[left.id] ?? 9) - (order[right.id] ?? 9))
  return { level: typeof data.level === 'string' ? data.level : null, windows }
}

/**
 * Whether a provider/model pair belongs to the GLM coding plan.
 * @param {unknown} provider - provider id.
 * @param {unknown} model - model id.
 * @returns {boolean} true when either id names GLM or Z.ai.
 */
function isGlmPair(provider, model) {
  return [provider, model].some(
    (value) => typeof value === 'string' && /zai|glm|zhipu|bigmodel/i.test(value),
  )
}

/**
 * The model one session is actually running, taken from its own `model/selection`
 * events. The composer's default selection is a different thing: a session keeps the
 * model it was switched to, so gating on the default would show the panel in a
 * session that is running something else.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
 * @param {string | undefined} sessionId - session the panel belongs to.
 * @returns {{ provider: string | null, model: string | null, isGlm: boolean, source: string }} selection.
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
        return { provider, model, isGlm: isGlmPair(provider, model), source: 'session' }
      }
    }
    const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
    const provider = typeof fallback?.provider === 'string' ? fallback.provider : null
    const model = typeof fallback?.model === 'string' ? fallback.model : null
    return { provider, model, isGlm: isGlmPair(provider, model), source: 'default' }
  } catch {
    return { provider: null, model: null, isGlm: false, source: 'error' }
  }
}

/**
 * Build the Host half.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
 * @param {Record<string, unknown>} config - loader config.
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  let cached = null
  let cachedAt = 0

  /**
   * Read the quota once per cache window.
   * @param {boolean} force - ignore a fresh cache entry.
   * @returns {Promise<object>} the snapshot payload.
   */
  async function readQuota(force, sessionId) {
    const now = Date.now()
    if (force !== true && cached !== null && now - cachedAt < settings.refreshSeconds * 1000) {
      return { ...cached, activeModel: currentModel(ctx, sessionId) }
    }

    const credentials = ctx.get('credentials')
    if (credentials === undefined) return { configured: false, reason: 'credentials-unavailable' }
    let resolved
    try {
      resolved = await credentials.resolve(settings.apiKeyEnv)
    } catch {
      return { configured: false, reason: 'credentials-unavailable' }
    }
    if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value === '') {
      return { configured: false, reason: 'missing-key', key: settings.apiKeyEnv }
    }

    let response
    try {
      response = await fetch(`${settings.baseUrl}/api/monitor/usage/quota/limit`, {
        headers: { authorization: resolved.value, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      return { configured: true, error: 'network', message: String(error?.message ?? error) }
    }
    if (response.ok !== true) return { configured: true, error: 'http', status: response.status }
    let body
    try {
      body = await response.json()
    } catch {
      return { configured: true, error: 'invalid-json' }
    }
    if (body?.success === false || (typeof body?.code === 'number' && body.code !== 200)) {
      return { configured: true, error: 'api', message: String(body?.msg ?? 'quota request failed') }
    }

    const snapshot = {
      configured: true,
      ...normalizeSnapshot(body),
      fetchedAt: Date.now(),
      baseUrl: settings.baseUrl,
      activeModel: currentModel(ctx, sessionId),
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


    }
    cached = snapshot
    cachedAt = now
    return snapshot
  }

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const params = new URL(request.url).searchParams
        const force = params.get('refresh') === '1'
        const sessionId = params.get('session') ?? undefined
        try {
          return Response.json(await readQuota(force, sessionId), { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          return Response.json({ configured: true, error: 'internal', message: String(error?.message ?? error) })
        }
      },
    }),
  )
}

export const name = 'usage-panel'
export const inject = ['connection', 'agentDefaultModel']
