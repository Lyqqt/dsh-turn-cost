/**
 * Host half of dsh-turn-cost.
 *
 * Three jobs:
 *
 * 1. Own the price book. The browser half must never talk to the network: the
 *    machine that needs a SOCKS proxy for models.dev is exactly the one whose
 *    browser cannot reach it. So the host fetches (and caches to disk), merges
 *    the user's own entries, and serves one small JSON document.
 * 2. Serve that document at `/dsh-turn-cost/prices.json` over the same
 *    webServer that serves the GUI, so the browser needs no CORS and no `.dsh`
 *    file access.
 * 3. Give the user a seam for their own prices — three, in increasing power:
 *    `overrides` in the entry config, `priceModules` pointing at plain `.mjs`
 *    files, and `ctx.turnCost.registerPriceSource()` for a real plugin.
 *
 * Everything here is optional: with no network, the built-in DeepSeek CNY
 * catalog plus `overrides` still prices the common case.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { pathToFileURL } from 'node:url'
import {
  DEEPSEEK, DEFAULT_PROVIDERS, normalizeConfig, buildFromModelsDev, buildFromOpenRouter,
  buildOverrides, normalizeModuleResult, mergeEntries, rate, asObject, number,
} from './book.js'

export { DEEPSEEK, buildFromModelsDev, buildFromOpenRouter, normalizeConfig } from './book.js'

/**
 * Defaults for the entry config. Exported as documentation rather than as a
 * schemastery schema on purpose: this package is installed with `link:`, and
 * Node resolves bare imports from the link target's realpath, where the
 * profile's `@deepseek-ai/schemastery` is not reachable. Cordis passes the raw
 * entry config to `apply`, and the resolved config travels to the browser half
 * inside the price book, so no host schema is needed.
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  currency: 'CNY',
  usdToCny: 7.2,
  unknownDisplay: 'dash',
  showRequests: true,
  priceNote: '',
  proxy: '',
  refreshHours: 24,
  providers: DEFAULT_PROVIDERS,
  providerMap: { 'deepseek-official': 'deepseek' },
  aliases: {},
  overrides: [],
  priceModules: [],
  sources: { modelsDev: true, openrouter: false },
}


/**
 * Merge a patch over the aggregated book, keeping models.dev's context tiers
 * when the patch source does not carry them.
 *
 * The OpenRouter catalog is more current than models.dev but publishes no
 * tiers, so a naive override would silently halve the price of a >272k-token
 * request to a tiered model.
 */
function mergeWithTiers(base, patch) {
  const out = mergeEntries(base, patch)
  for (const key of Object.keys(patch || {})) {
    const previous = base[key]
    if (previous && previous.tiers && !patch[key].tiers) out[key].tiers = previous.tiers
  }
  return out
}

// ---------------------------------------------------------------------------
// Endpoint catalog: OpenRouter prices the same model differently per upstream
// provider (measured: 6 endpoints / 12x spread for openai/gpt-6.1-sol,
// 50 endpoints / 20x for deepseek/deepseek-v4.1-flash-1017). A single
// per-model number is therefore a fiction; the browser half asks here for the
// endpoint ladder of a model it actually saw, and renders a range.
// ---------------------------------------------------------------------------
const ENDPOINT_TTL = 6 * 3600e3
const ENDPOINT_LIMIT = 200

function endpointFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'turn-cost', 'endpoints.json')
}

/** models we accept in the query string: `author/slug`, nothing path-like. */
function validModelId(model) {
  return typeof model === 'string' && /^[A-Za-z0-9._~-]+\/[A-Za-z0-9._:-]+$/.test(model)
}

