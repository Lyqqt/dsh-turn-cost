# dsh-turn-cost

每一轮对话结束处显示 `本轮 ¥0.xx`，**按这一轮里的每一次计费请求分别计价再求和**。

不是为了"估个大概"：一轮里可能换了模型、跨了 DeepSeek 的峰谷分界、混了免费路由，
整轮取一个价会错。所以它拿每条 `assistant` 节点的 usage + 模型 + 时间，各算各的。

## 架构：固定价走 core，浮动价走 pricer

```
core（永远存在）      模型价：models.dev / DeepSeek 人民币峰谷 / overrides / aliases / tiers
                          ↓ 单值
pricer（可插拔）       "同一模型有多个价" 的策略层：路由后缀、preset、端点价目
                          ↓ 区间或单值
渲染                  turnTail 底部读数
```

- **core** 不知道 OpenRouter 存在，只知道"这个模型每百万 token 多少钱"。
- **pricer** 只回答一个问题："这一次请求，在此路由下，价格可能是多少？"
  匹配由 `match(target)` 决定，`quote()` 返回 `{ min, max, count, note } | null`；
  返回 `null` 表示"没有意见"，让下一个 pricer 或模型价接手。
- **OpenRouter pricer 是开发者随插件提供的第一个实现**（`OPENROUTER_PRICER_ID`），
  它负责端点价目、`:floor` / `:exacto` / `*flex|cheap` 的候选集收窄。
- 用户 pricer 的优先级高于内置：`registerPricer()` 走 `unshift`，后注册的先问。
- 每个 pricer 可以用配置单独关掉：`pricers: { openrouter: false }`。

## 新增一个 pricer

客户端插件里注入 `turnCostPricers` 即可（和 `ctx.slots` 一样的用法）：

```js
export function apply(ctx) {
  ctx.inject(['turnCostPricers'], (scope) => scope.turnCostPricers.register({
    id: 'my-relay',
    // 只接自家路由；返回 false 就交给别人
    match: (target) => target.provider === 'my-relay',
    quote({ request, target, price, usage, config, ladder }) {
      // price 是 core 给出的模型价；ladder 是该模型在本路由下的端点价目
      // （内置只有 openrouter 有 ladder，其它路由拿到 null）
      return { min: 0.01, max: 0.03, count: 2, note: '自定义两档' }
    },
  }))
}
```

`register()` 返回注销函数。注意这是**客户端** seam：它要渲染，就必须跑在浏览器半。

只想改数字、不想写代码的两级仍然保留：`overrides`（钉死某个 id 的价格）、
`priceModules`（宿主侧 `.mjs`，适合批量拉价目表）。

## 显示在哪

**每轮底部**：`conversation.chat.turnTail`；**输入框底栏**：`conversation.composer.dock` 的会话总量 `总 ¥…`。



`conversation.chat.turnTail` —— DSH 官方给"一轮结束时的附加内容"留的扩展点，
渲染在 usage / 时间那一行**之前**，也就是每轮的最底部：

```
… 助手回复正文 …
本轮 ¥0.42 · 3 次          ← 这里
[用量] [复制] [分支] 20:31
```

悬停展开明细：

```
本轮 ¥0.42 · 234.0k tok · 3 次请求
· openai/gpt-6.1-sol · 120.0k tok · ¥0.36（3.00 CNY/M）
· deepseek-flash · 谷时 · 114.0k tok · ¥0.06（0.53 CNY/M）
· @preset/ds41f-cheap · 未定价（没有匹配的价格条目）
```

## 计价口径

| 请求来自 | 价格来源 | 说明 |
| --- | --- | --- |
| `deepseek-official` 路由 | 内置人民币峰谷表 | 峰时（北京工作日 09:00–12:00、14:00–18:00）按 2 倍，周末与法定节假日按谷时，CNY/M |
| 其他路由（openrouter / 自定义） | models.dev 挂牌价（USD/M） | 按 `provider|model` 匹配；`:free` 后缀直接记 0 |
| 手写 `overrides` | 用户配置 | 优先级最高 |
| `priceModules` / `registerPriceSource` | 用户代码 | 优先级最高，可用于中转站、内部价目表 |

