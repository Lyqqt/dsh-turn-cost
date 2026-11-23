window.__ModuleLoader__.load({
	id: "dsh-turn-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		// ---------------------------------------------------------------------
		// Built-in DeepSeek catalog. Mirrors DEEPSEEK in lib/index.js: this copy
		// is the offline fallback, so a fresh install still prices DeepSeek
		// turns while the host book is being fetched.
		//
		// CNY per million tokens. Peak = Beijing weekdays 09:00–12:00 and
		// 14:00–18:00; weekends and Chinese statutory holidays are off-peak.
		// ---------------------------------------------------------------------
		const DEEPSEEK = {
			currency: "CNY",
			peakHours: [[540, 720], [840, 1080]],
			models: {
				"deepseek-flash": {
					aliases: ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
					offpeak: { input: 1, cacheRead: 0.02, output: 4 },
					peak: { input: 2, cacheRead: 0.04, output: 8 },
				},
				"deepseek-v4-pro": {
					aliases: [],
					offpeak: { input: 4.5, cacheRead: 0.15, output: 13.5 },
					peak: { input: 9, cacheRead: 0.3, output: 27 },
				},
			},
			holidays: [
				"2026-01-01", "2026-01-02", "2026-01-03",
				"2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
				"2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
				"2026-04-04", "2026-04-05", "2026-04-06",
				"2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
				"2026-06-19", "2026-06-20", "2026-06-21",
				"2026-09-25", "2026-09-26", "2026-09-27",
				"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
				"2026-10-05", "2026-10-06", "2026-10-07",
			],
		};

		const DEFAULT_CONFIG = {
			enabled: true,
			currency: "CNY",
			usdToCny: 7.2,
			unknownDisplay: "dash",
			showRequests: true,
			generationLookup: true,
			generationLookback: 10,
			endpointRanges: true,
			priceNote: "",
			proxy: "",
			refreshHours: 24,
			providers: [],
			providerMap: { "deepseek-official": "deepseek" },
			aliases: {},
			overrides: [],
			priceModules: [],
			sources: { modelsDev: true, openrouter: false },
		};

		/** Routing suffixes OpenRouter appends; `:free` also means price 0. */
		const ROUTING_SUFFIX = /:(free|exacto|floor|nitro|thinking|online)$/i;

		const HIDDEN = Object.freeze({ state: "hidden" });
		/**
		 * Last route any component managed to read. Some slots expose nodes without
		 * provider metadata; when that happens the turn footers still know the
		 * model, so the session total can borrow it instead of showing "未定价".
		 */
		const ROUTE_KEY = "dsh-turn-cost:last-route";

		function readStoredRoute() {
			try {
				const raw = window.localStorage.getItem(ROUTE_KEY);
				if (typeof raw !== "string") return null;
				const parsed = JSON.parse(raw);
				return parsed && typeof parsed.model === "string" && parsed.model !== ""
					? { provider: str(parsed.provider), model: parsed.model }
					: null;
			} catch {
				return null;
			}
		}

		let lastKnownRoute = readStoredRoute();

		function rememberRoute(request) {
			if (request && typeof request.model === "string" && request.model !== "") {
				const next = { provider: str(request.provider), model: request.model };
				if (lastKnownRoute === null || lastKnownRoute.model !== next.model || lastKnownRoute.provider !== next.provider) {
					lastKnownRoute = next;
					try {
						window.localStorage.setItem(ROUTE_KEY, JSON.stringify(next));
					} catch {
						// Private mode or a full quota: the in-memory value still works.
					}
				}
			}
			return lastKnownRoute;
		}


		/** Stable empty array: a selector must not mint a new reference per read. */
		const NO_NODES = [];

		// ---------------------------------------------------------------------
		// Numeric helpers. Every read is defensive: a malformed usage object
		// must never leak NaN into the dock.
		// ---------------------------------------------------------------------
		function num(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
		}

		function str(value) {
			return typeof value === "string" ? value : "";
		}

		function asObject(value) {
			return value && typeof value === "object" && !Array.isArray(value) ? value : {};
		}

		function formatTokens(value) {
			const n = Math.max(0, Math.round(num(value)));
			if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
			return String(n);
		}

		/** Amount in CNY -> the display currency. */
		function toDisplay(cny, config) {
			return config.currency === "USD" ? cny / config.usdToCny : cny;
		}

		/** CNY-internal amount rendered in the configured currency. */
		function formatCost(cny, config) {
			const symbol = config.currency === "USD" ? "$" : "¥";
			const value = toDisplay(cny, config);
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return symbol + "—";
			if (value === 0) return symbol + "0";
			if (value < 0.01) return symbol + value.toFixed(4);
			if (value < 1) return symbol + value.toFixed(3);
			return symbol + value.toFixed(2);
		}

		function displayCost(cny, config) {
			return formatCost(cny, config);
		}

		function currencyLabel(config) {
			return config.currency === "USD" ? "USD" : "CNY";
		}

		function formatRange(minCny, maxCny, config) {
			const symbol = config.currency === "USD" ? "$" : "¥";
			const low = toDisplay(minCny, config);
			const high = toDisplay(maxCny, config);
			const digits = (value) => (value < 0.01 ? 4 : value < 1 ? 3 : 2);
			const places = Math.max(digits(low), digits(high));
			return symbol + low.toFixed(places) + "-" + high.toFixed(places);
		}

		function formatRate(rateCny, config) {
			return round2(toDisplay(rateCny, config)) + " " + currencyLabel(config) + "/M";
		}

		function round2(value) {
			return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
		}

		// ---------------------------------------------------------------------
		// Config mirror. Same bridge as dsh-cost-pill: the host declares a
		// volatile schema, the browser reads the resolved value through
		// `ctx.configForms.get('turn-cost')`.
		// ---------------------------------------------------------------------
		function normalizeConfig(value) {
			const raw = asObject(value);
			const sources = asObject(raw.sources);
			return {
				enabled: raw.enabled !== false,
				currency: raw.currency === "USD" ? "USD" : "CNY",
				usdToCny: typeof raw.usdToCny === "number" && raw.usdToCny > 0 ? raw.usdToCny : 7.2,
				unknownDisplay: raw.unknownDisplay === "hidden" ? "hidden" : "dash",
				showRequests: raw.showRequests !== false,
				generationLookup: raw.generationLookup !== false,
				generationLookback: typeof raw.generationLookback === "number" && raw.generationLookback >= 0 ? raw.generationLookback : 10,
				endpointRanges: raw.endpointRanges !== false,
				pricers: asObject(raw.pricers),
				priceNote: str(raw.priceNote),
				proxy: str(raw.proxy),
				providers: Array.isArray(raw.providers) ? raw.providers : DEFAULT_CONFIG.providers,
				providerMap: Object.keys(asObject(raw.providerMap)).length > 0 ? asObject(raw.providerMap) : DEFAULT_CONFIG.providerMap,
				aliases: asObject(raw.aliases),
				overrides: Array.isArray(raw.overrides) ? raw.overrides.filter((e) => e && typeof e === "object") : [],
				sources: {
					modelsDev: sources.modelsDev !== false,
					openrouter: sources.openrouter === true,
				},
			};
		}

		/**
		 * Resolved config comes from the host inside the price book: same
		 * document, same refresh, one source of truth. Before the first fetch
		 * (and if the route is unreachable) the defaults above apply.
		 */
		function configFrom(book) {
			const raw = asObject(book && book.config);
			return normalizeConfig({
				...raw,
				aliases: book && book.aliases ? book.aliases : raw.aliases,
			});
		}

		// ---------------------------------------------------------------------
		// Price book: fetched from the host half exactly once per page load
		// (the host caches the upstream catalogs on disk). The browser never
		// talks to models.dev itself — the machine that needs a SOCKS proxy is
		// the machine whose browser cannot reach it.
		// ---------------------------------------------------------------------
		const bookStore = (() => {
			let book = null;
			let at = 0;
			let failedAt = 0;
			let inflight = null;
			const listeners = new Set();
			const emit = () => {
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch {
						// A broken consumer must not stop the dock.
					}
				}
			};
			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				get() {
					return book;
				},
				load(force) {
					if (inflight !== null) return inflight;
					const now = Date.now();
					// An empty book means the host has not finished its first build
					// (or is failing): poll quickly instead of waiting five minutes.
					const empty = book !== null && Object.keys(asObject(book.entries)).length === 0;
					const ttl = empty ? 30 * 1000 : 5 * 60 * 1000;
					if (force !== true && book !== null && now - at < ttl) return Promise.resolve(book);
					if (force !== true && failedAt !== 0 && now - failedAt < 60 * 1000) return Promise.resolve(book);
					inflight = fetch("/dsh-turn-cost/prices.json", { cache: "no-store" })
						.then((response) => (response.ok ? response.json() : null))
						.then((json) => {
							if (json && json.ok !== false && json.entries && typeof json.entries === "object") {
								book = json;
								at = Date.now();
								failedAt = 0;
								emit();
							} else {
								failedAt = Date.now();
							}
							return book;
						})
						.catch(() => {
							failedAt = Date.now();
							return book;
						})
						.finally(() => {
							inflight = null;
						});
					return inflight;
				},
			};
		})();


		// ---------------------------------------------------------------------
		// Endpoint ladder cache. Fetched lazily for the models a turn actually
		// used: the host asks OpenRouter for that model's per-provider prices and
		// caches them, so a session pays one request per model, not per turn.
		// ---------------------------------------------------------------------
		const endpointsStore = (() => {
			const map = new Map();
			const inflight = new Map();
			const listeners = new Set();
			let revision = 0;
			const emit = () => {
				revision += 1;
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch {
						// A broken consumer must not stop the dock.
					}
				}
			};
			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				version() {
					return revision;
				},
				get(model) {
					const hit = map.get(model);
					return Array.isArray(hit) ? hit : null;
				},
				ensure(models) {
					for (const model of Array.isArray(models) ? models : []) {
						if (typeof model !== "string" || model === "") continue;
						if (map.has(model) || inflight.has(model)) continue;
						const task = fetch("/dsh-turn-cost/endpoints.json?model=" + encodeURIComponent(model), { cache: "no-store" })
							.then((response) => (response.ok ? response.json() : null))
							.then((json) => {
								map.set(model, json && json.ok === true && Array.isArray(json.providers) ? json.providers : []);
								emit();
							})
							.catch(() => {
								map.set(model, []);
								emit();
							})
							.finally(() => {
								inflight.delete(model);
							});
						inflight.set(model, task);
					}
				},
			};
		})();

		// ---------------------------------------------------------------------
		// Generation lookup: exact cost.
		//
		// Each OpenRouter response carries a generation id; the host asks
		// /api/v1/generation for it and returns the real upstream provider and the
		// real charge. Only recent turns are looked up (a long session would fire
		// hundreds of requests), and one "no-key" answer disables the rest.
		// ---------------------------------------------------------------------
		const generationStore = (() => {
			const map = new Map();
			const inflight = new Map();
			const listeners = new Set();
			let revision = 0;
			let keyMissing = false;
			const emit = () => {
				revision += 1;
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch {
						// A broken consumer must not stop the dock.
					}
				}
			};
			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				version() {
					return revision;
				},
				get(id) {
					return map.get(id) || null;
				},
				ensure(ids) {
					if (keyMissing) return;
					for (const id of Array.isArray(ids) ? ids : []) {
						if (typeof id !== "string" || id.indexOf("gen-") !== 0) continue;
						if (map.has(id) || inflight.has(id)) continue;
						const task = fetch("/dsh-turn-cost/generation.json?id=" + encodeURIComponent(id), { cache: "no-store" })
							.then((response) => (response.ok ? response.json() : null))
							.then((json) => {
								const value = json && typeof json === "object" ? json : { ok: false, reason: "network" };
								if (value.reason === "no-key") keyMissing = true;
								map.set(id, value);
								emit();
							})
							.catch(() => {
								map.set(id, { ok: false, reason: "network" });
								emit();
							})
							.finally(() => {
								inflight.delete(id);
							});
						inflight.set(id, task);
					}
				},
			};
		})();

		// ---------------------------------------------------------------------
		// Price resolution.
		//
		// Order (first hit wins):
		//   1. config.overrides      — hand-written, exact `provider|model` or a
		//                              substring of the model id;
		//   2. `:free` routing suffix — OpenRouter's free tier, price 0;
		//   3. aliases               — config, then the host book;
		//   4. book.entries          — `provider|model`, then the model with the
		//                              routing suffix stripped, then byModel;
		//   5. built-in DeepSeek CNY catalog (peak / off-peak aware);
		//   6. null                  — "未定价", never 0.
		// ---------------------------------------------------------------------
		/** `@preset/<name>` is a routing preset applied to a model, not a model. */
		const PRESET_SUFFIX = /@preset\/[^@:]*/gi;

		/**
		 * Reduce a routed id to the model id that carries a price:
		 *   openai/gpt-6.1-sol:floor                  -> openai/gpt-6.1-sol
		 *   openai/gpt-6.1-sol@preset/gpt61-sol-flex   -> openai/gpt-6.1-sol
		 *   deepseek/...-1017:exacto                   -> deepseek/...-1017
		 * A bare preset id (\`@preset/ds41f-cheap\`) strips to nothing, so the
		 * original is kept and the alias table decides.
		 * @param model - model id as the session log recorded it.
		 */
		function stripSuffix(model) {
			const next = model.replace(PRESET_SUFFIX, "").replace(ROUTING_SUFFIX, "");
			return next === "" ? model : next;
		}

		function matchOverride(config, provider, model) {
			const key = provider + "|" + model;
			for (const raw of config.overrides) {
				const match = str(raw.match);
				if (match === "") continue;
				const hit = match.indexOf("|") >= 0 ? match === key : model.indexOf(match) >= 0;
				if (!hit) continue;
				const currency = raw.currency === "CNY" ? "CNY" : "USD";
				return {
					input: num(raw.input),
					cacheRead: num(raw.cacheRead !== undefined ? raw.cacheRead : raw.input),
					cacheWrite: num(raw.cacheWrite !== undefined ? raw.cacheWrite : raw.input),
					output: num(raw.output),
					currency,
					tiers: Array.isArray(raw.tiers) ? raw.tiers : undefined,
					source: "override",
				};
			}
			return null;
		}

		function lookupAlias(config, book, provider, model) {
			const tables = [config.aliases, asObject(book && book.aliases)];
			const keys = [provider + "|" + model, model];
			for (const table of tables) {
				for (const key of keys) {
					const value = table[key];
					if (typeof value === "string" && value !== "") {
						const bar = value.indexOf("|");
						return bar >= 0
							? { provider: value.slice(0, bar), model: value.slice(bar + 1) }
							: { provider, model: value };
					}
					if (value && typeof value === "object") {
						const next = { provider: str(value.provider) || provider, model: str(value.model) };
						if (next.model !== "") return next;
					}
				}
			}
			return null;
		}

		function lookupEntry(book, provider, model) {
			if (!book) return null;
			const entries = asObject(book.entries);
			const byModel = asObject(book.byModel);
			const mapped = asObject(book.providerMap)[provider] || asObject(DEFAULT_CONFIG.providerMap)[provider] || provider;
			const routes = mapped === provider ? [provider] : [provider, mapped];
			const names = [model];
			const stripped = stripSuffix(model);
			if (stripped !== model) names.push(stripped);
			for (const route of routes) {
				for (const name of names) {
					const hit = entries[route + "|" + name];
					if (hit) return hit;
				}
			}
			for (const name of names) {
				const hit = byModel[name];
				if (hit) return hit;
			}
			return null;
		}

		/** Beijing calendar pieces for one instant. */
		function beijing(timeMs) {
			const t = typeof timeMs === "number" && Number.isFinite(timeMs) && timeMs > 0 ? timeMs : Date.now();
			const date = new Date(t + 8 * 3600 * 1000);
			return {
				day: date.getUTCDay(),
				minutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
				date: date.toISOString().slice(0, 10),
			};
		}

		/** Whether a DeepSeek request happened inside a peak window. */
		function isPeak(timeMs, catalog) {
			const clock = beijing(timeMs);
			if (clock.day === 0 || clock.day === 6) return false;
			const holidays = Array.isArray(catalog && catalog.holidays) ? catalog.holidays : [];
			if (holidays.indexOf(clock.date) >= 0) return false;
			const hours = Array.isArray(catalog && catalog.peakHours) ? catalog.peakHours : DEEPSEEK.peakHours;
			for (const window of hours) {
				if (Array.isArray(window) && clock.minutes >= window[0] && clock.minutes < window[1]) return true;
			}
			return false;
		}

		function resolveDeepseek(book, model, timeMs) {
			const catalog = asObject(book && book.deepseek && Object.keys(asObject(book.deepseek.models)).length > 0 ? book.deepseek : DEEPSEEK);
			const models = asObject(catalog.models);
			const wanted = stripSuffix(model);
			let key = wanted;
			if (!models[key]) {
				for (const name of Object.keys(models)) {
					const aliases = Array.isArray(models[name].aliases) ? models[name].aliases : [];
					if (aliases.indexOf(wanted) >= 0) {
						key = name;
						break;
					}
				}
			}
			const model0 = models[key];
			if (!model0) return null;
			const peak = isPeak(timeMs, catalog);
			const rate = asObject(peak ? model0.peak : model0.offpeak);
			return {
				input: num(rate.input),
				cacheRead: num(rate.cacheRead),
				cacheWrite: num(rate.input),
				output: num(rate.output),
				currency: "CNY",
				band: peak ? "peak" : "offpeak",
				source: "deepseek",
			};
		}

		function looksDeepseek(provider, model) {
			return /deepseek/i.test(provider) || /^deepseek/i.test(model) || /^deepseek\//i.test(model);
		}


		/** Route after alias resolution, reduced to the model that carries a price. */
		function targetOf(config, book, request) {
			const provider = str(request.provider);
			const model = str(request.model);
			const alias = lookupAlias(config, book, provider, model);
			const next = alias !== null ? alias : { provider, model };
			return { provider: next.provider, model: stripSuffix(next.model) };
		}

		/**
		 * Resolve the rate for one request.
		 *
		 * DeepSeek's own route is special-cased before the generic lookup: its
		 * CNY catalog carries the peak/off-peak bands, which models.dev cannot
		 * express (models.dev lists one flat USD rate). An OpenRouter DeepSeek
		 * route is billed by OpenRouter at list price, so it stays on the book.
		 * @param config - normalized config.
		 * @param book - host price book, or null.
		 * @param request - { provider, model, time }.
		 * @returns a rate object, `{ free: true }`, or null when unpriced.
		 */
		function resolvePrice(config, book, request) {
			const provider = str(request.provider);
			const model = str(request.model);
			if (model === "") return null;

			const override = matchOverride(config, provider, model);
			if (override !== null) return override;

			if (/:free$/i.test(model)) return { free: true, source: "free" };

			const target = targetOf(config, book, request);
			const official = /^deepseek/i.test(target.provider);

			if (official) {
				const price = resolveDeepseek(book, target.model, request.time);
				if (price !== null) return price;
			}

			const entry = lookupEntry(book, target.provider, target.model);
			if (entry) return Object.assign({}, entry, { source: "book" });

			if (!official && looksDeepseek(target.provider, target.model)) {
				const price = resolveDeepseek(book, target.model, request.time);
				if (price !== null) return price;
			}
			return null;
		}

		/** Rate selection honouring models.dev `tiers` (context-size scaling). */
		function effectiveRate(price, usage) {
			if (!Array.isArray(price.tiers) || price.tiers.length === 0) return price;
			const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
			let rate = price;
			for (const tier of price.tiers) {
				const size = num(tier && tier.size);
				if (size > 0 && prompt >= size) rate = tier;
			}
			return rate;
		}

		/** One request's cost in CNY. */
		function costOf(price, usage, config) {
			if (price.free === true) return 0;
			const rate = effectiveRate(price, usage);
			const cacheWrite = rate.cacheWrite !== undefined ? num(rate.cacheWrite) : num(rate.input);
			const amount =
				(num(usage.input) / 1e6) * num(rate.input) +
				(num(usage.cacheRead) / 1e6) * num(rate.cacheRead) +
				(num(usage.cacheWrite) / 1e6) * cacheWrite +
				(num(usage.output) / 1e6) * num(rate.output);
			if (!Number.isFinite(amount) || amount < 0) return 0;
			return price.currency === "USD" ? amount * config.usdToCny : amount;
		}

		// ---------------------------------------------------------------------
		// Endpoint range.
		//
		// OpenRouter prices the same model differently per upstream provider
		// (measured: 6 endpoints for openai/gpt-6.1-sol, 12x spread; 50 for
		// deepseek/deepseek-v4.1-flash-1017, 20x). The billed provider is not in
		// the session log, so a single number cannot be exact — but the ladder
		// itself is public, so the reading can be an honest range instead of a
		// fiction. A model with one endpoint (or DeepSeek official) stays exact.
		// ---------------------------------------------------------------------
		function tierRatios(price, usage) {
			if (!Array.isArray(price.tiers) || price.tiers.length === 0) return null;
			const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
			let tier = null;
			for (const candidate of price.tiers) {
				if (num(candidate && candidate.size) > 0 && prompt >= num(candidate.size)) tier = candidate;
			}
			if (tier === null) return null;
			const ratio = (next, base) => (num(base) > 0 ? num(next) / num(base) : 1);
			return {
				input: ratio(tier.input, price.input),
				cacheRead: ratio(tier.cacheRead, price.cacheRead),
				cacheWrite: ratio(tier.cacheWrite, price.cacheWrite),
				output: ratio(tier.output, price.output),
			};
		}

		/**
		 * Cheapest and dearest endpoint for one request.
		 * @param price - the book rate (supplies the tier ladder).
		 * @param usage - this request's token buckets.
		 * @param config - normalized config.
		 * @param providers - endpoint records from the host.
		 * @param options - { floorLike } narrows to the cheap band: :floor and
		 *   *-flex presets pick the cheapest available endpoint and only fall
		 *   back to the next tier, they never pick the 10x premium endpoint.
		 * @returns { min, max, count, cheapest, dearest } or null.
		 */
		function costRange(price, usage, config, providers, options) {
			const ratios = tierRatios(price, usage);
			let list = Array.isArray(providers) ? providers.filter((p) => num(p.input) > 0 || num(p.output) > 0) : [];
			// :exacto routes away from lossy quantizations (fp4 / mxfp4).
			if (options && options.exactOnly === true && list.length > 1) {
				const exact = list.filter((p) => !/^m?fp4$/i.test(str(p.quant)));
				if (exact.length > 0) list = exact;
			}
			if (options && options.floorLike === true && list.length > 1) {
				const cheapest = Math.min(...list.map((p) => num(p.input) || num(p.output)));
				list = list.filter((p) => (num(p.input) || num(p.output)) <= cheapest * 2);
			}
			let min = Infinity;
			let max = -Infinity;
			let cheapest = null;
			let dearest = null;
			let count = 0;
			for (const provider of list) {
				const scaled = ratios === null ? provider : {
					input: num(provider.input) * ratios.input,
					cacheRead: num(provider.cacheRead) * ratios.cacheRead,
					cacheWrite: num(provider.cacheWrite) * ratios.cacheWrite,
					output: num(provider.output) * ratios.output,
				};
				if (scaleSum(scaled) <= 0) continue;
				const cost = costOf(Object.assign({ currency: "USD" }, scaled), usage, config);
				count += 1;
				if (cost < min) {
					min = cost;
					cheapest = provider;
				}
				if (cost > max) {
					max = cost;
					dearest = provider;
				}
			}
			if (count === 0 || !Number.isFinite(min) || !Number.isFinite(max)) return null;
			return { min, max, count, cheapest, dearest };
		}

		function scaleSum(rate) {
			return num(rate.input) + num(rate.output) + num(rate.cacheRead) + num(rate.cacheWrite);
		}



		// ---------------------------------------------------------------------
		// Pricers: the policy layer for "the same model has several prices".
		//
		// The core only knows a single model price (models.dev / DeepSeek CNY /
		// overrides). Anything that depends on *which upstream served the call*
		// — routing suffixes, presets, per-provider endpoint ladders — is a
		// pricer, and a pricer is an extension: the developer ships the ones for
		// the common relays, a user can register their own.
		//
		// Interface:
		//   { id, match(target) -> boolean,
		//     quote({ request, target, price, usage, config, ladder }) ->
		//       { min, max, count, note? } | null }
		// Returning null means "no opinion", and the next pricer (or the plain
		// model price) applies.
		// ---------------------------------------------------------------------
		const pricers = [];

		function registerPricer(pricer) {
			if (!pricer || typeof pricer !== "object" || typeof pricer.quote !== "function") return () => {};
			// User pricers take precedence over the developer-provided defaults.
			pricers.unshift(pricer);
			return () => {
				const index = pricers.indexOf(pricer);
				if (index >= 0) pricers.splice(index, 1);
			};
		}

		function enabledPricer(pricer, config) {
			const switches = asObject(config.pricers);
			return switches[pricer.id] !== false;
		}

		/**
		 * First pricer that has an opinion wins.
		 * @returns { min, max, count, note, pricer } or null.
		 */
		function quoteWithPricers(context) {
			for (const pricer of [...pricers]) {
				if (!enabledPricer(pricer, context.config)) continue;
				if (typeof pricer.match === "function" && pricer.match(context.target) !== true) continue;
				let hit = null;
				try {
					hit = pricer.quote(context);
				} catch {
					hit = null;
				}
				if (hit && Number.isFinite(hit.min) && Number.isFinite(hit.max)) {
					return Object.assign({ pricer: pricer.id }, hit);
				}
			}
			return null;
		}

		/**
		 * Developer-provided pricer for OpenRouter.
		 *
		 * OpenRouter resells one model through many upstream providers at
		 * different prices (6 endpoints / 12x for gpt-6.1-sol, 50 / 20x for
		 * deepseek-v4.1-flash-1017). The routed provider is not in the session
		 * log, so this pricer narrows the eligible set by the routing hint and
		 * reports the remaining band:
		 *   :floor / @preset/*flex|cheap -> cheapest band (floor + first fallback)
		 *   :exacto                     -> drop lossy fp4 / mxfp4 endpoints
		 *   otherwise                   -> the whole ladder
		 */
		const OPENROUTER_PRICER_ID = "openrouter";

		function openrouterPricer() {
			return {
				id: OPENROUTER_PRICER_ID,
				match(target) {
					return /openrouter/i.test(str(target.provider));
				},
				quote({ request, price, usage, config, ladder }) {
					if (!Array.isArray(ladder) || ladder.length === 0) return null;
					const raw = str(request.model);
					const floorLike = /:(floor)$/i.test(raw) || /@preset\/[^@:]*(flex|cheap)/i.test(raw);
					const exactOnly = /:(exacto)$/i.test(raw);
					const range = costRange(price, usage, config, ladder, { floorLike, exactOnly });
					if (range === null) return null;
					const note = range.count > 1
						? "端点 " + range.count + " 个：" + displayCost(range.min, config) + "-" + displayCost(range.max, config)
						: "";
					return { min: range.min, max: range.max, count: range.count, note, cheapest: range.cheapest, dearest: range.dearest };
				},
			};
		}
		// Developer-provided defaults. Users may register more client-side, or
		// switch one off with `pricers: { openrouter: false }`.
		pricers.push(openrouterPricer());

		// ---------------------------------------------------------------------
		// Turn extraction. `legacy.nodes` is the settled-node array the Chat
		// snapshot exposes; one `assistant` node is exactly one billed request,
		// carrying its own usage, provider, model and timestamp.
		// ---------------------------------------------------------------------
		function requestsOf(nodes, turnNumber) {
			const requests = [];
			for (const node of Array.isArray(nodes) ? nodes : []) {
				if (!node || typeof node !== "object") continue;
				if (node.kind !== "assistant" || node.turn !== turnNumber) continue;
				const request = requestOfNode(node);
				if (request !== null) requests.push(request);
			}
			return requests;
		}

		/** One assistant node -> one billed request, or null when it carries no usage. */
		function requestOfNode(node) {
			// Collect provider/model independently: a present-but-empty
			// providerMetadata must not shadow message.source.
			const meta = asObject(node.providerMetadata);
			const fallback = asObject(node.requestConfig);
			const sourceMeta = asObject(node.message && node.message.source);
			const provider = str(meta.provider) || str(fallback.provider) || str(sourceMeta.provider) || str(node.provider);
			const model = str(meta.model) || str(fallback.model) || str(sourceMeta.model) || str(node.model);
			const usage = asObject(node.usage);
			const input = num(usage.inputTokens);
			const cacheRead = num(usage.cacheReadTokens);
			const cacheWrite = num(usage.cacheWriteTokens);
			const output = num(usage.outputTokens);
			const total = num(usage.totalTokens) || input + cacheRead + cacheWrite + output;
			if (total <= 0) return null;
			// OpenRouter's generation id; the host turns it into the real
			// provider name and the real cost. It rides on either the message
			// source or the node's provider metadata, depending on the node.
			const source = node.message && node.message.source ? node.message.source : null;
			const replay = Object.assign(
				{},
				asObject(asObject(source && source.replayState).response),
				asObject(asObject(node.providerMetadata && node.providerMetadata.replayState).response),
			);
			return {
				time: typeof node.time === "number" ? node.time : 0,
				turn: typeof node.turn === "number" ? node.turn : 0,
				provider,
				model,
				responseId: str(replay.responseId),
				usage: { input, cacheRead, cacheWrite, output, total },
			};
		}

		function tailOf(store, turnNumber) {
			if (!store || typeof store.values !== "function") return null;
			for (const node of store.values()) {
				if (node && node.kind === "turn-tail" && node.data && node.data.turn === turnNumber) return node.data;
			}
			return null;
		}


		/** Route from any node or turn-tail in the window; last resort when a node lost its model. */
		function routeFromStore(nodes, store, turnNumber) {
			const list = Array.isArray(nodes) ? nodes : [];
			for (let index = list.length - 1; index >= 0; index -= 1) {
				const node = list[index];
				if (!node || typeof node !== "object") continue;
				const meta = asObject(node.providerMetadata);
				const fallback = asObject(node.requestConfig);
				const sourceMeta = asObject(node.message && node.message.source);
				const model = str(meta.model) || str(fallback.model) || str(sourceMeta.model) || str(node.model);
				if (model !== "") {
					return { provider: str(meta.provider) || str(fallback.provider) || str(sourceMeta.provider) || str(node.provider), model };
				}
			}
			if (store && typeof store.values === "function") {
				const tails = [];
				for (const node of store.values()) {
					if (node && node.kind === "turn-tail" && node.data) tails.push(node.data);
				}
				tails.sort((left, right) => (left.turn || 0) - (right.turn || 0));
				for (let index = tails.length - 1; index >= 0; index -= 1) {
					const usage = asObject(tails[index].tokenUsage);
					const routes = Array.isArray(usage.routes) ? usage.routes : [];
					const route = routes.length > 0 ? asObject(routes[routes.length - 1]) : {};
					if (str(route.model) !== "") return { provider: str(route.provider), model: str(route.model) };
				}
			}
			return null;
		}

		/** One synthetic request from the durable per-turn usage (paged window). */
		function requestFromTail(tail) {
			const usage = asObject(tail && tail.tokenUsage);
			const routes = Array.isArray(usage.routes) ? usage.routes : [];
			const route = routes.length > 0 ? asObject(routes[routes.length - 1]) : {};
			const input = num(usage.uncachedInputTokens);
			const cacheRead = num(usage.cacheReadTokens);
			const cacheWrite = num(usage.cacheWriteTokens);
			const output = num(usage.outputTokens);
			const total = num(usage.totalTokens) || input + cacheRead + cacheWrite + output;
			if (total <= 0) return null;
			return {
				time: typeof tail.time === "number" ? tail.time : 0,
				provider: str(route.provider),
				model: str(route.model),
				usage: { input, cacheRead, cacheWrite, output, total },
			};
		}

		/**
		 * Price one turn. Requests are priced individually and then summed, so a
		 * turn that crosses a DeepSeek peak boundary is still correct — and a
		 * turn that mixed routes would be too.
		 * @param nodes - settled node array.
		 * @param store - Chat node store, for the turn-tail fallback.
		 * @param turnNumber - the turn to price.
		 * @param config - normalized config.
		 * @param book - host price book or null.
		 */
		function priceTurn(nodes, store, turnNumber, config, book, endpointOf, generationOf) {
			let requests = requestsOf(nodes, turnNumber);
			let estimated = false;
			if (requests.length === 0) {
				const fallback = requestFromTail(tailOf(store, turnNumber));
				if (fallback === null) return { state: "empty", count: 0, cny: 0, cnyMin: 0, cnyMax: 0, tokens: 0, lines: [], unpriced: [] };
				requests = [fallback];
				estimated = true;
			}

			// A node that lost its model must not make the whole turn unpriced:
			// borrow from a sibling request, then any node, then the last route
			// any component saw.
			for (const request of requests) rememberRoute(request);
			const known = requests.find((request) => request.model !== "") ||
				routeFromStore(nodes, store, turnNumber) ||
				lastKnownRoute;
			if (known) {
				for (const request of requests) {
					if (request.model === "") {
						request.model = known.model;
						if (request.provider === "") request.provider = known.provider;
					}
				}
			}

			const lookup = typeof endpointOf === "function" ? endpointOf : () => null;
			const generationLookup = typeof generationOf === "function" ? generationOf : () => null;
			let cny = 0;
			let cnyMin = 0;
			let cnyMax = 0;
			let tokens = 0;
			const lines = [];
			const unpriced = [];
			for (const request of requests) {
				tokens += request.usage.total;
				const price = resolvePrice(config, book, request);
				if (price === null) {
					unpriced.push(request);
					continue;
				}
				const cost = costOf(price, request.usage, config);
				let range = null;
				// An explicit override is the user pinning the real rate; a ladder
				// must not widen a number they just stated.
				if (config.endpointRanges !== false && price.free !== true && price.source !== "override") {
					const target = targetOf(config, book, request);
					range = quoteWithPricers({
						request,
						target,
						price,
						usage: request.usage,
						config,
						ladder: lookup(target.model),
					});
				}
				cny += cost;
				cnyMin += range === null ? cost : range.min;
				cnyMax += range === null ? cost : range.max;
				lines.push({ request, price, cny: cost, range, generation: generationLookup(request.responseId) });
			}

			const priced = lines.length > 0;
			// Every request resolved to a real generation record: this is the bill,
			// not an estimate, so the range disappears.
			const exact = priced && lines.every((line) => line.generation && line.generation.ok === true);
			const certain = exact || (priced && lines.every((line) =>
				line.price.source === "deepseek" || line.price.source === "override" || line.price.free === true));
			if (exact) {
				cny = 0;
				for (const line of lines) {
					line.cny = num(line.generation.costUsd) * config.usdToCny;
					cny += line.cny;
				}
				cnyMin = cny;
				cnyMax = cny;
			}
			const note = priced ? "" : "本轮 未定价 · turn " + turnNumber +
				" · " + requests.length + " 次请求 · " +
				"模型 " + (uniqueModels(requests.map((request) => request.model)).join(", ") || "(空)") +
				" · 提供方 " + (uniqueModels(requests.map((request) => request.provider)).join(", ") || "(空)") +
				" · 估算 " + (estimated ? "是" : "否") +
				" · 目录 " + (book === null ? "未加载" : "已加载 " + Object.keys(asObject(book.entries)).length + " 条")
			return {
				state: priced ? "ok" : "unknown",
				note,
				count: requests.length,
				pricedCount: lines.length,
				unpricedCount: unpriced.length,
				cny,
				cnyMin,
				cnyMax,
				exact,
				estimatedPrice: priced && !certain,
				tokens,
				lines,
				unpriced,
				estimated,
				models: uniqueModels(lines.map((line) => line.request.model)),
			};
		}


		// ---------------------------------------------------------------------
		// Session total for the composer dock.
		//
		// One pass over the settled nodes, priced per request exactly like the
		// turn footers, then scaled by the tokenUsage projection when the loaded
		// window is paged or compacted (the unloaded turns are assumed to share
		// the window's price mix).
		// ---------------------------------------------------------------------
		function projectionTokensOf(projection) {
			if (!projection || typeof projection !== "object") return 0;
			return num(projection.uncachedInputTokens) +
				num(projection.cacheReadTokens) +
				num(projection.cacheWriteTokens) +
				num(projection.outputTokens);
		}

		function sessionTotals(nodes, config, book, projection, generationOf, store) {
			const lookupGeneration = typeof generationOf === "function" ? generationOf : () => null;
			const list = Array.isArray(nodes) ? nodes : [];
			const storeNodes = store && typeof store.values === "function" ? [...store.values()] : [];

			// Sources, in order of precision: settled assistant nodes in the
			// window, assistant nodes in the node store, then the durable
			// per-turn aggregate (one request per completed turn).
			let requests = [];
			let aggregateOnly = false;
			const collect = (source, kind) => {
				for (const node of source) {
					if (!node || typeof node !== "object" || node.kind !== kind) continue;
					const request = requestOfNode(node);
					if (request !== null) requests.push(request);
				}
			};
			collect(list, "assistant");
			if (requests.length === 0) collect(storeNodes, "assistant");
			if (requests.length === 0) {
				for (const node of storeNodes) {
					if (!node || node.kind !== "turn-tail" || !node.data) continue;
					const request = requestFromTail(node.data);
					if (request === null) continue;
					requests.push(request);
					aggregateOnly = true;
				}
			}
			if (requests.length === 0) {
				return { cny: 0, tokens: 0, requests: 0, unpriced: 0, exact: false, estimated: false, models: [], scale: 1, aggregate: false };
			}
			for (const request of requests) rememberRoute(request);

			// A node that lost its route borrows one from anywhere in the session.
			const known = routeFromStore(list, store, 0) || routeFromStore(storeNodes, undefined, 0) || lastKnownRoute;
			if (known !== null) {
				for (const request of requests) {
					if (request.model === "") {
						request.model = known.model;
						if (request.provider === "") request.provider = known.provider;
					}
				}
			}

			let cny = 0;
			let tokens = 0;
			let unpriced = 0;
			let exactAll = true;
			let certainAll = true;
			const models = [];
			for (const request of requests) {
				tokens += request.usage.total;
				if (request.model !== "" && models.indexOf(request.model) < 0) models.push(request.model);
				const generation = lookupGeneration(request.responseId);
				if (generation && generation.ok === true) {
					cny += num(generation.costUsd) * config.usdToCny;
					continue;
				}
				exactAll = false;
				const price = resolvePrice(config, book, request);
				if (price === null) {
					unpriced += 1;
					certainAll = false;
					continue;
				}
				if (price.source !== "deepseek" && price.source !== "override" && price.free !== true) certainAll = false;
				cny += costOf(price, request.usage, config);
			}

			const projected = projectionTokensOf(projection);
			const shownTokens = Math.max(projected, tokens);
			const scale = tokens > 0 && shownTokens > tokens ? shownTokens / tokens : 1;
			return {
				cny: cny * scale,
				tokens: shownTokens,
				requests: requests.length,
				unpriced,
				exact: exactAll && requests.length > 0 && unpriced === 0,
				estimated: requests.length > 0 && !(exactAll || (certainAll && unpriced === 0)),
				models,
				scale,
				aggregate: aggregateOnly,
			};
		}

		function uniqueModels(list) {
			const seen = [];
			for (const item of list) if (item !== "" && seen.indexOf(item) < 0) seen.push(item);
			return seen;
		}

		/** Tooltip body: one line per request, plus the unpriced note. */
		function buildTitle(view, config, book) {
			const head = "本轮 " + (view.estimatedPrice ? "预估 " : "") + displayCost(view.cny, config) +
				(view.exact ? "（实际计费）" : "") +
				(view.estimated ? "（估算）" : "") +
				" · " + formatTokens(view.tokens) + " tok" +
				(view.count > 1 ? " · " + view.count + " 次请求" : "");
			const lines = [head];
			for (const line of view.lines) {
				if (line.generation && line.generation.ok === true) {
					lines.push("· " + (line.generation.provider || "未知提供方") + " · " +
						(line.generation.model || line.request.model || "未知模型") + " · " +
						formatTokens(line.request.usage.total) + " tok · " +
						displayCost(line.cny, config) + "（实际）");
					continue;
				}
				const total = Math.max(line.request.usage.total, 1);
				const rateCny = (line.cny / total) * 1e6;
				const rate = line.price.free === true ? "免费" : formatRate(rateCny, config);
				const band = line.price.band === "peak" ? " · 峰时" : line.price.band === "offpeak" ? " · 谷时" : "";
				const ladder = line.range && line.range.count > 1
					? " · 端点 " + line.range.count + " 个：" + displayCost(line.range.min, config) + "-" + displayCost(line.range.max, config)
					: "";
				lines.push("· " + (line.request.model || "未知模型") + band + " · " + formatTokens(line.request.usage.total) + " tok · " + displayCost(line.cny, config) + "（" + rate + "）" + ladder);
			}
			for (const request of view.unpriced) {
				lines.push("· " + (request.model || "未知模型") + " · 未定价（没有匹配的价格条目）");
			}
			if (view.lines.some((line) => line.range && line.range.count > 1)) {
				lines.push("· OpenRouter 同一模型按上游提供方定价，实际取当时路由到的那一家");
			}
			if (view.estimated) lines.push("· 该轮请求明细未加载，按本轮汇总量估算");
			if (book && Array.isArray(book.warnings) && book.warnings.length > 0) lines.push("· 价格源告警：" + book.warnings[0]);
			if (config.priceNote !== "") lines.push("· " + config.priceNote);
			return lines.join("\n");
		}

		// ---------------------------------------------------------------------
		// CSS: sits above the usage/time row, right-aligned, muted.
		// ---------------------------------------------------------------------
		const CSS = `
.dsh-turn-cost{display:flex;justify-content:flex-end;align-items:center;gap:6px;padding:2px 0 0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-turn-cost-label{overflow:hidden;text-overflow:ellipsis}
.dsh-turn-cost-muted{opacity:.75}
.dsh-turn-cost-warn{color:var(--dsw-alias-state-warn-primary,#d97706)}
.dsh-turn-cost-total-anchor{display:inline-flex;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.dsh-turn-cost-total{display:inline-flex;align-items:center;padding:1px 8px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:default}
`;

		function ensureStyle() {
			if (typeof document === "undefined") return;
			const tagId = "dsh-turn-cost/style.css";
			if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-turn-cost";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.append(tag);
		}

		// ---------------------------------------------------------------------
		// Component
		// ---------------------------------------------------------------------
		function createTurnCost() {
			function TurnCost(props) {
				const turn = props.turn;
				const turnNumber = turn && typeof turn.turn === "number" ? turn.turn : null;
				const useChat = props.useChat;
				const nodes = typeof useChat === "function"
					? useChat((snapshot) => (snapshot && snapshot.legacy && Array.isArray(snapshot.legacy.nodes) ? snapshot.legacy.nodes : NO_NODES))
					: [];
				const store = typeof useChat === "function"
					? useChat((snapshot) => (snapshot ? snapshot.nodes : undefined))
					: undefined;
				const book = React.useSyncExternalStore(bookStore.subscribe, bookStore.get, bookStore.get);
				const config = React.useMemo(() => configFrom(book), [book]);
				const endpointsVersion = React.useSyncExternalStore(
					endpointsStore.subscribe,
					endpointsStore.version,
					endpointsStore.version,
				);

				// Models this turn actually used, so only those ladders are fetched.
				const endpointsKey = React.useMemo(() => {
					if (turnNumber === null || config.endpointRanges === false) return "";
					const seen = [];
					for (const request of requestsOf(nodes, turnNumber)) {
						const target = targetOf(config, book, request);
						if (!/openrouter/i.test(target.provider) || target.model === "") continue;
						if (seen.indexOf(target.model) < 0) seen.push(target.model);
					}
					return seen.join("|");
				}, [nodes, turnNumber, config, book]);

				React.useEffect(() => {
					if (endpointsKey !== "") endpointsStore.ensure(endpointsKey.split("|"));
				}, [endpointsKey]);

				const generationVersion = React.useSyncExternalStore(
					generationStore.subscribe,
					generationStore.version,
					generationStore.version,
				);

				// Only recent turns are looked up: a long session has hundreds of
				// generation ids and each lookup is one HTTP call.
				const generationIds = React.useMemo(() => {
					if (turnNumber === null || config.generationLookup === false) return "";
					let maxTurn = 0;
					for (const node of Array.isArray(nodes) ? nodes : []) {
						if (node && node.kind === "assistant" && typeof node.turn === "number" && node.turn > maxTurn) maxTurn = node.turn;
					}
					if (turnNumber < maxTurn - config.generationLookback) return "";
					const seen = [];
					for (const request of requestsOf(nodes, turnNumber)) {
						if (request.responseId !== "" && seen.indexOf(request.responseId) < 0) seen.push(request.responseId);
					}
					return seen.join("|");
				}, [nodes, turnNumber, config]);

				React.useEffect(() => {
					if (generationIds !== "") generationStore.ensure(generationIds.split("|"));
				}, [generationIds]);

				React.useEffect(() => {
					bookStore.load(false);
				}, []);

				const view = React.useMemo(() => {
					if (!config.enabled || turnNumber === null) return null;
					try {
						return priceTurn(
							nodes,
							store,
							turnNumber,
							config,
							book,
							(model) => endpointsStore.get(model),
							(id) => generationStore.get(id),
						);
					} catch {
						return null;
					}
				}, [nodes, store, turnNumber, config, book, endpointsVersion, generationVersion]);

				if (view === null || view.count === 0) return null;
				if (view.state !== "ok") {
					if (config.unknownDisplay === "hidden") return null;
					return React.createElement("div", {
						className: "dsh-turn-cost",
						title: view.note || "本轮 未定价",
					},
						React.createElement("span", { className: "dsh-turn-cost-label dsh-turn-cost-muted" }, "本轮 未定价"));
				}

				const wide = view.cnyMax > view.cnyMin * 1.05;
				const amount = wide ? formatRange(view.cnyMin, view.cnyMax, config) : displayCost(view.cny, config);
				const label = "本轮 " + (view.estimatedPrice ? "预估 " : "") + amount +
					(config.showRequests && view.count > 1 ? " · " + view.count + " 次" : "");
				return React.createElement("div", {
					className: "dsh-turn-cost",
					title: buildTitle(view, config, book),
					"data-turn-cost": String(turnNumber),
				},
					React.createElement("span", { className: "dsh-turn-cost-label" }, label),
					view.unpricedCount > 0
						? React.createElement("span", {
							className: "dsh-turn-cost-warn",
							title: "有 " + view.unpricedCount + " 次请求没有匹配到价格",
							role: "img",
							"aria-label": "存在未定价请求",
						}, "＋未定价")
						: null);
			}
			return React.memo(TurnCost);
		}


		/**
		 * Session total beside the usage pill.
		 * @param props - slot props (useChat, useProjection).
		 */
		function createSessionTotal() {
			function SessionTotal(props) {
				const useChat = props.useChat;
				const nodes = typeof useChat === "function"
					? useChat((snapshot) => (snapshot && snapshot.legacy && Array.isArray(snapshot.legacy.nodes) ? snapshot.legacy.nodes : NO_NODES))
					: NO_NODES;
				const store = typeof useChat === "function"
					? useChat((snapshot) => (snapshot ? snapshot.nodes : undefined))
					: undefined;
				const projection = typeof props.useProjection === "function" ? props.useProjection("tokenUsage") : undefined;
				const book = React.useSyncExternalStore(bookStore.subscribe, bookStore.get, bookStore.get);
				const config = React.useMemo(() => configFrom(book), [book]);
				const generationVersion = React.useSyncExternalStore(
					generationStore.subscribe,
					generationStore.version,
					generationStore.version,
				);

				React.useEffect(() => {
					bookStore.load(false);
				}, []);

				const view = React.useMemo(() => {
					if (!config.enabled) return null;
					try {
						return sessionTotals(nodes, config, book, projection, (id) => generationStore.get(id), store);
					} catch {
						return null;
					}
				}, [nodes, store, config, book, projection, generationVersion]);

				// Nothing priced at all: show the honest dash, not ¥0.
				if (view === null || view.requests === 0 || view.unpriced === view.requests) {
					if (config.unknownDisplay === "hidden") return null;
					return React.createElement("span", { className: "dsh-turn-cost-total-anchor", "data-composer-stat": "cost" },
						React.createElement("span", {
							className: "dsh-turn-cost-total",
							title: view === null
								? "会话总消耗未知 · 组件异常"
								: "会话总消耗未知 · " + (view.requests === 0
									? "未取到已结算节点"
									: "全部未定价 · " + view.requests + " 次请求 · 模型 " + (view.models.join(", ") || "(空)")),
						},
							React.createElement("span", { className: "dsh-turn-cost-muted" }, "总 ¥—")));
				}

				const amount = displayCost(view.cny, config);
				const label = "总 " + (view.estimated ? "预估 " : "") + amount;
				const rate = (view.tokens > 0 ? view.cny / view.tokens : 0) * 1e6;
				const title = [
					"会话总消耗 " + amount + "（" + (view.exact ? "实际计费" : view.estimated ? "预估" : "官方价目") + "）",
					formatTokens(view.tokens) + " tok · " + view.requests + " 次请求",
					formatRate(rate, config),
					"模型 " + (view.models.length === 0 ? "未知" : view.models.length > 2 ? view.models.slice(0, 2).join("、") + " 等 " + view.models.length + " 种" : view.models.join("、")),
					view.unpriced > 0 ? "其中 " + view.unpriced + " 次未定价" : "",
					view.scale > 1 ? "含未加载轮次估算（×" + view.scale.toFixed(2) + "）" : "",
					view.aggregate ? "按每轮汇总量估算" : "",
				].filter((line) => line !== "").join(" · ");

				return React.createElement("span", {
					className: "dsh-turn-cost-total-anchor",
					"data-composer-stat": "cost",
				}, React.createElement("span", { className: "dsh-turn-cost-total", title }, label));
			}
			return React.memo(SessionTotal);
		}

		// ---------------------------------------------------------------------
		// Plugin entry
		// ---------------------------------------------------------------------
		function apply(ctx) {
			ensureStyle();
			try {
				ctx.provide("turnCostPricers", {
					register: registerPricer,
					list: () => [...pricers],
				});
			} catch {
				// Older hosts expose no reflection service; built-ins still run.
			}
			const TurnCost = createTurnCost();
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail",
				id: "turn-cost",
				order: 40,
			}, TurnCost));

			// Session total beside the usage pill (the seat dsh-cost-pill used).
			const SessionTotal = createSessionTotal();
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "cost",
				order: 2,
			}, SessionTotal));
		}

		exports.apply = apply;
		exports.inject = ["slots"];

		// Test surface for the offline harness; production never reads it.
		exports.__test = {
			DEEPSEEK,
			DEFAULT_CONFIG,
			normalizeConfig,
			configFrom,
			resolvePrice,
			costOf,
			priceTurn,
			sessionTotals,
			costRange,
			tierRatios,
			registerPricer,
			quoteWithPricers,
			openrouterPricer,
			targetOf,
			formatRange,
			endpointsStore,
			generationStore,
			requestsOf,
			requestFromTail,
			isPeak,
			stripSuffix,
			formatCost,
			formatTokens,
			displayCost,
			bookStore,
			createTurnCost,
			createSessionTotal,
			resetRoutes() { lastKnownRoute = null; },
		};

		return module.exports;
	},
});

