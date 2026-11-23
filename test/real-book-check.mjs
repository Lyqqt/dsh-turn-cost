/**
 * End-to-end check against the real, freshly built price book
 * (test/real-book.json from host-harness.mjs).
 *
 * Prices one synthetic request per model actually seen in this machine's
 * session logs, so the numbers can be compared with what the models cost for
 * real. Also asserts the relationships that matter:
 *   - a `:free` model costs nothing;
 *   - the OpenRouter DeepSeek route is priced from the book, not the CNY table;
 *   - DeepSeek official is priced from CNY peak/off-peak;
 *   - an unknown model stays unpriced.
 *
 * Run: node test/real-book-check.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const book = JSON.parse(readFileSync(join(here, 'real-book.json'), 'utf8'))

const React = {
  createElement: () => null,
  memo: (fn) => fn,
  useMemo: (fn) => fn(),
  useEffect() {},
  useSyncExternalStore: (_s, get) => get(),
  Fragment: Symbol('Fragment'),
}
const registrations = []
new Function('window', readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8'))({
  __ModuleLoader__: { load: (reg) => registrations.push(reg) },
})
const T = registrations[0].factory((name) => {
  if (name === 'react') return React
  throw new Error(name)
}).__test

const config = T.configFrom(book)
console.log('config from book:', JSON.stringify({
  currency: config.currency, usdToCny: config.usdToCny, aliases: Object.keys(config.aliases),
}))

const usage = { input: 100000, cacheRead: 0, cacheWrite: 0, output: 20000, total: 120000 }
const MON_PEAK = Date.parse('2026-11-23T10:00:00+08:00')
const MON_OFF = Date.parse('2026-11-23T21:00:00+08:00')

const cases = [
  ['openrouter', 'openai/gpt-6.1-sol', MON_OFF],
  ['openrouter', 'deepseek/deepseek-v4.1-flash:exacto', MON_OFF],
  ['openrouter', '@preset/ds41f-cheap', MON_OFF],
  ['openrouter', 'deepseek/deepseek-v4-flash-0731', MON_OFF],
  ['openrouter', 'anthropic/claude-haiku-5.5', MON_OFF],
  ['openrouter', 'minimax/minimax-m3.1-flash:free', MON_OFF],
  ['deepseek-official', 'deepseek-flash', MON_PEAK],
  ['deepseek-official', 'deepseek-flash', MON_OFF],
  ['deepseek-official', 'deepseek-v4-pro', MON_OFF],
  ['openrouter', 'nobody/nothing', MON_OFF],
]

let failed = 0
const rows = []
for (const [provider, model, time] of cases) {
  const price = T.resolvePrice(config, book, { provider, model, time })
  const cost = price === null ? null : T.costOf(price, usage, config)
  rows.push({ provider, model, cost })
  const shown = cost === null ? '未定价' : '¥' + cost.toFixed(4)
  const band = price && price.band ? ' · ' + price.band : ''
  const src = price ? ' [' + price.source + ']' : ''
  console.log(`  ${provider.padEnd(18)} ${model.padEnd(42)} ${shown}${band}${src}`)
}

const byModel = (name) => rows.find((row) => row.model === name).cost
const assert = (name, ok) => {
  if (!ok) failed++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name)
}

assert('a :free model costs nothing', byModel('minimax/minimax-m3.1-flash:free') === 0)
assert('GPT-6.1-sol is priced from the book', byModel('openai/gpt-6.1-sol') > 1)
assert('DeepSeek official peak costs twice the off-peak', Math.abs(byModel('deepseek-flash') - 0.36) < 1e-9 && Math.abs(rows[7].cost - 0.18) < 1e-9)
assert('the preset alias resolves through the book', byModel('@preset/ds41f-cheap') > 0)
assert('an unknown model stays unpriced', byModel('nobody/nothing') === null)

// Throughput: the client re-prices a turn on every settled-node change.
const nodes = []
for (let turn = 1; turn <= 200; turn++) {
  for (let step = 0; step < 6; step++) {
    nodes.push({
      kind: 'assistant', turn,
      time: MON_OFF,
      usage: { inputTokens: 30000, cacheReadTokens: 200000, cacheWriteTokens: 0, outputTokens: 4000, totalTokens: 234000 },
      providerMetadata: { provider: 'openrouter', model: 'openai/gpt-6.1-sol' },
    })
  }
}
const t0 = process.hrtime.bigint()
const view = T.priceTurn(nodes, undefined, 200, config, book)
const ms = Number(process.hrtime.bigint() - t0) / 1e6
console.log(`\npriceTurn over ${nodes.length} nodes: ${ms.toFixed(2)} ms, turn 200 = ¥${view.cny.toFixed(4)} (${view.count} requests)`)
assert('pricing a full window stays under 50 ms', ms < 50)

console.log(failed === 0 ? '\nALL REAL-BOOK CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exitCode = failed === 0 ? 0 : 1