细节：

- 一条 `assistant` 节点 = 一次计费请求，代价是它自己的 `inputTokens /
  cacheReadTokens / cacheWriteTokens / outputTokens`，时间用它自己的 `time`。
  所以同一轮跨过 18:00 时，前半段按峰时、后半段按谷时。
- 路由后缀 `:exacto` / `:floor` / `:nitro` 会先剥掉再查基座模型；`@preset/<name>`
  这种"模型 + 预设路由"会把 `@preset/...` 剥掉查同一个模型（预设的 provider
  偏好不会体现在价格里）；`:free` 直接为 0。裸的 `@preset/xxx`（没有模型前缀）
  只能靠 `aliases` 指到具体模型。
- models.dev 的 `tiers`（上下文超过 272k 之类）按 prompt token 数选档，
  所以 `openai/gpt-6.1-sol` 在 300k prompt 时按 $4/$15 而不是 $2/$10。
- **查不到就显示"未定价"，绝不返回 0 或猜一个数**。部分请求未定价时读数后面会带
  `＋未定价`，不会把缺口悄悄抹掉。
- 该轮的请求明细没加载（分页 / 压缩）时，回退到 `turn-tail.tokenUsage` 单次计价，
  读数标"（估算）"。

## 安装

从 GitHub 直接装进 profile：

```powershell
dsh plugin --profile desktop add github:Lyqqt/dsh-turn-cost
```

或者克隆后本地安装（`link:` 依赖，改代码即时生效）：

```powershell
git clone https://github.com/Lyqqt/dsh-turn-cost.git
powershell -ExecutionPolicy Bypass -File .\dsh-turn-cost\install.ps1
```

两者都会把 `dsh-turn-cost` 追加到 `dsh.profile.bundles`。装完在插件中心能看到
「费用」条目；宿主半（价格目录路由）需要重启一次 DeepSeek Harness 才加载，
客户端半有 HMR。

验证：浏览器打开 `http://127.0.0.1:<port>/dsh-turn-cost/prices.json` 应当返回
`{"ok":true,...}` 的价格目录。

> 第一次用建议先配 `proxy`（如果需要代理才能访问 models.dev），否则价格目录会为空、
> 读数显示「预估」或「未定价」。

## 配置

写在 profile 自己的 `cordis.patch.yml` 里（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: turn-cost
  name: dsh-turn-cost
  config:
    currency: CNY          # CNY | USD（内部一律 CNY，USD 只是显示换算）
    usdToCny: 7.2
    proxy: socks5://127.0.0.1:1080   # 宿主拉取价格目录用的代理；留空=直连
    refreshHours: 24
    unknownDisplay: dash   # dash=显示「未定价」 hidden=不显示
    showRequests: true     # 只显示金额，还是「¥0.42 · 3 次」
    priceNote: '价格来自 openrouter'
    sources:
      modelsDev: true
      openrouter: true     # 额外拉 OpenRouter /api/v1/models（实时挂牌价）
    pricers:
      openrouter: true     # 端点价目 + 路由区间；false = 只用模型价
    aliases:
      '@preset/ds41f-cheap': 'openrouter|deepseek/deepseek-v4.1-flash'
    overrides: []
    priceModules: []
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉就不渲染 |
| `currency` / `usdToCny` | `CNY` / `7.2` | 显示币种与汇率 |
| `proxy` | `''` | `socks5://`、`socks://`；宿主用它拉目录 |
| `refreshHours` | `24` | 目录缓存新鲜度；过期后后台刷新 |
| `providers` | 常见 15 家 | 只把这些 models.dev provider 写进目录（体积 ~145 KB） |
| `providerMap` | `{deepseek-official: deepseek}` | DSH 路由 id → models.dev provider id |
| `aliases` | `{}` | 模型别名，值是 `provider|model` 或裸模型 id |
| `overrides` | `[]` | 手写单价，优先级最高 |
| `priceModules` | `[]` | `.mjs` 价格模块路径 |
| `endpointRanges` | `true` | 总开关：关掉后所有 pricer 都不参与，只显示模型价 |
| `pricers` | `{}` | 按 id 关掉某个 pricer，如 `{ openrouter: false }` |
| `generationLookup` | `true` | 用 generation id 查**实际**提供方与费用（需要 OpenRouter key） |
| `generationLookback` | `10` | 只查最近多少轮（每条 generation 一次请求） |

