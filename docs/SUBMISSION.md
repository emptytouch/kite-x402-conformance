# 提交材料

四阶段状态**必须分开写**——登记 PR 合并、生态映射生效、commit 被抓取、开发者归因是四件不同的事。

## 1. 基本信息

| 项 | 内容 |
|---|---|
| 仓库链接 | `https://github.com/emptytouch/kite-x402-conformance` |
| 许可证 | Apache-2.0 |
| 当前版本 | `0.2.0`（`85061d1`）；其后的 C1 / C4 / C5 判定层与 C4 sandbox runner（`1a61cfc`）已提交，C5 sandbox runner 与 C1 清单解析 + HTTP 探针 runner 为 Unreleased，见 `CHANGELOG.md` |
| 仓库创建 / 首次公开日期 | `2026-11-16`（GitHub created_at `2026-11-16T14:52:24Z`；首个 commit `a2e067b` 同日） |
| 本期 authored commit | `a2e067b`、`85061d1`、`1a270e5`、`fcfce4d`、`6f37c24`、`12be087`、`1a61cfc`；C5 sandbox runner 与 C1 runner 尚未 commit，见 Unreleased |

已提交的七个 commit（按时间正序）：

```text
a2e067b feat: initial C2 conformance checker with CLI, tests and docs
85061d1 feat: add C3 authorization conformance checks and harden validation
1a270e5 docs: finalize submission record and version history
fcfce4d feat: add C4 settlement order verdict layer
6f37c24 feat: add C5 replay and idempotency verdict layer
12be087 feat(c1): add manifest consistency verdict layer
1a61cfc feat(c4): add sandbox probe runner and verify CLI
```

## 2. 本期变更

| 变更 | 说明 | 关联 commit |
|---|---|---|
| C2：402 挑战结构检查 | 把「返回了 402」与「按 x402 v2 写对挑战」分开判定；实现 10 条断言、CLI `check` / `networks` / `decode`、头的多种编码解码、Kite 2366/2368 网络常量、配置校验与 30 个测试。原因是模板服务普遍有 402，但结构错误仍会导致客户端无法付款。 | `a2e067b` |
| C3：授权可构造检查 | 把「挑战写对了」与「客户签出的付款能自洽结算」分开判定；实现 14 条断言、手写 EIP-712/EIP-3009 编码、`authorize` 命令、离线抓包重放、公开测试私钥签名示例与失败归因。原因是金额/链/域绑错在真机上表现为收不到钱，但只靠 402 结构看不出来。 | `85061d1` |
| 对抗性审查加固 | 对构造输入实测复现并修复 ERC-6492 fail-open、JSON number 被 `JSON.parse` 改写、多选项报价误判、网络绑定缺失、`Object.prototype` 继承键绕过、`network: ""` 遮住 chainId、缺 `asset` 只 skip 等；测试从 85 增至 100。原因是 C3 的「通过」若建立在这些漏洞上会给出虚假信心。 | `85061d1` |
| C4 sandbox 探针执行层 | 只靠一次客户端响应无法证明「有没有真的结算」。新增独立 mock upstream / facilitator 与合成卖家，`verify` 从 mock 请求日志生成观测；六种可注入缺陷逐一反证检查器能抓到真实时序问题，`forged-claim` 证明自报收据不能替代真实 `/settle`。仍是 sandbox，无 live 证据。 | `1a61cfc` |
| C5 sandbox 探针执行层（Unreleased） | 同签名换键重放、同键重试、同 nonce 重新签名都会真实扣款，而单次响应无法区分。新增独立 mock cache 与有状态合成 seller，`verify-replay` 从 facilitator / upstream / cache 三组日志生成观测；七种缺陷逐一反证，包括「自报缓存命中但从不查缓存」与「命中仍结算」两种自报反证。矛盾观测保留 `sandbox.contradictions` 后规范化，让三条亏钱断言照常失败。仍是 sandbox，无 live 证据。 | 本次新增，待 commit |
| C1 清单解析 + 真实 HTTP 探针（Unreleased） | 判定层此前只吃结构化输入，无法回答「清单写的和服务实际返回的是否一致」。新增 JSON / 受限 YAML 解析器与 `verify-manifest`：从本地文件或不同 origin 的 `/.well-known/x402` 读清单，对每个声明路径发真实 `GET`，从 402 响应解码生成观测。两轮独立复审发现的 13 个问题（路径逃逸、全 skip 假绿、来源误标、unsafe number、金额别名优先级等）全部修复；非假绿变异验证 2 个用例变红。不发付款、不结算、不读链，无 live 证据。 | 本次新增，待 commit |

## 3. 测试结果

执行环境：Node `v22.22.2`，npm `10.9.7`，Windows（MINGW64_NT-10.0-26200，Git Bash）。

