/**
 * Example price module for dsh-turn-cost.
 *
 * A module is a plain `.mjs` file that exports one function. The host imports
 * it on every refresh (with a cache-busting query), calls it with a small
 * context, and merges whatever it returns into the price book.
 *
 *   export default async function refresh({ fetchJson, config, log }) {
 *     return { entries: { 'provider|model': {...} }, aliases: { '@preset/x': 'provider|model' } }
 *   }
 *
 * Entry fields: input / cacheRead / cacheWrite / output are per 1M tokens;
 * `currency` is `USD` (default) or `CNY`; `tiers` is optional and uses the
 * models.dev shape (`[{ size, input, cacheRead, cacheWrite, output }]`).
 *
 * Install:
 *   1. copy this file anywhere, e.g. `%USERPROFILE%\.dsh\turn-cost\my-prices.mjs`
 *   2. reference it from the profile's `cordis.patch.yml`:
 *
 *        - id: turn-cost
 *          config:
 *            priceModules:
 *              - 'C:/Users/you/.dsh/turn-cost/my-prices.mjs'
 *
 *   3. wait for the refresh interval, or restart the host.
 *
 * Note: if you only need OpenRouter's own catalog, you do NOT need a module —
 * set `sources.openrouter: true` in the config. Use a module when the list is
 * not one of the built-in sources: an internal gateway, a spreadsheet export,
 * a relay that publishes different prices than the upstream list, etc.
 */

export default async function refresh({ fetchJson, config, log }) {
  const entries = {};

  // --- Example A: pull a JSON list and map it to entries -------------------
  // The shape below matches OpenRouter's /api/v1/models (prices are per token).
  // Swap the URL for your own relay; the mapping stays the same.
  const data = await fetchJson('https://openrouter.ai/api/v1/models', { timeoutMs: 30000 });
  const models = Array.isArray(data && data.data) ? data.data : [];
  const perMillion = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1e6 : 0;
  };

  for (const model of models) {
    const id = typeof model.id === 'string' ? model.id : '';
    if (id === '') continue;
    const pricing = model.pricing || {};
    const entry = {
      input: perMillion(pricing.prompt),
      cacheRead: perMillion(pricing.input_cache_read !== undefined ? pricing.input_cache_read : pricing.prompt),
      cacheWrite: perMillion(pricing.input_cache_write !== undefined ? pricing.input_cache_write : pricing.prompt),
      output: perMillion(pricing.completion),
      currency: 'USD',
    };
    if (entry.input === 0 && entry.output === 0 && entry.cacheRead === 0) continue;
    entries['openrouter|' + id] = entry;
  }

  // --- Example B: hand-written entries for a private relay -----------------
  // A module wins over every fetched catalog, so this is also the place for
  // "we negotiated a lower price" or "this model has no public listing".
  entries['openrouter|my-relay/internal-model'] = {
    input: 0.35,
    cacheRead: 0.035,
    output: 1.4,
    currency: 'USD',
  };

  // --- Example C: aliases --------------------------------------------------
  // DSH routes a preset id (`@preset/...`) as if it were a model. Map it to the
  // real OpenRouter id here, or in the `aliases` config field if it is static.
  const aliases = {
    '@preset/ds41f-cheap': 'openrouter|deepseek/deepseek-v4.1-flash',
  };

  log('my-prices: ' + Object.keys(entries).length + ' entries');
  return { entries, aliases };
}
