/**
 * Pure price-book data: catalogs, normalization and merge rules.
 *
 * Deliberately free of Node built-ins and of DSH imports so the offline test
 * harness can load it without a host. The browser half keeps its own small
 * copy of the DeepSeek catalog (a client bundle cannot import modules), so
 * DEEPSEEK here and DEEPSEEK in lib/client.js must stay in sync.
 */

/** CNY per million tokens. Peak = Beijing weekdays 09:00–12:00 / 14:00–18:00. */
export const DEEPSEEK = {
  currency: 'CNY',
  peakHours: [[9 * 60, 12 * 60], [14 * 60, 18 * 60]],
  models: {
    'deepseek-flash': {
      aliases: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
      offpeak: { input: 1, cacheRead: 0.02, output: 4 },
      peak: { input: 2, cacheRead: 0.04, output: 8 },
    },
    'deepseek-v4-pro': {
      aliases: [],
      offpeak: { input: 4.5, cacheRead: 0.15, output: 13.5 },
      peak: { input: 9, cacheRead: 0.3, output: 27 },
    },
  },
  holidays: [
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    '2026-10-05', '2026-10-06', '2026-10-07',
  ],
}

export const DEFAULT_PROVIDERS = [
  'openrouter', 'deepseek', 'openai', 'anthropic', 'google', 'moonshot',
  'zhipuai', 'minimax', 'xai', 'alibaba', 'deepinfra', 'siliconflow',
  'volcengine', 'zhipu', 'kimi',
]

/** Round a rate to 1e-6 USD; keeps 0.000002*1e6 from becoming 0.09999999999999999. */
export function rate(value) {
  return Math.round(number(value) * 1e6) / 1e6
}

export function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** Defensive normalization of the resolved entry config. */
export function normalizeConfig(value) {
  const raw = asObject(value)
  return {
    enabled: raw.enabled !== false,
    currency: raw.currency === 'USD' ? 'USD' : 'CNY',
    usdToCny: typeof raw.usdToCny === 'number' && raw.usdToCny > 0 ? raw.usdToCny : 7.2,
    unknownDisplay: raw.unknownDisplay === 'hidden' ? 'hidden' : 'dash',
    showRequests: raw.showRequests !== false,
    endpointRanges: raw.endpointRanges !== false,
    pricers: asObject(raw.pricers),
    generationLookup: raw.generationLookup !== false,
    generationLookback: typeof raw.generationLookback === 'number' && raw.generationLookback >= 0 ? raw.generationLookback : 10,
    priceNote: typeof raw.priceNote === 'string' ? raw.priceNote : '',
    proxy: typeof raw.proxy === 'string' ? raw.proxy.trim() : '',
    refreshHours: typeof raw.refreshHours === 'number' && raw.refreshHours > 0 ? raw.refreshHours : 24,
    providers: asArray(raw.providers).filter((id) => typeof id === 'string' && id !== ''),
    providerMap: asObject(raw.providerMap),
    aliases: asObject(raw.aliases),
    overrides: asArray(raw.overrides).filter((entry) => entry && typeof entry === 'object'),
    priceModules: asArray(raw.priceModules).filter((path) => typeof path === 'string' && path !== ''),
    sources: asObject(raw.sources),
  }
}

/** One models.dev model record -> our entry (USD per million tokens). */
export function entryOfModel(model) {
  const cost = asObject(model && model.cost)
  const entry = {
    input: rate(cost.input),
    cacheRead: rate(cost.cache_read !== undefined ? cost.cache_read : cost.input),
    cacheWrite: rate(cost.cache_write !== undefined ? cost.cache_write : cost.input),
    output: rate(cost.output),
    currency: 'USD',
  }
  // models.dev puts `tiers` inside `cost`, next to the base rates.
  const tiers = asArray(cost.tiers !== undefined ? cost.tiers : (model && model.tiers))
    .map((tier) => ({
      size: number(asObject(tier && tier.tier).size),
      input: number(tier.input),
      cacheRead: number(tier.cache_read !== undefined ? tier.cache_read : tier.input),
      cacheWrite: number(tier.cache_write !== undefined ? tier.cache_write : tier.input),
      output: number(tier.output),
    }))
    .filter((tier) => tier.size > 0)
    .sort((left, right) => left.size - right.size)
  if (tiers.length > 0) entry.tiers = tiers
  return entry
}

