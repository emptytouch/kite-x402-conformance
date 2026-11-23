# 提交材料

四阶段状态**必须分开写**——登记 PR 合并、生态映射生效、commit 被抓取、开发者归因是四件不同的事。

## 1. 基本信息

| 项 | 内容 |
|---|---|
| 仓库链接 | `https://github.com/emptytouch/kite-x402-conformance` |
| 许可证 | Apache-2.0 |
| 当前版本 | `0.2.0`（`85061d1`）；其后的 C4 / C5 / C1 增量为 Unreleased，见 `CHANGELOG.md` |
| 仓库创建 / 首次公开日期 | `2026-11-16`（GitHub created_at `2026-11-16T14:52:24Z`；首个 commit `a2e067b` 同日） |
| 本期 authored commit | `a2e067b`、`85061d1`、`1a270e5`、`fcfce4d`、`6f37c24`；C1 增量见 Unreleased |

已提交的五个 commit（按时间正序）：

```text
a2e067b feat: initial C2 conformance checker with CLI, tests and docs
85061d1 feat: add C3 authorization conformance checks and harden validation
1a270e5 docs: finalize submission record and version history
fcfce4d feat: add C4 settlement order verdict layer
6f37c24 feat: add C5 replay and idempotency verdict layer
```

## 2. 本期变更

| 变更 | 说明 | 关联 commit |
|---|---|---|
| C2：402 挑战结构检查 | 把「返回了 402」与「按 x402 v2 写对挑战」分开判定；实现 10 条断言、CLI `check` / `networks` / `decode`、头的多种编码解码、Kite 2366/2368 网络常量、配置校验与 30 个测试。原因是模板服务普遍有 402，但结构错误仍会导致客户端无法付款。 | `a2e067b` |
| C3：授权可构造检查 | 把「挑战写对了」与「客户签出的付款能自洽结算」分开判定；实现 14 条断言、手写 EIP-712/EIP-3009 编码、`authorize` 命令、离线抓包重放、公开测试私钥签名示例与失败归因。原因是金额/链/域绑错在真机上表现为收不到钱，但只靠 402 结构看不出来。 | `85061d1` |
| 对抗性审查加固 | 对构造输入实测复现并修复 ERC-6492 fail-open、JSON number 被 `JSON.parse` 改写、多选项报价误判、网络绑定缺失、`Object.prototype` 继承键绕过、`network: ""` 遮住 chainId、缺 `asset` 只 skip 等；测试从 85 增至 100。原因是 C3 的「通过」若建立在这些漏洞上会给出虚假信心。 | `85061d1` |

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

 Test Files  8 passed (8)
      Tests  184 passed (184)

> tsc -p tsconfig.build.json
exit=0

上表为含 C1 增量的当前基线。`0.2.0` 定稿时的输出是 5 文件 / 100 用例；两者不要混用。
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

`docs/EVIDENCE.md` 只记录 dry-run；当前**没有 live 记录**，因为工具不发送真实交易。

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
| 依赖 | `package.json`：`viem` 用于地址校验、EIP-712 编码与签名恢复，`zod` 用于载荷校验 |

## 7. 月度活跃台账（任务一另记）

本文件只记任务二。任务一的活跃天数按实际开发日期汇总，不拿 PR 合并日替代；两者不要混在同一张表里。

## 8. C1 / C4 / C5 判定层（0.2.0 之后的增量）

上表与 `0.2.0` 定稿时的测试输出（5 文件 / 100 用例）记录的是定稿状态。其后新增三个判定层：

| 增量 | 源码 | 断言 | 测试 | commit 状态 | 测试基线 |
|---|---|---|---|---|---|
| C4 结算时序 | `src/checks/c4-settlement-order.ts` | 12 | 24 | 已 commit `fcfce4d` | 100 → 124 |
| C5 重放与幂等 | `src/checks/c5-replay-idempotency.ts` | 13 | 31 | 已 commit `6f37c24` | 124 → 155 |
| C1 清单一致性 | `src/checks/c1-manifest.ts` | 12 | 29 | 本次新增（Unreleased） | 155 → 184 |

三者都未发布为新的 npm 版本，也不计入 `0.2.0` 的定稿区间。

需要如实区分：C1 / C4 / C5 都是纯判定函数，输入为调用方注入的可信观测或结构化清单；清单解析、探针执行层与 CLI 子命令均未实现，**没有** live 结算证据。它们不改变 `docs/EVIDENCE.md` 的「尚无 live 记录」结论。规格见 `docs/CHECKS.md`，边界见 `docs/LIMITATIONS.md`。

## 9. 提交前自查

- [x] `npm run check` 全绿，输出已附
- [x] commit 作者为本人账号（`git log --format='%an <%ae>'` 全部一致）
- [x] 无真实密钥、无私钥、无 `.env`、无构建产物、无 `node_modules` 被跟踪；公开 Hardhat 测试私钥仅用于可复现演示且零余额
- [x] `README.md`、「已知限制」、「证据台账」与实际实现一致
- [x] `CHANGELOG.md` 已记录本次版本
- [x] 演示命令可被他人原样复现（含 `--silent`）