function readEndpointCache() {
  try {
    const parsed = JSON.parse(readFileSync(endpointFile(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Exact per-request cost.
//
// The session log keeps OpenRouter's generation id at
//   message.source.replayState.response.responseId   ("gen-<ts>-<token>")
// which is exactly the key GET /api/v1/generation?id= takes. That endpoint
// answers which upstream provider served the call and what OpenRouter charged,
// so the browser half can replace an endpoint range with the real number.
//
// It needs the same credential the OpenRouter route already uses. Without it
// the lookup reports "no-key" once and the plugin keeps showing the range.
// ---------------------------------------------------------------------------
const GENERATION_REF = 'OPENROUTER_API_KEY'
const GENERATION_TTL = 30 * 24 * 3600e3
const GENERATION_LIMIT = 1000

function generationFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'turn-cost', 'generations.json')
}

function validGenerationId(id) {
  return typeof id === 'string' && /^gen-[A-Za-z0-9_-]{8,}$/.test(id)
}

// ---------------------------------------------------------------------------
// Cache on disk
// ---------------------------------------------------------------------------
function bookFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'turn-cost', 'book.json')
}

function readCache() {
  try {
    const parsed = JSON.parse(readFileSync(bookFile(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeCache(book) {
  const file = bookFile()
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    const temp = file + '.tmp'
    writeFileSync(temp, JSON.stringify(book), 'utf8')
    renameSync(temp, file)
  } catch {
    // A read-only home must not break pricing; the in-memory book still works.
  }
}

// ---------------------------------------------------------------------------
// HTTP: direct fetch, plus a minimal SOCKS5 CONNECT for the proxy case.
// ---------------------------------------------------------------------------
function socksOpen(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(proxy)
    } catch {
      reject(new Error('代理地址无效：' + proxy))
      return
    }
    const socket = netConnect({ host: url.hostname, port: Number(url.port || 1080) })
    let stage = 0
    let buffer = Buffer.alloc(0)
    let settled = false

    const fail = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }

    socket.setTimeout(timeoutMs, () => fail(new Error('SOCKS 握手超时')))
    socket.once('error', fail)
    socket.once('close', () => fail(new Error('SOCKS 连接被关闭')))
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])))

    const sendConnect = () => {
      const hostBytes = Buffer.from(host, 'utf8')
      socket.write(Buffer.concat([
        Buffer.from([5, 1, 0, 3, hostBytes.length]),
        hostBytes,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]))
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 0) {
        if (buffer.length < 2) return
        if (buffer[0] !== 5) return fail(new Error('SOCKS 版本不支持'))
        if (buffer[1] !== 0) return fail(new Error('SOCKS 代理要求认证'))
        buffer = buffer.slice(2)
        stage = 1
        sendConnect()
        return
      }
      if (buffer.length < 5) return
      const reply = buffer[1]
      if (reply !== 0) return fail(new Error('SOCKS CONNECT 失败（' + reply + '）'))
      const atyp = buffer[3]
      const addressLength = atyp === 1 ? 4 : atyp === 3 ? 1 + buffer[4] : atyp === 4 ? 16 : -1
      if (addressLength < 0) return fail(new Error('SOCKS 应答类型无效'))
      if (buffer.length < 4 + addressLength + 2) return
      settled = true
      socket.setTimeout(0)
      socket.removeAllListeners('data')
      socket.removeAllListeners('close')
      socket.removeAllListeners('error')
      socket.on('error', () => {})
      resolve(socket)
    })
  })
}

/**
 * One HTTP/1.1 GET over an already-tunnelled socket.
 *
 * Deliberately raw: Node's `https.request({ createConnection })` accepts the
 * pre-wrapped TLS socket but never completes the response over a SOCKS tunnel
 * (verified against models.dev), so this frames the request and parses the
 * reply itself. Only `Content-Length` and `Transfer-Encoding: chunked` occur
 * for the JSON APIs we read.
 *
 * @param stream - TLS socket (https) or plain socket (http).
 * @param host - Host header value.
 * @param path - Request target, including the query string.
 * @param timeoutMs - Idle timeout for the whole exchange.
 */
