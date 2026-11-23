/**
 * Offline self-test for dsh-turn-cost.
 *
 * Loads the real browser bundle with a tiny React stand-in, feeds it the exact
 * node shape the Chat snapshot exposes, and checks the pricing rules the
 * plugin promises: per-request pricing, DeepSeek peak/off-peak, holidays,
 * alias and routing-suffix resolution, `:free`, USD conversion, tiers,
 * user overrides, unpriced handling and the turn-tail fallback.
 *
 * Run: node test/run-tests.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildFromModelsDev, buildFromOpenRouter, buildOverrides, normalizeModuleResult, mergeEntries, DEEPSEEK,
} from '../lib/book.js'

const here = dirname(fileURLToPath(import.meta.url))

// --- minimal React ---------------------------------------------------------
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  memo(fn) {
    const wrapped = (props) => fn(props)
    wrapped.__memo = true
    wrapped.__inner = fn
    return wrapped
  },
  useMemo(fn) { return fn() },
  useEffect() {},
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  Fragment: Symbol('Fragment'),
}

// --- load the browser bundle ----------------------------------------------
const registrations = []
const fakeWindow = { __ModuleLoader__: { load(reg) { registrations.push(reg) } } }
new Function('window', readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8'))(fakeWindow)
if (registrations.length !== 1) throw new Error(`expected one registration, got ${registrations.length}`)
const registration = registrations[0]
if (registration.id !== 'dsh-turn-cost') throw new Error(`unexpected module id ${registration.id}`)
const client = registration.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require ${name}`)
})
const T = client.__test

// --- tiny assertion harness ------------------------------------------------
const results = []
let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`)
}
function near(name, actual, expected, epsilon = 1e-9) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= epsilon
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${expected}\n        actual   ${actual}`}`)
}

// --- fixtures --------------------------------------------------------------
const config = T.normalizeConfig({ usdToCny: 7.2 })
const BOOK = {
  ok: true,
  entries: {
    'openrouter|openai/gpt-6.1-sol': { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10, currency: 'USD' },
    'openrouter|deepseek/deepseek-v4.1-flash': { input: 0.0498, cacheRead: 0.000996, cacheWrite: 0.0498, output: 0.1992, currency: 'USD' },
    'openrouter|deepseek/deepseek-v4.1-flash-1017': { input: 0.15, cacheRead: 0.003, cacheWrite: 0.15, output: 0.6, currency: 'USD' },
    'openrouter|minimax/minimax-m3.1-flash': { input: 0.135, cacheRead: 0.0135, cacheWrite: 0.135, output: 0.54, currency: 'USD' },
    'openrouter|tiered/model': {
      input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10, currency: 'USD',
      tiers: [{ size: 272000, input: 4, cacheRead: 0.2, cacheWrite: 5, output: 15 }],
    },
  },
  byModel: {},
  aliases: { '@preset/ds41f-cheap': 'openrouter|deepseek/deepseek-v4.1-flash' },
  providerMap: { 'deepseek-official': 'deepseek' },
  deepseek: DEEPSEEK,
  warnings: [],
}
for (const [key, entry] of Object.entries(BOOK.entries)) BOOK.byModel[key.slice(key.indexOf('|') + 1)] = entry

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output,
})
const assistant = (turn, model, provider, u, time) => ({
  kind: 'assistant', turn, time,
  usage: { inputTokens: u.input, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite, outputTokens: u.output, totalTokens: u.total },
  providerMetadata: { provider, model },
})

// 2026-11-23 is a Monday.
const MON_10_00 = Date.parse('2026-11-23T10:00:00+08:00') // peak
const MON_13_00 = Date.parse('2026-11-23T13:00:00+08:00') // lunch, off-peak
const MON_19_00 = Date.parse('2026-11-23T19:00:00+08:00') // evening, off-peak
const SAT_10_00 = Date.parse('2026-11-28T10:00:00+08:00') // Saturday, off-peak
const HOLIDAY_10_00 = Date.parse('2026-10-01T10:00:00+08:00') // National Day, off-peak

// --- 1. peak / off-peak / holiday -----------------------------------------
check('10:00 Monday is peak', T.isPeak(MON_10_00, DEEPSEEK), true)
check('13:00 Monday is off-peak (lunch window)', T.isPeak(MON_13_00, DEEPSEEK), false)
check('19:00 Monday is off-peak', T.isPeak(MON_19_00, DEEPSEEK), false)
check('Saturday 10:00 is off-peak', T.isPeak(SAT_10_00, DEEPSEEK), false)
check('National Day 10:00 is off-peak', T.isPeak(HOLIDAY_10_00, DEEPSEEK), false)

// --- 2. DeepSeek pricing ---------------------------------------------------
const deepPeak = T.resolvePrice(config, BOOK, { provider: 'deepseek-official', model: 'deepseek-flash', time: MON_10_00 })
const deepOff = T.resolvePrice(config, BOOK, { provider: 'deepseek-official', model: 'deepseek-flash', time: MON_19_00 })
check('DeepSeek peak band', deepPeak.band, 'peak')
check('DeepSeek off-peak band', deepOff.band, 'offpeak')
near('DeepSeek peak cost (100k in + 20k out)', T.costOf(deepPeak, usage(100000, 20000), config), 0.36)
near('DeepSeek off-peak cost (100k in + 20k out)', T.costOf(deepOff, usage(100000, 20000), config), 0.18)
near('DeepSeek cache read is cheap', T.costOf(deepOff, usage(0, 0, 1000000), config), 0.02)

// retired alias still prices as Flash
const retired = T.resolvePrice(config, BOOK, { provider: 'deepseek-official', model: 'deepseek-v4-flash', time: MON_19_00 })
near('retired deepseek-v4-flash alias prices as flash', T.costOf(retired, usage(100000, 20000), config), 0.18)

// --- 3. book entries, aliases, suffixes, free -----------------------------
const gpt = T.resolvePrice(config, BOOK, { provider: 'openrouter', model: 'openai/gpt-6.1-sol', time: MON_19_00 })
near('GPT-6.1-sol: $2/$10 -> 2.88 CNY', T.costOf(gpt, usage(100000, 20000), config), 2.88)

const preset = T.resolvePrice(config, BOOK, { provider: 'openrouter', model: '@preset/ds41f-cheap', time: MON_19_00 })
near('preset alias resolves to v4.1-flash book entry', T.costOf(preset, usage(1000000, 0), config), 0.0498 * 7.2)

const exacto = T.resolvePrice(config, BOOK, { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash:exacto', time: MON_19_00 })
near(':exacto suffix strips to the base model', T.costOf(exacto, usage(1000000, 0), config), 0.0498 * 7.2)

const free = T.resolvePrice(config, BOOK, { provider: 'openrouter', model: 'minimax/minimax-m3.1-flash:free', time: MON_19_00 })
check(':free resolves as free', free.free, true)
near(':free costs nothing', T.costOf(free, usage(1000000, 500000), config), 0)

// The four routed ids this profile actually sends.
const floor = T.resolvePrice(config, BOOK, { provider: 'openrouter', model: 'openai/gpt-6.1-sol:floor', time: MON_19_00 })
near(':floor strips to the base model', T.costOf(floor, usage(100000, 20000), config), 2.88)

const flex = T.resolvePrice(config, BOOK, { provider: 'openrouter', model: 'openai/gpt-6.1-sol@preset/gpt61-sol-flex', time: MON_19_00 })
near('@preset/<name> strips to the base model', T.costOf(flex, usage(100000, 20000), config), 2.88)

const both = T.resolvePrice(config, BOOK, { provider: 'openrouter', model: 'openai/gpt-6.1-sol@preset/x:floor', time: MON_19_00 })
near('@preset and :suffix together both strip', T.costOf(both, usage(100000, 20000), config), 2.88)

const dated = T.resolvePrice(config, BOOK, { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017:exacto', time: MON_19_00 })
check('dated snapshot keeps its own price', dated.input, 0.15)
near('dated snapshot costs 0.1944', T.costOf(dated, usage(100000, 20000), config), 0.1944)

// A bare preset id must not strip to "", or the alias table never gets a say.
check('bare preset keeps its id', T.stripSuffix('@preset/ds41f-cheap'), '@preset/ds41f-cheap')

// --- 4. user overrides -----------------------------------------------------
const overrideConfig = T.normalizeConfig({ overrides: [{ match: 'gpt-6.1-sol', input: 1.25, output: 10, currency: 'USD' }] })
const overridden = T.resolvePrice(overrideConfig, BOOK, { provider: 'openrouter', model: 'openai/gpt-6.1-sol', time: MON_19_00 })
check('override matches a model substring', overridden.source, 'override')
near('override wins over the book', T.costOf(overridden, usage(1000000, 0), overrideConfig), 1.25 * 7.2)

// --- 5. tiers --------------------------------------------------------------
const tieredSmall = T.costOf(T.resolvePrice(config, BOOK, { provider: 'openrouter', model: 'tiered/model', time: MON_19_00 }), usage(100000, 0), config)
const tieredLarge = T.costOf(T.resolvePrice(config, BOOK, { provider: 'openrouter', model: 'tiered/model', time: MON_19_00 }), usage(300000, 0), config)
near('below the tier boundary: base rate', tieredSmall, 0.1 * 2 * 7.2)
near('above the tier boundary: tier rate', tieredLarge, 0.3 * 4 * 7.2)

// --- 6. unpriced -----------------------------------------------------------
check('unknown model resolves to null', T.resolvePrice(config, BOOK, { provider: 'openrouter', model: 'nobody/nothing', time: MON_19_00 }), null)

// --- 7. per-turn pricing ---------------------------------------------------
// Two requests: one at peak, one off-peak, same model. Pricing each request
// with its own timestamp is the whole point of the plugin.
const crossPeak = [
  assistant(7, 'deepseek-flash', 'deepseek-official', usage(100000, 20000), MON_10_00),
  assistant(7, 'deepseek-flash', 'deepseek-official', usage(100000, 20000), MON_19_00),
]
const crossView = T.priceTurn(crossPeak, undefined, 7, config, BOOK)
near('turn crossing the peak boundary sums both bands', crossView.cny, 0.36 + 0.18)
check('both requests counted', crossView.count, 2)
check('no unpriced requests', crossView.unpricedCount, 0)

// A turn with a free model and a paid model.
const mixed = [
  assistant(8, 'minimax/minimax-m3.1-flash:free', 'openrouter', usage(500000, 100000), MON_19_00),
  assistant(8, 'openai/gpt-6.1-sol', 'openrouter', usage(100000, 20000), MON_19_00),
]
const mixedView = T.priceTurn(mixed, undefined, 8, config, BOOK)
near('mixed turn: only the paid request costs money', mixedView.cny, 2.88)
check('mixed turn counts two requests', mixedView.count, 2)

// Unpriced requests are reported, not silently priced at 0.
const partlyUnknown = [
  assistant(9, 'nobody/nothing', 'openrouter', usage(100000, 20000), MON_19_00),
  assistant(9, 'deepseek-flash', 'deepseek-official', usage(100000, 20000), MON_19_00),
]
const partlyView = T.priceTurn(partlyUnknown, undefined, 9, config, BOOK)
near('priced part still sums', partlyView.cny, 0.18)
check('unpriced part is reported', partlyView.unpricedCount, 1)

// --- 8. turn-tail fallback -------------------------------------------------
const store = {
  values: () => [{
    kind: 'turn-tail',
    data: {
      turn: 10,
      time: MON_19_00,
      tokenUsage: {
        uncachedInputTokens: 100000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20000,
        totalTokens: 120000, routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
      },
    },
  }],
}
const fallbackView = T.priceTurn([], store, 10, config, BOOK)
check('fallback marks the reading as estimated', fallbackView.estimated, true)
near('fallback prices the aggregate once', fallbackView.cny, 0.18)

// --- 9. display ------------------------------------------------------------
check('CNY label', T.formatCost(0.18, T.normalizeConfig({})), '¥0.180')
check('sub-cent keeps four decimals', T.formatCost(0.0004, T.normalizeConfig({})), '¥0.0004')
check('free shows zero', T.formatCost(0, T.normalizeConfig({})), '¥0')
check('USD label converts', T.formatCost(2.88, T.normalizeConfig({ currency: 'USD' })), '$0.400')

// --- 10. host book builders ------------------------------------------------
const modelsDev = buildFromModelsDev({
  openrouter: { models: { 'openai/gpt-6.1-sol': { cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 } } } },
  deepseek: { models: { 'deepseek-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
  unknown: { models: { 'x/y': { cost: { input: 1, output: 2 } } } },
}, ['openrouter', 'deepseek'])
check('models.dev: two providers copied', Object.keys(modelsDev.entries).length, 2)
check('models.dev: unknown provider dropped', modelsDev.entries['unknown|x/y'], undefined)
check('models.dev: cache_read mapped', modelsDev.entries['openrouter|openai/gpt-6.1-sol'].cacheRead, 0.1)

const tiered = buildFromModelsDev({
  openrouter: { models: { 'x/y': { cost: { input: 2, output: 10, tiers: [{ input: 4, output: 15, tier: { size: 272000 } }] } } } },
}, ['openrouter'])
check('models.dev: tiers read from cost', tiered.entries['openrouter|x/y'].tiers[0].size, 272000)

const openrouter = buildFromOpenRouter({
  data: [{ id: 'openai/gpt-6.1-sol', pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000001' } }],
})
near('openrouter: per-token -> per-million input', openrouter.entries['openrouter|openai/gpt-6.1-sol'].input, 2)
near('openrouter: per-token -> per-million cache read', openrouter.entries['openrouter|openai/gpt-6.1-sol'].cacheRead, 0.1)

const overrides = buildOverrides([{ match: 'openrouter|x/y', input: 1, output: 2, currency: 'CNY' }])
check('overrides: exact key lands in the book', overrides['openrouter|x/y'].currency, 'CNY')
check('overrides: substring entry stays out of the book', Object.keys(buildOverrides([{ match: 'y', input: 1, output: 2 }])).length, 0)

const moduleResult = normalizeModuleResult({ entries: { 'openrouter|a/b': { input: 1, cacheRead: 0.5, output: 2 } }, aliases: { p: 'openrouter|a/b' } })
check('module: defaults to USD', moduleResult.entries['openrouter|a/b'].currency, 'USD')
check('module: alias accepted', moduleResult.aliases.p, 'openrouter|a/b')
check('merge: later group wins', mergeEntries({ a: 1, b: 1 }, { b: 2 }).b, 2)

// --- 11. endpoint range ----------------------------------------------------
const LADDER = [
  { name: 'OpenAI', input: 1, cacheRead: 0.05, cacheWrite: 1.25, output: 5 },
  { name: 'Bedrock', input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
  { name: 'Expensive', input: 12, cacheRead: 0.6, cacheWrite: 15, output: 60 },
]
const gptPrice = T.resolvePrice(config, BOOK, { provider: 'openrouter', model: 'openai/gpt-6.1-sol', time: MON_19_00 })
const range = T.costRange(gptPrice, usage(100000, 20000), config, LADDER)
near('endpoint range: floor is $1/$5', range.min, 1.44)
near('endpoint range: dearest is $12/$60', range.max, 12 * 0.1 * 7.2 + 60 * 0.02 * 7.2)
check('endpoint range counts all three', range.count, 3)
check('endpoint range names the cheapest', range.cheapest.name, 'OpenAI')

check('single endpoint degenerates to a point', (() => {
  const one = T.costRange(gptPrice, usage(100000, 20000), config, [LADDER[1]])
  return one.min === one.max
})(), true)

// The tier ladder is a ratio applied to each endpoint, not an absolute price.
const tieredPrice = T.resolvePrice(config, BOOK, { provider: 'openrouter', model: 'tiered/model', time: MON_19_00 })
const bigRange = T.costRange(tieredPrice, usage(300000, 0), config, [LADDER[0], LADDER[1]])
near('tier ratio doubles the floor endpoint', bigRange.min, 0.3 * 2 * 7.2)

// priceTurn threads the ladder through; without one it is unchanged.
const rangedTurn = T.priceTurn(
  [assistant(11, 'openai/gpt-6.1-sol', 'openrouter', usage(100000, 20000), MON_19_00)],
  undefined, 11, config, BOOK, () => LADDER,
)
near('turn range minimum', rangedTurn.cnyMin, 1.44)
near('turn range maximum', rangedTurn.cnyMax, 12 * 0.1 * 7.2 + 60 * 0.02 * 7.2)
near('turn point estimate still the list price', rangedTurn.cny, 2.88)

const noLadder = T.priceTurn(
  [assistant(12, 'openai/gpt-6.1-sol', 'openrouter', usage(100000, 20000), MON_19_00)],
  undefined, 12, config, BOOK, () => null,
)
check('no ladder means no range', noLadder.cnyMin === noLadder.cnyMax, true)

check('range formatting', T.formatRange(1.44, 12.24, config), '¥1.44-12.24')

// :floor / *-flex only ever land in the cheap band: $1/$5 or the $2/$10 fallback,
// never the $12/$60 premium endpoint.
const floorRange = T.costRange(gptPrice, usage(100000, 20000), config, LADDER, { floorLike: true })
near('floor band starts at the cheapest endpoint', floorRange.min, 1.44)
near('floor band ends at the first fallback tier', floorRange.max, 2.88)
check('floor band drops the premium endpoints', floorRange.count, 2)

const fullRange = T.costRange(gptPrice, usage(100000, 20000), config, LADDER)
check('unqualified routing keeps the whole ladder', fullRange.count, 3)

const floorTurn = T.priceTurn(
  [assistant(13, 'openai/gpt-6.1-sol:floor', 'openrouter', usage(100000, 20000), MON_19_00)],
  undefined, 13, config, BOOK, () => LADDER,
)
near('floor turn lower bound', floorTurn.cnyMin, 1.44)
near('floor turn upper bound', floorTurn.cnyMax, 2.88)

// --- 12. target resolution ------------------------------------------------
check('target strips preset', T.targetOf(config, BOOK, { provider: 'openrouter', model: 'openai/gpt-6.1-sol@preset/gpt61-sol-flex' }).model, 'openai/gpt-6.1-sol')
check('target resolves alias', T.targetOf(config, BOOK, { provider: 'openrouter', model: '@preset/ds41f-cheap' }).model, 'deepseek/deepseek-v4.1-flash')

// --- 13. pricer extension seam --------------------------------------------
// A user pricer takes precedence over the developer-provided OpenRouter one.
const disposeCustom = T.registerPricer({
  id: 'my-relay',
  match: (target) => /openrouter/i.test(target.provider),
  quote: () => ({ min: 0.01, max: 0.02, count: 9, note: '自定义' }),
})
const customView = T.priceTurn(
  [assistant(20, 'openai/gpt-6.1-sol', 'openrouter', usage(100000, 20000), MON_19_00)],
  undefined, 20, config, BOOK, () => LADDER,
)
near('custom pricer wins: min', customView.cnyMin, 0.01)
near('custom pricer wins: max', customView.cnyMax, 0.02)
disposeCustom()

const restored = T.priceTurn(
  [assistant(21, 'openai/gpt-6.1-sol', 'openrouter', usage(100000, 20000), MON_19_00)],
  undefined, 21, config, BOOK, () => LADDER,
)
near('after dispose the built-in pricer is back', restored.cnyMin, 1.44)

// The switch turns the built-in pricer off without touching the code.
const offConfig = T.normalizeConfig({ pricers: { openrouter: false } })
const offView = T.priceTurn(
  [assistant(22, 'openai/gpt-6.1-sol:floor', 'openrouter', usage(100000, 20000), MON_19_00)],
  undefined, 22, offConfig, BOOK, () => LADDER,
)
check('pricers.openrouter=false collapses the range', offView.cnyMin === offView.cnyMax, true)

// A pricer that matches nothing leaves the plain model price in charge.
const narrow = T.registerPricer({ id: 'narrow', match: () => false, quote: () => ({ min: 0, max: 0, count: 0 }) })
const narrowView = T.priceTurn(
  [assistant(23, 'openai/gpt-6.1-sol', 'openrouter', usage(100000, 20000), MON_19_00)],
  undefined, 23, config, BOOK, () => LADDER,
)
near('non-matching pricer is ignored', narrowView.cnyMin, 1.44)
narrow()


// --- 14. exact cost via generation lookup ---------------------------------
// A turn whose every request has a generation record is the bill, not a range.
const genTurn = T.priceTurn(
  [
    assistant(30, 'openai/gpt-6.1-sol:floor', 'openrouter', usage(100000, 20000), MON_19_00),
    assistant(30, 'openai/gpt-6.1-sol:floor', 'openrouter', usage(50000, 5000), MON_19_00),
  ],
  undefined, 30, config, BOOK, () => LADDER,
  () => ({ ok: true, provider: 'OpenAI', model: 'openai/gpt-6.1-sol', costUsd: 0.0021 }),
)
check('exact turn is marked exact', genTurn.exact, true)
near('exact turn sums the real charges', genTurn.cny, 0.0021 * 2 * 7.2)
check('exact turn collapses the range', genTurn.cnyMin === genTurn.cnyMax, true)

// One unresolved request keeps the estimated range (and never pretends).
const partialTurn = T.priceTurn(
  [
    assistant(31, 'openai/gpt-6.1-sol:floor', 'openrouter', usage(100000, 20000), MON_19_00),
    assistant(31, 'openai/gpt-6.1-sol:floor', 'openrouter', usage(50000, 5000), MON_19_00),
  ],
  undefined, 31, config, BOOK, () => LADDER,
  (id) => (id === 'gen-a' ? { ok: true, provider: 'OpenAI', costUsd: 0.0021 } : null),
)
check('partial generation stays estimated', partialTurn.exact, false)
near('partial generation keeps the range', partialTurn.cnyMin, 1.44 + 0.54)

// The switch turns lookups off entirely.
const noLookup = T.normalizeConfig({ generationLookup: false })
check('generationLookup=false is honoured', noLookup.generationLookup, false)

check('generation store is exposed for tests', typeof T.generationStore.ensure, 'function')

// --- 15. 预估 marker ------------------------------------------------------
// Only the actual bill, the official DeepSeek card, a pinned override or a
// free route count as certain; anything else is an estimate.
check('book price on OpenRouter is an estimate', rangedTurn.estimatedPrice, true)
check('DeepSeek official rate card is certain', T.priceTurn(
  [assistant(40, 'deepseek-flash', 'deepseek-official', usage(100000, 20000), MON_19_00)],
  undefined, 40, config, BOOK, () => null,
).estimatedPrice, false)
check('a pinned override is certain', T.priceTurn(
  [assistant(41, 'openai/gpt-6.1-sol', 'openrouter', usage(100000, 20000), MON_19_00)],
  undefined, 41, T.normalizeConfig({ overrides: [{ match: 'openai/gpt-6.1-sol', input: 1, output: 5 }] }), BOOK, () => LADDER,
).estimatedPrice, false)
check('a free route is certain', T.priceTurn(
  [assistant(42, 'minimax/minimax-m3.1-flash:free', 'openrouter', usage(1000, 1000), MON_19_00)],
  undefined, 42, config, BOOK, () => LADDER,
).estimatedPrice, false)
check('the actual bill is not an estimate', genTurn.estimatedPrice, false)


// --- 16. session total (composer dock) ------------------------------------
const SESSION = [
  assistant(50, 'deepseek-flash', 'deepseek-official', usage(100000, 20000), MON_19_00),
  assistant(50, 'deepseek-flash', 'deepseek-official', usage(50000, 10000), MON_19_00),
  assistant(51, 'openai/gpt-6.1-sol', 'openrouter', usage(100000, 20000), MON_19_00),
]
const session = T.sessionTotals(SESSION, config, BOOK, undefined, () => null)
near('session total sums every request', session.cny, 0.18 + 0.09 + 2.88)
check('session counts three requests', session.requests, 3)
check('a mixed session is an estimate', session.estimated, true)
check('session reports both models', session.models.length, 2)

const allDeep = T.sessionTotals(SESSION.slice(0, 2), config, BOOK, undefined, () => null)
check('DeepSeek-only session is certain', allDeep.estimated, false)

// Paged window: the projection says there are more tokens than were loaded.
const scaled = T.sessionTotals(SESSION.slice(0, 2), config, BOOK, { uncachedInputTokens: 300000, outputTokens: 60000 }, () => null)
near('projection scales the loaded total', scaled.cny / allDeep.cny, 2, 1e-9)
check('scale is reported', scaled.scale, 2)

const exactSession = T.sessionTotals(SESSION.slice(0, 1), config, BOOK, undefined, () => ({ ok: true, provider: 'DeepSeek', costUsd: 0.01 }))
near('generation records make the session exact', exactSession.cny, 0.01 * 7.2)
check('exact session is not an estimate', exactSession.estimated, false)


// --- 17. slot registration ------------------------------------------------
const slots = []
const fakeCtx = {
  slots: {
    inject(name, run) { run(); return () => {} },
    register(options, component) { slots.push({ name: options.name, id: options.id, order: options.order, component }); return () => {} },
  },
  provide() { return () => {} },
}
client.apply(fakeCtx)
check('registers the per-turn footer', slots.some((s) => s.name === 'conversation.chat.turnTail' && s.id === 'turn-cost'), true)
check('registers the composer total', slots.some((s) => s.name === 'conversation.composer.dock' && s.id === 'cost'), true)
check('dock total sits at order 2', (slots.find((s) => s.name === 'conversation.composer.dock') || {}).order, 2)


// A dock scope that exposes only the node store still gets a total.
const tails = { values: () => [{
  kind: 'turn-tail',
  data: { turn: 1, time: MON_19_00, tokenUsage: { uncachedInputTokens: 100000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20000, totalTokens: 120000, routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] } },
}] }
const storeOnly = T.sessionTotals([], config, BOOK, undefined, () => null, tails)
near('store-only dock fallback prices the aggregate', storeOnly.cny, 0.18)
check('store-only fallback is flagged', storeOnly.aggregate, true)
check('store-only fallback counts one request', storeOnly.requests, 1)


// A dock snapshot whose assistant nodes lost their route borrows the route the
// turn footers saw; without it the very same nodes would all be unpriced.
const stripped = [
  { kind: 'assistant', turn: 60, time: MON_19_00, usage: { inputTokens: 100000, totalTokens: 120000, outputTokens: 20000 }, providerMetadata: {} },
]
T.resetRoutes()
const orphan = T.sessionTotals(stripped, config, BOOK, undefined, () => null)
check('without any route the nodes stay unpriced', orphan.unpriced, 1)
T.priceTurn(
  [assistant(61, 'deepseek-flash', 'deepseek-official', usage(100000, 20000), MON_19_00)],
  undefined, 61, config, BOOK, () => null,
)
const recovered = T.sessionTotals(stripped, config, BOOK, undefined, () => null)
check('a route seen by a footer is reused', recovered.unpriced, 0)
near('and it prices the aggregate', recovered.cny, 0.18)

// --- report ----------------------------------------------------------------
const report = [
  'dsh-turn-cost offline tests',
  `run at ${new Date().toISOString()}`,
  '',
  ...results,
  '',
  failed === 0 ? `ALL ${results.length} CHECKS PASSED` : `${failed} of ${results.length} CHECKS FAILED`,
].join('\n')
writeFileSync(join(here, 'test-output.txt'), report + '\n', 'utf8')
console.log(report)
process.exitCode = failed === 0 ? 0 : 1