```text
$ npm run check
> kite-x402-conformance@0.2.0 check
> tsc --noEmit          （无输出 = 通过）
> vitest run

 RUN  v2.1.9
 ✓ test/wire.test.ts (8 tests)
 ✓ test/networks.test.ts (9 tests)
 ✓ test/c5-replay-idempotency.test.ts (31 tests)
 ✓ test/c4-settlement-order.test.ts (24 tests)
 ✓ test/c1-manifest.test.ts (29 tests)
 ✓ test/c2-challenge.test.ts (21 tests)
 ✓ test/eip712.test.ts (16 tests)
 ✓ test/c3-authorization.test.ts (46 tests)
 ✓ test/settlement-order-runner.test.ts (18 tests)
 ✓ test/replay-runner.test.ts (20 tests)
 ✓ test/manifest-runner.test.ts (28 tests)

 Test Files  11 passed (11)
      Tests  250 passed (250)

> tsc -p tsconfig.build.json
exit=0

上表为含 C1 判定层、C1 清单解析 + HTTP 探针 runner、C4 与 C5 sandbox runner 增量的当前基线。`0.2.0` 定稿时的输出是 5 文件 / 100 用例；三者不要混用。
```

## 4. 运行演示

以下三条都在本机实测，`--silent` 不能省：否则 npm 会把脚本横幅写进 `sig.txt`，`authorize` 会把它当成畸形头。

```bash
# 终端 1
npm run example                      # 合成卖家 :8080

# 终端 2
node dist/cli.js check http://localhost:8080/v1/echo \
  --expected-pay-to 0x1234567890123456789012345678901234567890
# 10 passed, 0 failed, 0 skipped，exit=0
```

```bash
# 坏样本：402 但没有 PAYMENT-REQUIRED
DEMO_MODE=broken PORT=8081 npm run example
node dist/cli.js check http://localhost:8081/v1/echo
# 1 passed, 1 failed, 1 skipped，exit=1
```

```bash
npm run example:pay --silent > sig.txt
node dist/cli.js authorize http://localhost:8080/v1/echo --payment-signature @sig.txt
# 14 passed, 0 failed, 0 skipped，exit=0
```

```bash
node dist/cli.js verify
# 12 passed, 0 failed, 0 skipped，exit=0（内置 sandbox，四个探针真实经过 HTTP）

node dist/cli.js verify --defect forged-claim
# 11 passed, 1 failed, 0 skipped，exit=1；c4.upstream-success.settled 失败
# 负对照：卖家自报合法收据，但 mock facilitator 没有 /settle 调用

node dist/cli.js verify-replay
# 13 passed, 0 failed, 0 skipped，exit=0（三场景各两次尝试，真实经过 HTTP）

node dist/cli.js verify-replay --defect idem-cached-rebill
# 10 passed, 3 failed, 0 skipped，exit=1；c5.idempotency.cached / no-rebill / no-forward 失败
# 负对照：自报缓存命中却仍结算并转发，sandbox.contradictions 保留原始冲突

# C1：本地清单 vs 真实 HTTP 402 挑战（合成卖家 :8080，清单格式见 docs/CLI.md）
node dist/cli.js verify-manifest --manifest manifest.json --base-url http://localhost:8080
# 12 passed, 0 failed, 0 skipped，exit=0
# 把清单里 amount 改成 "2000" 后：11 passed, 1 failed，exit=1
```

`docs/EVIDENCE.md` 只记录 dry-run 与 sandbox；当前**没有 live 记录**，因为工具不发送真实交易。

## 5. Open Dev Data 登记状态

| 阶段 | 状态 | 证据 |
|---|---|---|
| ① 登记 PR | **已提交（OPEN / MERGEABLE / `build` success）**，截至 `2026-11-23` 尚未合并 | https://github.com/electric-capital/open-dev-data/pull/3153 |
| ② 生态映射生效 | 未确认（依赖 ① 合并） | developerreport 侧截图或链接 |
| ③ Commit 抓取 | 未开始（依赖 ②） | 统计页面表现 |
| ④ 开发者归因 | 未确认（依赖 ②） | 归属页面 |

> ① 的 PR 创建于 `2026-11-17`，分别在 `2026-11-20` 与 `2026-11-23` 复查：仍为 OPEN / MERGEABLE / `build` success，没有 review 或 comment。②–④ 尚未发生，不能提前写成「已生效」。

## 6. 技术关联证据（供核验）