/** models.dev api.json -> { entries, byModel } restricted to `providers`. */
export function buildFromModelsDev(data, providers) {
  const entries = {}
  const byModel = {}
  const wanted = asArray(providers).length > 0 ? providers : DEFAULT_PROVIDERS
  for (const provider of wanted) {
    const models = asObject(asObject(data && data[provider]).models)
    for (const modelId of Object.keys(models)) {
      const entry = entryOfModel(models[modelId])
      if (entry.input === 0 && entry.output === 0) continue
      entries[provider + '|' + modelId] = entry
      if (byModel[modelId] === undefined) byModel[modelId] = entry
    }
  }
  return { entries, byModel }
}

/** OpenRouter /api/v1/models -> { entries, byModel }. Prices arrive per token. */
export function buildFromOpenRouter(data) {
  const entries = {}
  const byModel = {}
  for (const model of asArray(data && data.data)) {
    const id = typeof (model && model.id) === 'string' ? model.id : ''
    if (id === '') continue
    const pricing = asObject(model.pricing)
    const perMillion = (value) => rate(number(Number(value)) * 1e6)
    const entry = {
      input: rate(perMillion(pricing.prompt)),
      cacheRead: rate(perMillion(pricing.input_cache_read !== undefined ? pricing.input_cache_read : pricing.prompt)),
      cacheWrite: rate(perMillion(pricing.input_cache_write !== undefined ? pricing.input_cache_write : pricing.prompt)),
      output: rate(perMillion(pricing.completion)),
      currency: 'USD',
    }
    if (entry.input === 0 && entry.output === 0 && entry.cacheRead === 0) continue
    entries['openrouter|' + id] = entry
    if (byModel[id] === undefined) byModel[id] = entry
  }
  return { entries, byModel }
}

/**
 * User `overrides` -> entries. Only exact `provider|model` keys land in the
 * book; the browser applies the looser substring rules from the same config.
 */
export function buildOverrides(overrides) {
  const entries = {}
  for (const raw of asArray(overrides)) {
    if (!raw || typeof raw !== 'object') continue
    const match = typeof raw.match === 'string' ? raw.match : ''
    if (match === '' || match.indexOf('|') < 0) continue
    entries[match] = {
      input: number(raw.input),
      cacheRead: number(raw.cacheRead !== undefined ? raw.cacheRead : raw.input),
      cacheWrite: number(raw.cacheWrite !== undefined ? raw.cacheWrite : raw.input),
      output: number(raw.output),
      currency: raw.currency === 'CNY' ? 'CNY' : 'USD',
    }
  }
  return entries
}

/** Normalize whatever a price module (or a registered source) returned. */
export function normalizeModuleResult(result) {
  if (!result || typeof result !== 'object') return { entries: {}, aliases: {} }
  const entries = {}
  const aliases = {}
  const source = asObject(result.entries || result.prices)
  for (const key of Object.keys(source)) {
    const raw = asObject(source[key])
    entries[key] = {
      input: number(raw.input),
      cacheRead: number(raw.cacheRead !== undefined ? raw.cacheRead : raw.input),
      cacheWrite: number(raw.cacheWrite !== undefined ? raw.cacheWrite : raw.input),
      output: number(raw.output),
      currency: raw.currency === 'CNY' ? 'CNY' : 'USD',
    }
    if (Array.isArray(raw.tiers)) entries[key].tiers = raw.tiers
  }
  const rawAliases = asObject(result.aliases)
  for (const key of Object.keys(rawAliases)) {
    const value = rawAliases[key]
    if (typeof value === 'string') aliases[key] = value
    else if (value && typeof value === 'object') {
      const provider = typeof value.provider === 'string' ? value.provider : ''
      const model = typeof value.model === 'string' ? value.model : ''
      if (model !== '') aliases[key] = (provider !== '' ? provider + '|' : '') + model
    }
  }
  return { entries, aliases }
}

export function mergeEntries(...groups) {
  const out = {}
  for (const group of groups) for (const key of Object.keys(group || {})) out[key] = group[key]
  return out
}