function httpGetOverSocket(stream, host, path, timeoutMs, extraHeaders) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let settled = false
    let response = null

    const cleanup = () => {
      stream.removeAllListeners('data')
      stream.removeAllListeners('end')
      stream.removeAllListeners('error')
      stream.removeAllListeners('timeout')
      stream.removeAllListeners('close')
    }
    const finish = (error, body) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        stream.destroy()
      } catch {
        // The peer may already be gone.
      }
      if (error) reject(error)
      else resolve(body)
    }

    /** Decode a `Transfer-Encoding: chunked` body, or return null while short. */
    const decodeChunked = () => {
      const parts = []
      let offset = 0
      while (offset < buffer.length) {
        const lineEnd = buffer.indexOf('\r\n', offset)
        if (lineEnd < 0) return null
        const size = parseInt(buffer.slice(offset, lineEnd).toString('latin1'), 16)
        if (!Number.isFinite(size)) return undefined
        if (size === 0) return parts.length > 0 ? Buffer.concat(parts) : Buffer.alloc(0)
        const start = lineEnd + 2
        if (buffer.length < start + size + 2) return null
        parts.push(buffer.slice(start, start + size))
        offset = start + size + 2
      }
      return null
    }

    const pump = () => {
      if (response === null) {
        const split = buffer.indexOf('\r\n\r\n')
        if (split < 0) return
        const head = buffer.slice(0, split).toString('latin1').split('\r\n')
        const status = parseInt((head[0] || '').split(' ')[1], 10)
        const headers = {}
        for (const line of head.slice(1)) {
          const colon = line.indexOf(':')
          if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
        }
        response = { status, headers }
        buffer = buffer.slice(split + 4)
        if (status !== 200) {
          finish(new Error('HTTP ' + status))
          return
        }
      }

      const length = response.headers['content-length']
      if (length !== undefined) {
        const expected = Number(length)
        if (buffer.length < expected) return
        finish(null, buffer.slice(0, expected).toString('utf8'))
        return
      }
      if ((response.headers['transfer-encoding'] || '').toLowerCase().indexOf('chunked') >= 0) {
        const body = decodeChunked()
        if (body === undefined) {
          finish(new Error('chunked 编码无效'))
          return
        }
        if (body === null) return
        finish(null, body.toString('utf8'))
        return
      }
      // No framing headers: the body ends when the peer closes.
    }

    stream.setTimeout(timeoutMs, () => finish(new Error('读取超时')))
    stream.on('error', (error) => finish(error))
    stream.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        pump()
      } catch (error) {
        finish(error)
      }
    })
    stream.on('end', () => {
      if (settled) return
      if (response === null) finish(new Error('响应为空'))
      else if (response.headers['content-length'] === undefined) finish(null, buffer.toString('utf8'))
      else finish(new Error('连接提前关闭'))
    })

    const headers = Object.assign({ accept: 'application/json', 'user-agent': 'dsh-turn-cost' }, extraHeaders || {})
    const lines = ['GET ' + path + ' HTTP/1.1', 'Host: ' + host]
    for (const name of Object.keys(headers)) lines.push(name + ': ' + headers[name])
    lines.push('Connection: close', '', '')
    stream.write(lines.join('\r\n'))
  })
}

async function fetchViaSocks(url, proxy, timeoutMs, extraHeaders) {
  const target = new URL(url)
  const secure = target.protocol === 'https:'
  const port = Number(target.port || (secure ? 443 : 80))
  const socket = await socksOpen(proxy, target.hostname, port, timeoutMs)
  const path = target.pathname + target.search
  if (!secure) return httpGetOverSocket(socket, target.hostname, path, timeoutMs, extraHeaders)
  const stream = tlsConnect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] })
  await new Promise((resolve, reject) => {
    stream.once('secureConnect', resolve)
    stream.once('error', reject)
  })
  return httpGetOverSocket(stream, target.hostname, path, timeoutMs, extraHeaders)
}

async function fetchJson(url, options) {
  const timeoutMs = (options && options.timeoutMs) || 30000
  const proxy = options && options.proxy
  const extra = (options && options.headers) || {}
  if (typeof proxy === 'string' && /^socks5?h?:\/\//i.test(proxy)) {
    return JSON.parse(await fetchViaSocks(url, proxy, timeoutMs, extra))
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: Object.assign({ accept: 'application/json' }, extra),
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Optional file config: `<DSH home>/turn-cost/config.json`.
 *
 * The cordis entry config is read once, when the host composition is built, so
 * a proxy added later only takes effect after a restart. This file is re-read
 * on every rebuild, which makes it the escape hatch for exactly that case.
 * Entry config wins over the file for any key both define.
 */
function fileConfigPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'turn-cost', 'config.json')
}

