# 架构与本地开发

本文件说明目录结构、模块职责、关键流程与本地开发方式。目标是让人在 10 分钟内看懂「一条 URL 进来，经过哪些代码，最后为什么是退出码 1」。

## 目录结构

```
kite-x402-conformance/
├─ src/
│  ├─ cli.ts                  # 命令注册、参数解析、报告输出、退出码
│  ├─ config.ts               # 环境变量 schema 与启动校验
│  ├─ networks.ts             # Kite 网络常量与 network 字段归一化
│  ├─ wire.ts                 # PAYMENT-* 头的 base64/JSON 编解码
│  ├─ eip712.ts               # EIP-712 域/结构散列、EIP-3009 摘要、65 字节签名解析
│  ├─ index.ts                # 库入口（供程序化调用）
│  └─ checks/
│     ├─ types.ts             # CheckResult 模型与 pass/fail/skip 构造器
│     ├─ parse.ts             # C2/C3 共用的字段别名读取
│     ├─ c2-challenge.ts      # C2：402 挑战结构（10 条断言）
│     ├─ c3-authorization.ts  # C3：授权可构造（14 条断言）
│     └─ c4-settlement-order.ts # C4：结算时序（12 条断言，输入为注入的四探针观测）
├─ test/
│  ├─ c2-challenge.test.ts    # C2 正例、反例、别名、边界
│  ├─ c3-authorization.test.ts# C3 正例、拒付路径、窗口边界、归因
│  ├─ c4-settlement-order.test.ts # C4 四探针正例、时序反例、收据与 skip 边界
│  ├─ eip712.test.ts          # 手写编码与 viem 逐字节比对、黄金值、签名解析
│  ├─ wire.test.ts            # 编解码与畸形输入
│  └─ networks.test.ts        # 网络归一化与确证标记
├─ examples/
│  ├─ mock-seller.ts          # 合成卖家：正常 / 坏样本两种模式的演示数据
│  └─ mock-payer.ts           # 合成付款方：对挑战签名并打印 PAYMENT-SIGNATURE
├─ docs/                      # 架构、CLI、检查项、测试、限制、证据、提交材料
├─ .github/workflows/ci.yml   # typecheck → test → build → CLI smoke
├─ .env.example               # 配置模板（不含真实密钥）
├─ CHANGELOG.md
└─ LICENSE                    # Apache-2.0
```

## 模块职责

| 模块 | 职责 | 不负责 |
|---|---|---|
| `cli.ts` | 解析命令与参数、发起 HTTP 请求、渲染报告、决定退出码 | 具体断言逻辑 |
| `config.ts` | 读取并校验环境变量；非法值启动即失败 | 业务判断 |
| `networks.ts` | 链 id、CAIP-2、端点与确证状态；把 `2368` / `"2368"` / `"eip155:2368"` 归一化 | 发起任何请求 |
| `wire.ts` | 头的编解码；畸形输入返回错误而不是空对象 | 判断协议是否合规 |
| `checks/types.ts` | 统一结果模型（`pass` / `fail` / `skip`）与严重级别 | — |
| `checks/c2-challenge.ts` | C2 的 10 条断言，纯函数，输入为状态码 + headers | 网络 IO、报告输出 |
| `checks/c3-authorization.ts` | C3 的 14 条断言，输入为两个头值 + 评估时刻；签名恢复是 CPU 计算，不联网 | 网络 IO、报告输出、链上状态 |
| `checks/c4-settlement-order.ts` | C4 的 12 条时序断言，输入为四个探针的可信观测；收据解码是纯计算 | 网络 IO、报告输出、探针采集（属 runner） |
| `checks/parse.ts` | 字段别名读取（`amount`/`maxAmountRequired` 等），一份规则两处复用 | 判断合规性 |
| `eip712.ts` | 手写 EIP-712 域分隔符与结构散列、EIP-3009 摘要、65 字节签名解析（含 v 与低 s 判定） | 决定断言级别 |

依赖方向单向：`cli → checks → (wire, networks, eip712)`；`config` 只被 `cli` 使用。`checks` 内部不发请求、不读环境变量，因此可以用固定输入做单测——C3 的 `now` 也是这样从 runner 注入的，否则测试会随系统时钟漂移。

`eip712.ts` 不调用 viem 的 `hashTypedData`，而是显式拼每一段字节：签名失败时，唯一能定位问题的产物是 domain separator 与 struct hash，而不是一个不透明摘要。代价是这段编码必须被独立验证，所以 `test/eip712.test.ts` 同时做了两件事——与 viem 的 `domainSeparator` / `hashTypedData` 逐字节比对，以及固定一组 Kite testnet 的黄金值。

