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
│  ├─ index.ts                # 库入口（供程序化调用）
│  └─ checks/
│     ├─ types.ts             # CheckResult 模型与 pass/fail/skip 构造器
│     └─ c2-challenge.ts      # C2：402 挑战结构（10 条断言）
├─ test/
│  ├─ c2-challenge.test.ts    # C2 正例、反例、别名、边界
│  ├─ wire.test.ts            # 编解码与畸形输入
│  └─ networks.test.ts        # 网络归一化与确证标记
├─ examples/
│  └─ mock-seller.ts          # 合成卖家：正常 / 坏样本两种模式的演示数据
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

依赖方向单向：`cli → checks → (wire, networks)`；`config` 只被 `cli` 使用。`checks` 内部不发请求、不读环境变量，因此可以用固定输入做纯单测。

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

## 设计决策

1. **fail-closed**：读不到、解不出、字段缺失，一律判失败或跳过，绝不默认通过。宁可让人去排查，也不给出虚假的成功结论。
2. **对命名容忍、对存在性严格**：SDK 版本间字段名不一致（`maxAmountRequired` / `amount`），检查器接受别名；但字段完全没有时直接失败，不猜默认值。
3. **未确证的东西不硬编码**：mainnet 的 RPC 与浏览器地址没有公开确证来源，`networks.ts` 里保留为 `null` + `verified: false`，由配置补齐，报告里会提示。
4. **传输失败与协议失败分开**：连不上是退出码 3，不是「该服务不合规」。这条区分决定了 CI 里能否自动重试。
5. **checks 是纯函数**：不读环境、不发请求，因此可以离线、可重复、可被任何 runner 复用（未来的 watch 模式、批量模式都基于它）。

## 新增一个检查项

以 C5 为例，按现有约定扩展即可：

1. 在 `src/checks/` 新建 `c5-replay.ts`，导出 `checkReplay(input): CheckResult[]`。
2. 断言 id 用 `c5.*` 前缀，级别在 `critical` / `warning` 中选一个，并写清 `detail` 里人能看懂的原因。
3. 顺带在 `test/c5-replay.test.ts` 写正例 + 至少 3 个反例 + 1 个边界。
4. 在 `src/index.ts` 导出，在 `cli.ts` 的 `check` 流程里按 `--checks` 过滤后调用。
5. 更新 `docs/CHECKS.md` 的断言表与 `CHANGELOG.md` 的 Unreleased。
6. `npm run check` 全绿后再提 PR。

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
