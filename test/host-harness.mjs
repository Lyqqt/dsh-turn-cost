/**
 * Host integration check: build the real price book through the SOCKS proxy,
 * serve it through the registered route, and dump it for the client check.
 *
 * Run: node test/host-harness.mjs [proxy]
 * Writes test/real-book.json (gitignored, machine-specific).
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const proxy = process.argv[2] || ''

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-turn-cost-'))

const { apply } = await import('../lib/index.js')

const routes = new Map()
let service = null
const ctx = {
  inject(names, run) {
    const scope = { webServer: { register(handler) { routes.set(handler.path, handler); return () => {} } } }
    run(scope)
    return () => {}
  },
  effect() {},
  provide(_name, value) { service = value; return () => {} },
}

apply(ctx, {
  proxy,
  sources: { modelsDev: true, openrouter: true },
  aliases: { '@preset/ds41f-cheap': 'openrouter|deepseek/deepseek-v4.1-flash' },
})

if (service === null) throw new Error('turnCost service was not provided')
const route = routes.get('/dsh-turn-cost/prices.json')
if (!route) throw new Error('prices route was not registered')

console.log('refreshing through', proxy || 'direct fetch', '...')
const book = await service.refresh()
if (!book) throw new Error('book build returned null')

const entries = Object.keys(book.entries)
console.log('entries:', entries.length, '| byModel:', Object.keys(book.byModel).length)
console.log('sources:', JSON.stringify(book.sources))
console.log('warnings:', book.warnings.length === 0 ? '(none)' : book.warnings)
console.log('generatedAt:', new Date(book.generatedAt).toISOString())

const wanted = [
  'openrouter|openai/gpt-6.1-sol',
  'openrouter|deepseek/deepseek-v4.1-flash',
  'openrouter|minimax/minimax-m3.1-flash',
  'deepseek|deepseek-flash',
  'deepseek|deepseek-v4-pro',
]
for (const key of wanted) {
  console.log(book.entries[key] ? 'FOUND   ' + key + '  ' + JSON.stringify(book.entries[key]) : 'MISSING ' + key)
}

// Serve through the real route handler and measure the payload.
let body = ''
const res = {
  writeHead() {},
  end(text) { body = text },
}
route.handler({}, res)
console.log('route payload:', (Buffer.byteLength(body, 'utf8') / 1024).toFixed(1), 'KiB')
const served = JSON.parse(body)
if (served.ok !== true) throw new Error('route served a non-ok payload')

writeFileSync(join(here, 'real-book.json'), JSON.stringify(served), 'utf8')


// Endpoint ladder route: one model, deliberately the widest spread.
const ladderRoute = routes.get('/dsh-turn-cost/endpoints.json')
if (!ladderRoute) throw new Error('endpoints route was not registered')
for (const model of ['openai/gpt-6.1-sol', 'deepseek/deepseek-v4.1-flash-1017']) {
  let body = ''
  await new Promise((resolve) => {
    const res = { writeHead() {}, end(text) { body = text; resolve() } }
    ladderRoute.handler({ url: '/dsh-turn-cost/endpoints.json?model=' + encodeURIComponent(model) }, res)
  })
  const ladder = JSON.parse(body)
  const inputs = ladder.providers.map((p) => p.input).sort((a, b) => a - b)
  console.log('ladder', model, '->', ladder.providers.length, 'endpoints, input $' + inputs[0] + '-$' + inputs[inputs.length - 1])
}