| 关联点 | 证据位置 |
|---|---|
| Kite 网络常量（2366 / 2368、CAIP-2） | `src/networks.ts` + `x402conf networks` 输出 |
| 挑战网络字段校验 | `src/checks/c2-challenge.ts` 的 `c2.network` 断言 + 对应测试 |
| x402 v2 头编解码 | `src/wire.ts` + `test/wire.test.ts` |
| 收款地址 / 资产地址校验 | `src/checks/c2-challenge.ts` 的 `c2.asset`、`c2.pay-to`、`c2.pay-to-match` |
| Kite chainId 进入 EIP-712 域 | `src/eip712.ts` 的 `eip712DomainSeparator` + `test/eip712.test.ts` 的固定黄金值 |
| EIP-3009 授权可恢复（离线 `ecrecover`） | `src/checks/c3-authorization.ts` 的 `c3.signature-recovery` + `test/c3-authorization.test.ts` |
| 签名规范性（v ∈ {27,28}、低 s） | `src/eip712.ts` 的 `parseSignature65` + `c3.signature-format` / `c3.signature-low-s` |
| 清单声明与实测挑战的链 / 收款方 / 资产 / 金额绑定一致性 | `src/checks/c1-manifest.ts` 的 `c1.network` / `c1.pay-to-match` / `c1.asset-match` / `c1.amount-match` + `test/c1-manifest.test.ts` |
| C1 清单解析与真实 HTTP 402 探针：`verify-manifest` 从独立清单逐路径发 `GET`，从真实响应解码观测 | `src/manifest.ts`、`src/probes/manifest.ts`、`src/cli.ts` + `test/manifest-runner.test.ts`（28 个，含两轮对抗复审回归与 CLI 契约） |
| 结算时序可执行验证：`/verify` → 上游 → `/settle` → 收据的探针编排 | `src/probes/settlement-order.ts` + `src/sandbox/` + `x402conf verify` + `test/settlement-order-runner.test.ts`（七种模式与 `forged-claim` 信任边界反证） |
| 重放与幂等可执行验证：三场景×两次尝试的探针编排与缓存自报反证 | `src/probes/replay.ts`、`src/sandbox/replay-seller.ts`、`src/sandbox/mock-services.ts`（`startMockCache`）+ `x402conf verify-replay` + `test/replay-runner.test.ts`（七种缺陷、场景隔离、两种自报反证、矛盾观测规范化） |
| 依赖 | `package.json`：`viem` 用于地址校验、EIP-712 编码与签名恢复，`zod` 用于载荷校验 |

## 7. 月度活跃台账（任务一另记）

本文件只记任务二。任务一的活跃天数按实际开发日期汇总，不拿 PR 合并日替代；两者不要混在同一张表里。

## 8. C1 / C4 / C5 判定层（0.2.0 之后的增量）

上表与 `0.2.0` 定稿时的测试输出（5 文件 / 100 用例）记录的是定稿状态。其后新增三个判定层：

| 增量 | 源码 | 断言 | 测试 | commit 状态 | 测试基线 |
|---|---|---|---|---|---|
| C4 结算时序 | `src/checks/c4-settlement-order.ts` | 12 | 24 | 已 commit `fcfce4d` | 100 → 124 |
| C5 重放与幂等 | `src/checks/c5-replay-idempotency.ts` | 13 | 31 | 已 commit `6f37c24` | 124 → 155 |
| C1 清单一致性 | `src/checks/c1-manifest.ts` | 12 | 29 | 已 commit `12be087` | 155 → 184 |
| C4 sandbox 探针执行层 + `verify` | `src/probes/settlement-order.ts`、`src/sandbox/` | 12（复用判定层） | 18 | 已 commit `1a61cfc` | 184 → 202 |
| C5 sandbox 探针执行层 + `verify-replay` | `src/probes/replay.ts`、`src/sandbox/replay-seller.ts`、`src/sandbox/mock-services.ts` | 13（复用判定层） | 20 | 本次新增（Unreleased） | 202 → 222 |
| C1 清单解析 + HTTP 探针 runner + `verify-manifest` | `src/manifest.ts`、`src/probes/manifest.ts` | 12（复用判定层） | 28 | 本次新增（Unreleased） | 222 → 250 |

六个增量都未发布为新的 npm 版本，也不计入 `0.2.0` 的定稿区间。

需要如实区分：C1 / C4 / C5 的判定逻辑都是纯函数，输入为调用方注入的可信观测或结构化清单。C4 / C5 的 `verify` / `verify-replay` 已能真实跑完各自探针，但观测来自仓库自建的 mock 日志与合成卖家；C5 的重新签名用本地标记模拟，不读链上 `authorizationState`。C1 的 `verify-manifest` 已能解析清单并对真实端点发 HTTP 探针，但来源独立性只靠 `--manifest` / 不同 origin 的 `/.well-known/x402` 标记，不验证清单签名；它不发付款、不结算、不读链。接真实 facilitator / 链上遥测的 runner 与 `--pay` 仍未实现，**没有** live 结算证据。它们不改变 `docs/EVIDENCE.md` 的「尚无 live 记录」结论。规格见 `docs/CHECKS.md`，边界见 `docs/LIMITATIONS.md`。

## 9. 提交前自查

- [x] `npm run check` 全绿，输出已附
- [x] commit 作者为本人账号（`git log --format='%an <%ae>'` 全部一致）
- [x] 无真实密钥、无私钥、无 `.env`、无构建产物、无 `node_modules` 被跟踪；公开 Hardhat 测试私钥仅用于可复现演示且零余额
- [x] `README.md`、「已知限制」、「证据台账」与实际实现一致
- [x] `CHANGELOG.md` 已记录本次版本
- [x] 演示命令可被他人原样复现（含 `--silent`）