### 为什么有时候显示的是区间

同一个 OpenRouter 模型，**不同上游提供方的价格可以差 10–30 倍**（实测）：

| 模型 | 端点数 | 输入价范围 |
| --- | --- | --- |
| `openai/gpt-6.1-sol` | 6 | $1 – $12 /M |
| `deepseek/deepseek-v4.1-flash-1017` | 50 | $0.03 – $0.60 /M |
| `deepseek/deepseek-v4.1-flash` | 37 | $0.05 – $1.50 /M |
| `minimax/minimax-m3.1-flash` | 13 | $0.135 – $0.17 /M |

**但 DSH 其实记了 generation id。** 每条 assistant 消息的
`message.source.replayState.response.responseId` 就是 OpenRouter 的 `gen-…`：

```json
{ "kind": "pi-ai", "provider": "openrouter",
  "model": "deepseek/deepseek-v4.1-flash:exacto",
  "responseModel": "deepseek/deepseek-v4.1-flash",
  "responseId": "gen-1791990656-G1WVCqd3xOnIREnXiFkl" }
```

宿主拿这个 id 调 `GET https://openrouter.ai/api/v1/generation?id=…`，就能拿到**这条请求**的
`provider_name` 和 `total_cost`（OpenRouter 实际扣的钱）。所以：

- **最近 `generationLookback` 轮**：逐请求查实际值，全部命中时读数变成**实际计费**，
  区间消失，tooltip 显示 `OpenAI · ¥0.02（实际）`。
- 拿不到（老会话、没配 key、请求被清理、超时）：退回下面的端点区间。
- key 从宿主凭据服务取（`OPENROUTER_API_KEY`，和路由用的是同一个），不落地、不写日志。

在没有 generation 数据时，才是下面这套区间逻辑：

- 端点价目（公开的 `/models/{id}/endpoints`）能给出**区间**，插件把它显示成 `本轮 ¥1.44-2.88`，
  悬停列出端点数、区间、以及"实际取当时路由到的那一家"。
- 只有一个端点、或 DeepSeek 官方路由时，区间塌缩成一个数，和以前一样精确。
- 阶梯价（>272k）按比例作用在每个端点上，不是直接套 models.dev 的绝对价。

### 读数前缀：什么时候写「预估」

| 判定 | 前缀 | 依据 |
| --- | --- | --- |
| 有 generation 记录（实际扣费） | 无 | OpenRouter 账单 |
| DeepSeek 官方路由 | 无 | 官方价目卡，单一提供方 |
| 用户 `overrides` 钉死的价 | 无 | 你自己声明的真实价 |
| `:free` 路由 | 无 | 价格为 0，无歧义 |
| 其他（挂牌价、端点区间） | **预估** | 可能是别的上游、可能被折扣 |

典型读数：

```
本轮 ¥0.31                  ← 有 generation 记录，就是账单
本轮 ¥0.18                  ← DeepSeek 官方价目
本轮 预估 ¥1.44-2.88        ← OpenRouter 多端点，按路由提示收窄后的区间
本轮 预估 ¥0.06             ← 挂牌价，暂未拿到 generation 记录
本轮 未定价                  ← 没有匹配的价格条目
```

**路由提示会收窄候选集**（否则区间没有参考价值）：