## 关键流程：一次 `check`

```
1. cli 解析参数 → config.loadConfig() 校验环境变量（非法则退出 3）
2. 发起 GET（AbortSignal.timeout，默认 10s）
   └─ 传输层失败 → 打印 "transport failure"，退出 3（不当成协议结论）
3. 把响应头平铺成 Record<string,string>
4. checkChallenge({status, headers, expectedNetwork, expectedPayTo})
   ├─ c2.status      状态码是否 402
   ├─ c2.header      是否存在 PAYMENT-REQUIRED（大小写不敏感）
   ├─ c2.decode      base64 / base64url / URL 编码 → JSON
   ├─ c2.version     x402Version === 2
   ├─ c2.scheme      accepts[0].scheme === "exact"
   ├─ c2.network     network 归一化后等于期望的 CAIP-2
   ├─ c2.asset       资产地址通过 isAddress
   ├─ c2.pay-to      收款地址通过 isAddress
   ├─ c2.amount      maxAmountRequired/amount 为正整数原子单位
   └─ c2.pay-to-match 配置了期望收款地址时比较
5. 汇总 pass/fail/skip → 渲染（人类可读或 --json）
6. 退出码：有 critical 失败 → 1；仅 warning 失败 → 2；否则 0
```

前置断言失败时，后续依赖它的断言记为 `skip` 而不是 `fail`，避免一个根因刷出十条红字；同时报告底部明确提示「skip 不代表通过」。

## 关键流程：一次 `authorize`

```
1. cli 解析参数
   ├─ 挑战来源：<url> 现取 402，或 --challenge <path> 读已保存的载荷（离线模式）
   └─ 载荷来源：--payment-signature <value|@path>
2. now 由 runner 决定：系统时钟，或 --now 指定的时刻
3. checkAuthorization({challengeHeader, paymentHeader, expectedNetwork, now, ...})
   ├─ c3.challenge        挑战可解码且含支付选项
   ├─ c3.payment          载荷可解码为 JSON 对象
   ├─ c3.payload-version  x402Version === 2
   ├─ c3.payload-shape    authorization 六个字段齐全且类型正确
   ├─ c3.accepted-binding payload.accepted 与挑战选项逐字段一致
   ├─ c3.binding-payto    authorization.to === 报价 payTo
   ├─ c3.binding-value    authorization.value === 报价金额（bigint 比较）
   ├─ c3.address-sanity   from/to 非零且互不相同
   ├─ c3.domain-config    extra.name / extra.version 可用，chainId 与 asset 可解析
   ├─ c3.window           validAfter <= now 且 validBefore >= now + 6
   ├─ c3.window-span      剩余可重放时间不超过 maxTimeoutSeconds（warning）
   ├─ c3.signature-format 65 字节 r‖s‖v，v ∈ {27,28}
   ├─ c3.signature-low-s  s <= n/2
   └─ c3.signature-recovery 复算 digest 后 ecrecover === authorization.from
4. 汇总 pass/fail/skip → 渲染（人类可读或 --json，附带 evaluatedAt）
5. 退出码规则与 check 相同
```

`c3.signature-recovery` 是唯一会做多次椭圆曲线运算的断言：失败时它会把 `version` 与 `chainId` 的各种组合重新算一遍，用来判断「客户到底对着哪个域签的」。这段计算在 `authorize` 里是可观测的（报告耗时约毫秒级），不构成性能问题。

## C4：判定层，尚无子命令

C4 与 C2/C3 的一个关键差别：它的输入无法从一次客户端响应推出。`upstreamCalled` 与 `settled` 是服务端内部事件，服务端可以在自己的响应头里声称「已结算」而实际什么都没做。因此 `checkSettlementOrder({ observations })` 只做判定，四个探针的执行与观测采集属于未来的 runner 层：

```
runner（未实现）                         checks/c4-settlement-order.ts（本版本）
  无签名请求 ─┐
  错签名请求 ─┤
  上游 4xx   ─┼─→ ProbeObservation[] ──→ checkSettlementOrder() ──→ 12 条 CheckResult
  上游 2xx   ─┘    （含 upstreamCalled /        （纯函数、不发请求、不读环境）
                    settled / 响应头 / 状态码）
```

观测源必须是能看见上游与 facilitator 的那一层（自建 mock，或接了遥测的 runner）。把服务端自报的头部当真值会让 C4 被伪造的服务端骗过；这一点写在 `docs/LIMITATIONS.md`，判定层不假设观测不可信。