function readFileConfig() {
  try {
    const parsed = JSON.parse(readFileSync(fileConfigPath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** The subset of config the browser half needs, carried inside the book. */
function configForClient(config) {
  return {
    enabled: config.enabled,
    currency: config.currency,
    usdToCny: config.usdToCny,
    unknownDisplay: config.unknownDisplay,
    showRequests: config.showRequests,
    priceNote: config.priceNote,
    providerMap: config.providerMap,
    overrides: config.overrides,
    endpointRanges: config.endpointRanges,
    pricers: config.pricers,
    generationLookup: config.generationLookup,
    generationLookback: config.generationLookback,
  }
}

export function apply(ctx, rawConfig) {
  let config = normalizeConfig({ ...readFileConfig(), ...(rawConfig || {}) })
  const rawEntryConfig = rawConfig || {}
  const warnings = []
  /** Price sources registered at runtime by other plugins. */
  const extraSources = []
  const state = { book: null, generatedAt: 0, refreshing: null, lastError: '' }
  let lastAttemptAt = 0

  const log = {
    warn: (message) => {
      warnings.push(String(message).slice(0, 300))
      if (warnings.length > 20) warnings.splice(0, warnings.length - 20)
    },
  }

  // A fresh cache makes a restart instant; a stale one keeps serving while the
  // first refresh runs.
  const cached = readCache()
  if (cached && cached.generatedAt) {
    state.book = cached
    state.generatedAt = cached.generatedAt
  }

  async function build() {
    // Re-read the file layer on every rebuild: it is the only way to change the
    // proxy (or any other field) without restarting the host.
    config = normalizeConfig({ ...readFileConfig(), ...rawEntryConfig })
    lastAttemptAt = Date.now()
    const nextWarnings = []
    let entries = {}
    let byModel = {}
    const sourceState = {}

    if (config.sources.modelsDev !== false) {
      try {
        const data = await fetchJson('https://models.dev/api.json', { proxy: config.proxy, timeoutMs: 45000 })
        const built = buildFromModelsDev(data, config.providers)
        entries = mergeWithTiers(entries, built.entries)
        byModel = mergeEntries(byModel, built.byModel)
        sourceState.modelsDev = { ok: true, models: Object.keys(built.entries).length }
      } catch (error) {
        sourceState.modelsDev = { ok: false, error: String((error && error.message) || error).slice(0, 200) }
        nextWarnings.push('models.dev 获取失败：' + sourceState.modelsDev.error)
      }
    }

    if (config.sources.openrouter === true) {
      try {
        const data = await fetchJson('https://openrouter.ai/api/v1/models', { proxy: config.proxy, timeoutMs: 30000 })
        const built = buildFromOpenRouter(data)
        entries = mergeWithTiers(entries, built.entries)
        byModel = mergeEntries(byModel, built.byModel)
        sourceState.openrouter = { ok: true, models: Object.keys(built.entries).length }
      } catch (error) {
        sourceState.openrouter = { ok: false, error: String((error && error.message) || error).slice(0, 200) }
        nextWarnings.push('OpenRouter 获取失败：' + sourceState.openrouter.error)
      }
    }

    // User overrides win over every fetched catalog.
    entries = mergeWithTiers(entries, buildOverrides(config.overrides))

    // User modules and registered sources run last: they are the escape hatch.
    const moduleAliases = {}
    const runSource = async (run, label) => {
      try {
        if (typeof run !== 'function') throw new Error('需要提供 refresh() 函数')
        const result = normalizeModuleResult(await run({
          fetchJson: (url, options) => fetchJson(url, { proxy: config.proxy, ...(options || {}) }),
          config,
          log,
        }))
        entries = mergeWithTiers(entries, result.entries)
        Object.assign(moduleAliases, result.aliases)
      } catch (error) {
        nextWarnings.push(label + '：' + String((error && error.message) || error).slice(0, 200))
      }
    }

    for (const spec of config.priceModules) {
      try {
        const loaded = await import(pathToFileURL(spec).href + '?t=' + Date.now())
        await runSource(loaded.default ?? loaded.refresh ?? loaded.load, '价格模块失败 ' + spec)
      } catch (error) {
        nextWarnings.push('价格模块加载失败 ' + spec + '：' + String((error && error.message) || error).slice(0, 200))
      }
    }
    for (const source of extraSources) {
      await runSource(source.refresh || source.load, '价格源失败 ' + (source.id || '(匿名)'))
    }

    const book = {
      ok: true,
      version: 1,
      generatedAt: Date.now(),
      currency: 'CNY',
      config: configForClient(config),
      entries,
      byModel,
      aliases: { ...config.aliases, ...moduleAliases },
      providerMap: config.providerMap,
      deepseek: DEEPSEEK,
      sources: sourceState,
      warnings: nextWarnings,
    }
    state.book = book
    state.generatedAt = book.generatedAt
    state.lastError = nextWarnings.length > 0 ? nextWarnings[nextWarnings.length - 1] : ''
    warnings.length = 0
    warnings.push(...nextWarnings)
    writeCache(book)
    return book
  }

  function refresh() {
    if (state.refreshing !== null) return state.refreshing
    state.refreshing = build()
      .catch((error) => {
        state.lastError = String((error && error.message) || error).slice(0, 200)
        return state.book
      })
      .finally(() => {
        state.refreshing = null
      })
    return state.refreshing
  }

  /**
   * Whether the book needs a rebuild. A failed or empty book counts as stale,
   * so recovering from a bad proxy does not have to wait for the 30-minute
   * timer — but never retry more often than once a minute, or a permanently
   * unreachable network would hammer the route.
   */
  const stale = () => {
    if (Date.now() - lastAttemptAt < 60e3) return false
    if (state.generatedAt === 0) return true
    if (state.lastError !== '') return true
    if (state.book === null || Object.keys(state.book.entries || {}).length === 0) return true
    return Date.now() - state.generatedAt > config.refreshHours * 3600e3
  }

  // Warm the book at startup without blocking the dock.
  if (stale()) setTimeout(() => { refresh() }, 1000).unref?.()

  const timer = setInterval(() => { if (stale()) refresh() }, 30 * 60e3)
  timer.unref?.()
  ctx.effect(() => () => {
    clearInterval(timer)
  }, 'turn-cost: refresh timer')


  // --- generation lookup (exact cost) --------------------------------------
  const generations = new Map(Object.entries(readJsonFile(generationFile())))
  const generationInflight = new Map()
  let credentialResolver = null
  let credentialChecked = null

  function readJsonFile(file) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function writeGenerationCache() {
    try {
      const file = generationFile()
      mkdirSync(join(file, '..'), { recursive: true })
      const temp = file + '.tmp'
      writeFileSync(temp, JSON.stringify(Object.fromEntries(generations)), 'utf8')
      renameSync(temp, file)
    } catch {
      // Cache is an optimisation.
    }
  }

  /** Resolve the OpenRouter key through the host credential service. */
  async function openrouterKey() {
    if (credentialChecked === 'no-service') return null
    if (credentialResolver === null) {
      try {
        credentialResolver = (ref) => ctx.credentials.resolve(ref).then((hit) => (hit && hit.value) || null)
      } catch {
        credentialChecked = 'no-service'
        return null
      }
    }
    if (credentialChecked !== null && typeof credentialChecked === 'string') {
      if (credentialChecked === 'no-key') return null
    }
    try {
      const value = await credentialResolver(GENERATION_REF)
      credentialChecked = value === null ? 'no-key' : 'ok'
      return value
    } catch {
      credentialChecked = 'no-key'
      return null
    }
  }

  /**
   * One generation record: which provider served it and what it cost.
   * @param id - OpenRouter generation id (`gen-...`).
   * @returns { ok, provider, model, costUsd, tokens } or { ok: false, reason }.
   */
  async function generationFor(id) {
    if (!validGenerationId(id)) return { ok: false, reason: 'bad-id' }
    const hit = generations.get(id)
    if (hit && Date.now() - (hit.at || 0) < GENERATION_TTL) return hit.value
    if (generationInflight.has(id)) return generationInflight.get(id)
    const task = (async () => {
      const key = await openrouterKey()
      if (key === null) return { ok: false, reason: 'no-key' }
      try {
        const data = await fetchJson('https://openrouter.ai/api/v1/generation?id=' + encodeURIComponent(id), {
          proxy: config.proxy,
          timeoutMs: 15000,
          headers: { authorization: 'Bearer ' + key },
        })
        const record = asObject(data && data.data)
        const value = {
          ok: true,
          provider: typeof record.provider_name === 'string' ? record.provider_name : '',
          model: typeof record.model === 'string' ? record.model : '',
          costUsd: number(record.total_cost),
          upstreamUsd: number(record.upstream_inference_cost),
          prompt: number(record.tokens_prompt),
          completion: number(record.tokens_completion),
        }
        generations.set(id, { at: Date.now(), value })
        if (generations.size > GENERATION_LIMIT) {
          const oldest = [...generations.entries()].sort((left, right) => (left[1].at || 0) - (right[1].at || 0))[0]
          if (oldest) generations.delete(oldest[0])
        }
        writeGenerationCache()
        return value
      } catch (error) {
        const reason = String((error && error.message) || error).slice(0, 120)
        const value = { ok: false, reason }
        // Do not cache transient failures; a 404 means the record is gone.
        if (reason.indexOf('404') >= 0) {
          generations.set(id, { at: Date.now(), value })
          writeGenerationCache()
        }
        return value
      } finally {
        generationInflight.delete(id)
      }
    })()
    generationInflight.set(id, task)
    return task
  }

  // --- endpoint ladder ----------------------------------------------------
  const endpoints = new Map(Object.entries(readEndpointCache()))
  const endpointsInflight = new Map()

  function writeEndpointCache() {
    try {
      const file = endpointFile()
      mkdirSync(join(file, '..'), { recursive: true })
      const temp = file + '.tmp'
      writeFileSync(temp, JSON.stringify(Object.fromEntries(endpoints)), 'utf8')
      renameSync(temp, file)
    } catch {
      // Cache is an optimisation; the in-memory map still answers.
    }
  }

  /** The per-provider price ladder of one OpenRouter model, cached. */
  function endpointsFor(model) {
    if (!validModelId(model)) return Promise.resolve(null)
    const hit = endpoints.get(model)
    if (hit && Array.isArray(hit.providers) && Date.now() - (hit.at || 0) < ENDPOINT_TTL) return Promise.resolve(hit)
    if (endpointsInflight.has(model)) return endpointsInflight.get(model)
    const task = (async () => {
      try {
        const data = await fetchJson('https://openrouter.ai/api/v1/models/' + model + '/endpoints', {
          proxy: config.proxy,
          timeoutMs: 20000,
        })
        const list = asObject(data && data.data) && Array.isArray(data.data.endpoints) ? data.data.endpoints : []
        const providers = list.map((entry) => {
          const pricing = asObject(entry && entry.pricing)
          const perMillion = (value) => rate(number(Number(value)) * 1e6)
          return {
            name: typeof (entry && entry.provider_name) === 'string' ? entry.provider_name : '',
            quant: typeof (entry && entry.quantization) === 'string' ? entry.quantization : '',
            input: perMillion(pricing.prompt),
            cacheRead: perMillion(pricing.input_cache_read !== undefined ? pricing.input_cache_read : pricing.prompt),
            cacheWrite: perMillion(pricing.input_cache_write !== undefined ? pricing.input_cache_write : pricing.prompt),
            output: perMillion(pricing.completion),
          }
        }).filter((provider) => provider.input > 0 || provider.output > 0)
        const record = { at: Date.now(), providers }
        endpoints.set(model, record)
        if (endpoints.size > ENDPOINT_LIMIT) {
          const oldest = [...endpoints.entries()].sort((left, right) => (left[1].at || 0) - (right[1].at || 0))[0]
          if (oldest) endpoints.delete(oldest[0])
        }
        writeEndpointCache()
        return record
      } catch (error) {
        warnings.push('端点价格获取失败 ' + model + '：' + String((error && error.message) || error).slice(0, 160))
        return hit || null
      } finally {
        endpointsInflight.delete(model)
      }
    })()
    endpointsInflight.set(model, task)
    return task
  }

  // --- HTTP route ---------------------------------------------------------
  ctx.inject(['webServer'], (scope) => {
    let disposeEndpoints = null
    let disposeGeneration = null
    const dispose = scope.webServer.register({
      kind: 'exact',
      path: '/dsh-turn-cost/prices.json',
      handler: (req, res) => {
        if (stale()) refresh()
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify(state.book ?? {
          ok: false,
          generatedAt: 0,
          config: configForClient(config),
          deepseek: DEEPSEEK,
          entries: {},
          byModel: {},
          aliases: config.aliases,
          providerMap: config.providerMap,
          sources: {},
          warnings: ['价格目录尚未就绪'],
        }))
      },
    })

    // Per-model endpoint ladder, fetched lazily for the models a turn used.
    disposeEndpoints = scope.webServer.register({
      kind: 'exact',
      path: '/dsh-turn-cost/endpoints.json',
      handler: async (req, res) => {
        let model = ''
        try {
          model = new URL(req.url || '/', 'http://localhost').searchParams.get('model') || ''
        } catch {
          model = ''
        }
        const disabled = asObject(config.pricers).openrouter === false
        const record = model === '' || disabled ? null : await endpointsFor(model)
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify({ ok: record !== null, model, providers: record === null ? [] : record.providers }))
      },
    })

    // Exact cost for one generation id.
    disposeGeneration = scope.webServer.register({
      kind: 'exact',
      path: '/dsh-turn-cost/generation.json',
      handler: async (req, res) => {
        let id = ''
        try {
          id = new URL(req.url || '/', 'http://localhost').searchParams.get('id') || ''
        } catch {
          id = ''
        }
        const value = await generationFor(id)
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify(value))
      },
    })

    return () => {
      for (const disposer of [dispose, disposeEndpoints, disposeGeneration]) {
        try {
          disposer?.()
        } catch {
          // Already disposed by a hot reload.
        }
      }
    }
  })

  // --- Programmatic seam --------------------------------------------------
  const service = {
    /** Force a rebuild now (e.g. after adding a module). */
    refresh,
    /** Current book, or null before the first build. */
    get: () => state.book,
    /** Diagnostics for a settings panel or a bug report. */
    status: () => ({
      generatedAt: state.generatedAt,
      entries: state.book ? Object.keys(state.book.entries).length : 0,
      lastError: state.lastError,
      warnings: [...warnings],
      sources: state.book ? state.book.sources : {},
    }),
    /**
     * Register a price source from another plugin:
     *
     *   ctx.inject(['turnCost'], (ctx) => ctx.turnCost.registerPriceSource({
     *     id: 'my-prices',
     *     async refresh({ fetchJson }) { return { entries: { 'openrouter|x': {...} } } },
     *   }))
     *
     * @returns a disposer that unregisters the source.
     */
    registerPriceSource(source) {
      if (!source || typeof source !== 'object') return () => {}
      extraSources.push(source)
      refresh()
      return () => {
        const index = extraSources.indexOf(source)
        if (index >= 0) extraSources.splice(index, 1)
        refresh()
      }
    },
  }
  try {
    ctx.provide('turnCost', service)
  } catch {
    // Older hosts expose no reflection service; the HTTP route still works.
  }
}

export const name = 'dsh-turn-cost'