| 记录的模型 id | 候选端点 | 例子（100k in + 20k out） |
| --- | --- | --- |
| `…:floor` | 只取最便宜的一档（≤ 最低价 ×2），地板价 + 第一回落档 | `¥1.44-2.88`（$1/$5 → $2/$10） |
| `…@preset/*flex` / `*cheap` | 同上 | `¥1.44-2.88` |
| `…:exacto` | 去掉 fp4 / mxfp4 的端点 | `¥0.061-0.778`（42 个精确量化端点） |
| 无后缀 | 全端点 | 视模型而定 |

**如果你知道某个 preset 实际钉死在某一家**，用 `overrides` 把价格钉住，区间就不会再覆盖它：
`overrides` 的优先级在区间之前（`price.source === 'override'` 时跳过端点区间）：

```yaml
overrides:
  - match: 'openrouter|openai/gpt-6.1-sol@preset/gpt61-sol-flex'
    input: 1
    cacheRead: 0.05
    output: 5
    currency: USD
```

### 改了配置不生效？

宿主半只在 profile 启动时读**一次** entry config，所以加 `proxy` 之后必须重启一次
DeepSeek Harness（客户端半是 HMR 的，宿主路由不是）。

不想重启时，还有一层：`~/.dsh/turn-cost/config.json`，**每次重建都会重读**。
同名字段 entry config 优先，文件只补 entry 里没写的：

```json
{
  "proxy": "socks5://127.0.0.1:1080",
  "refreshHours": 12
}
```

写完等下一次重建（失败或空目录会在 60 秒后自动重试；成功的话等 `refreshHours` 过期）。

## 自定义价格：四层，按需选最轻的

### 1. 只是想换个数：`overrides`

```yaml
overrides:
  # 精确到路由
  - match: 'openrouter|openai/gpt-6.1-sol'
    input: 2
    output: 10
    cacheRead: 0.1
    currency: USD
  # 或者只写模型名的一部分（子串匹配，模型 id 变了也还能命中）
  - match: 'minimax-m3.1'
    input: 0.135
    output: 0.54
    currency: USD
```

### 2. 想用 OpenRouter 的实时价目表：一行开关，不用写代码

```yaml
sources:
  modelsDev: true
  openrouter: true     # 宿主去拉 https://openrouter.ai/api/v1/models
```

内置的 OpenRouter 适配器把 `pricing.prompt` / `pricing.completion`（每 token）
换算成每百万 token，并写入 `openrouter|<model id>`，覆盖 models.dev 的同名条目。
**你举的 `openrouter / deepseek/deepseek-v4.1-flash:exacto` 就是这一层能覆盖的场景**
（`:exacto` 会被剥掉再查基座）。

### 3. 想加"一段自己的代码"：`priceModules`

写一个 `.mjs`，导出 `default` 函数，返回 entries / aliases：

```js
// %USERPROFILE%\.dsh\turn-cost\my-prices.mjs
export default async function refresh({ fetchJson, config, log }) {
  const data = await fetchJson('https://my-relay.example.com/prices.json')
  const entries = {}
  for (const row of data.models) {
    entries['openrouter|' + row.id] = {
      input: row.in_per_million,
      cacheRead: row.cache_in_per_million ?? row.in_per_million,
      output: row.out_per_million,
      currency: 'USD',
    }
  }
  log('my-prices: ' + Object.keys(entries).length + ' entries')
  return { entries, aliases: { '@preset/ds41f-cheap': 'openrouter|deepseek/deepseek-v4.1-flash' } }
}
```

```yaml
- id: turn-cost
  name: dsh-turn-cost
  config:
    priceModules:
      - 'C:/Users/you/.dsh/turn-cost/my-prices.mjs'
```

每次刷新都会重新 `import`（带 cache-busting 查询串），**改完文件等一个刷新周期即可生效**，
不用改插件本身。`fetchJson` 自动走你配的 `proxy`。完整模板见
[`examples/my-prices.mjs`](examples/my-prices.mjs)。

模块拿到的东西：

| 参数 | 说明 |
| --- | --- |
| `fetchJson(url, {timeoutMs})` | 走宿主代理的 GET+JSON |
| `config` | 已归一化的配置（可读 `overrides` / `aliases`） |
| `log(message)` | 写进目录的 `warnings`，界面 tooltip 会显示第一条 |