因为还没有探针执行层，`cli.ts` **没有** C4 子命令，也没有对应的 live 证据。当前只能通过库入口 `import { checkSettlementOrder } from "kite-x402-conformance"` 传入夹具观测调用。把 C4 接进 CLI 需要先实现 `probes/` 层，这不改变判定函数的接口。

## C5：同为判定层，覆盖三次重复提交

C5 和 C4 面对同一个限制：`settled` / `upstreamCalled` / `cacheHit` 都是服务端内部事件，客户端响应无法证明。所以 `checkReplayIdempotency({ scenarios })` 也是纯函数，输入由 runner 注入：

```
runner（未实现）                          checks/c5-replay-idempotency.ts（本版本）
  同签名 + 新 key   ─┐
  同 key 重试       ─┼─→ ReplayScenario[] ─→ checkReplayIdempotency() ─→ 13 条 CheckResult
  同 nonce 重签     ─┘    （每场景 first/second   （纯函数、不发请求、不读环境）
                            两次尝试观测）
```

三个场景各有自己的 `first-settled` 前置断言：首次没结算成功时，该场景的「未二次结算」是空洞的。这个前置不是可有可无——复审时曾发现 `nonceReuse` 缺这条会导致全套 12 绿却什么都没验证，现已补齐。与 C4 一样，`cli.ts` 没有 C5 子命令，库入口可直接调用。

## 设计决策

1. **fail-closed**：读不到、解不出、字段缺失，一律判失败或跳过，绝不默认通过。宁可让人去排查，也不给出虚假的成功结论。
2. **对命名容忍、对存在性严格**：SDK 版本间字段名不一致（`maxAmountRequired` / `amount`），检查器接受别名；但字段完全没有时直接失败，不猜默认值。
3. **未确证的东西不硬编码**：mainnet 的 RPC 与浏览器地址没有公开确证来源，`networks.ts` 里保留为 `null` + `verified: false`，由配置补齐，报告里会提示。
4. **传输失败与协议失败分开**：连不上是退出码 3，不是「该服务不合规」。这条区分决定了 CI 里能否自动重试。
5. **checks 是纯函数**：不读环境、不发请求，因此可以离线、可重复、可被任何 runner 复用（未来的 watch 模式、批量模式都基于它）。

## 新增一个检查项

以已实现的 C5（`src/checks/c5-replay-idempotency.ts`）为例，按现有约定扩展：

1. 先把规格写进 `docs/CHECKS.md`——它是判定逻辑唯一来源，代码与它不一致时改代码。
2. 在 `src/checks/` 新建模块，导出 `checkXxx(input): CheckResult[]`；断言 id 用 `cN.*` 前缀，级别在 `critical` / `warning` 中选，并写清 `detail` 里人能看懂的亏损原因。
3. 写 `test/cN-*.test.ts`：正例 1 个、反例 ≥3、边界 ≥1；每个反例只偏离正例一个字段。
4. 在 `src/index.ts` 导出；需要外部数据的部分由 runner 注入，检查器不读环境、不发请求。
5. 同步 `docs/LIMITATIONS.md`、`docs/TESTING.md`、`CHANGELOG.md` 的测试数与状态。
6. `npm run check` 全绿、再经独立对抗性复审后提交。C5 的复审曾查出「首次未结算却全套绿灯」的空洞通过——代码忠于当时的规格，是规格本身缺前置断言；写规格时要主动找这类缺口。

## 本地开发

```bash
npm ci
npm run dev -- check http://localhost:8080/v1/echo   # 直接跑源码
npm run test:watch                                   # 测试热跑
npm run check                                        # typecheck + test + build
npm run example                                      # 起合成卖家，配合 dev 使用
```

## 构建与发布

```bash
npm run build          # tsc -p tsconfig.build.json → dist/
npm pack --dry-run     # 确认发布内容不含密钥与多余文件
npm publish --access public
```

发布前必须确认：`npm run check` 全绿、`CHANGELOG.md` 已写、`git status` 无未提交改动、`npm pack --dry-run` 列表里只有 `dist/` 与文档。

## 扩展点（已预留，未实现）

`checks/` 之外的两层**只在文档里规划，没有落任何空壳代码**——避免出现「目录里有文件，跑起来是 not implemented」的情况：

| 层 | 计划职责 | 触发条件 |
|---|---|---|
| `probes/` | 周期性探测，产生时序数据（可用性、结算成功率） | C1–C5 全部稳定后 |
| `reporters/` | JUnit XML、SARIF、HTML | 有 CI 消费者提出需求后 |

新增层时保持同样的约束：纯函数优先、不读环境、失败必须显式。