返回：`{ entries, aliases }`；`currency` 缺省为 `USD`；`tiers` 可选。

### 4. 是插件作者：`ctx.turnCost`

宿主导出 `service`，其他插件可以直接注册价格源：

```js
export function apply(ctx) {
  ctx.inject(['turnCost'], (scope) => scope.turnCost.registerPriceSource({
    id: 'my-prices',
    async refresh({ fetchJson }) {
      return { entries: { 'openrouter|x/y': { input: 1, output: 2, currency: 'USD' } } }
    },
  }))
}
```

`registerPriceSource()` 返回注销函数；调用后立即触发一次重建。

## 数据流

```
宿主：models.dev + openrouter + overrides + priceModules
   ↓ 合并成一份 book（~145 KB，磁盘缓存 ~/.dsh/turn-cost/book.json）
GET /dsh-turn-cost/prices.json
   ↓ 浏览器只在加载时取一次（失败 60s 后重试）
客户端：每条 assistant 节点 → 查价 → 求和 → turnTail 渲染
```

浏览器不直接联外网：需要 SOCKS 的那台机器，浏览器本来也连不上；
另外这样只传一份小文档，不用每次拉 6.9 MB 的 models.dev。

## 与其它插件的分工

| 插件 | 负责什么 |
| --- | --- |
| `dsh-turn-cost`（本插件） | 每轮费用 + 底栏会话总量，逐请求计价，多价源 |
| `dsh-whale-widget` | 账户余额与余额差分（唯一能和账单对齐的 ground truth） |
| `dsh-provider-usage` | 各 provider 的余额 / 额度 |
| `dsh-context` | 上下文构成与 scope 级成本 |

> 本插件的底栏总量可以替代 `dsh-cost-pill`：两者占据同一个 dock 位置，但本插件按
> 请求计价、认模型与提供方，`dsh-cost-pill` 只用一张硬编码的 DeepSeek 价目。
> 同时安装会看到两个总量，装一个即可。

## 已知限制

- **精确值依赖 OpenRouter 的 generation 记录**：一条记录被上游清理、超出查询窗口或没有 key 时，
  只能退回端点区间。想完全不依赖联网查询，仍然需要 DSH 在 `assistant/message` 里存下
  `usage.cost`（一处上游改动，所有费用插件受益）。
- models.dev 是**挂牌价**：中转站折扣、批处理价、企业协议价都不在里面，需要 `overrides`
  或 `priceModules` 补。
- DeepSeek 法定节假日只录了 2026 年；每年 11 月国务院发布次年安排后要更新
  （`lib/book.js` 与 `lib/client.js` 两处 `holidays`）。
- `:free` 一律按 0 处理（OpenRouter 的免费档语义）。
- 分页/压缩后回退到 `turn-tail` 的汇总值，是**估算**，tooltip 会标出来。
- 宿主没有 `webServer` 时价格目录取不到，客户端只剩内置的 DeepSeek 人民币价表。
- `/dsh-turn-cost/prices.json` 是**公开只读**路由（只含公开挂牌价，不含凭据）；同一台机器上的任何本地进程都能读到。
- 未定价请求不会计入金额，只在 tooltip 和 `＋未定价` 标记里出现。

## 自测

```powershell
node .\dsh-turn-cost\test\run-tests.mjs          # 44 项纯逻辑用例
node .\dsh-turn-cost\test\host-harness.mjs "socks5://127.0.0.1:1080"  # 真机拉目录
node .\dsh-turn-cost\test\real-book-check.mjs    # 用真目录给真模型定价
```

`host-harness.mjs` 会把真实目录写到 `test/real-book.json`（机器相关，不必提交）。

## License

MIT，见 [LICENSE](LICENSE)。

价格数据来自 [models.dev](https://models.dev) 与 [OpenRouter](https://openrouter.ai)
的公开接口，DeepSeek 价目来自其官方定价页；本项目只是汇总与计价，不对价格本身的
准确性做担保，以厂商账单为准。
