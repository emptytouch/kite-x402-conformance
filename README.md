# kite-x402-conformance

对 Kite 链上的 x402 收费 API 做**黑盒一致性检查**的命令行工具。输入一个 URL，输出「这个服务是否按 x402 v2 的约定收费」。

当前版本 `0.2.0`，已实现 **C1：清单一致性判定层**（12 条断言）、**C2：402 挑战结构**（10 条断言）、**C3：授权可构造**（14 条断言）、**C4：结算时序**（12 条断言 + sandbox 探针执行层）与 **C5：重放与幂等**（13 条断言 + sandbox 探针执行层），共 222 个自动化测试与 CI。C4 的 `verify` 与 C5 的 `verify-replay` 用独立 mock 日志产生观测、可端到端跑通；但它们只测内置合成卖家，**不是真实结算证据**。C1 仍是纯判定函数，无 CLI 子命令；全项目无 live 证据。

```
$ x402conf check http://localhost:8080/v1/echo

PASS  c2.status   HTTP status is 402
PASS  c2.header   PAYMENT-REQUIRED header present
PASS  c2.network  network matches expected Kite chain
...
10 passed, 0 failed, 0 skipped
```

```
$ x402conf authorize http://localhost:8080/v1/echo --payment-signature @sig.txt

PASS  c3.domain-config        EIP-712 domain is derivable from the challenge
PASS  c3.signature-recovery   signature recovers to the authorising payer
...
14 passed, 0 failed, 0 skipped
```

C2 只回答「卖家收费要求写对了吗」。C3 回答另一半——「客户按这个要求签出来的付款，能不能真的结算」，并且失败时给出归因：

```
FAIL  c3.signature-recovery   signature recovers to the authorising payer
      signature recovers to 0x3f1c…, not to 0x7099…. It does recover under
      version="2" chainId=2368 — the payload was signed against a different
      EIP-712 domain than the challenge advertises
```

---

## 1. 项目用途

x402 的卖家侧模板（Express / Go / Hono / Axum）都会返回 `402` 与 `PAYMENT-REQUIRED` 头，但**「返回了 402」不等于「按协议收费」**。工程里已经出现过这些真实情况：

| 现象 | 出处 |
|---|---|
| 模板作者自己记录「从未对真实 testnet facilitator + 真实 kpass 跑过」 | `tianzeshi-study/kite-x402-axum` 的 `TODO.md` |
| 全部支付测试基于 mock facilitator，无真实结算证据 | `BrKDDD/kite-x402-hono` 的 `tests/helpers.ts` 与 CONTRIBUTING |
| 目录里的服务多为 draft，条目本身不是可支付目的地 | `CarryWang/kite-x402-explorer` README |

`kite-x402-conformance` 的定位是**判定**，不是**展示**：它不维护服务目录、不做协议演示，只回答「这一条 URL 的 402 载荷是否结构正确、网络是否正确、收款地址与金额是否合法」。目录与演播厅由 explorer 负责，两者不重叠。

## 2. 与 KiteAI 的关系

关联全部落在可执行代码与可复现命令上，不靠名称。

| KiteAI 关联点 | 源码位置 | 配置项 | 复现命令 |
|---|---|---|---|
| Kite 两条网络的 chainId 2366 / 2368 与 CAIP-2 标识 | `src/networks.ts` | — | `x402conf networks` |
| 挑战载荷中的 `network` 必须指向 Kite 链 | `src/checks/c2-challenge.ts`（`matchNetwork`） | `--network` / `KITE_NETWORK` | `x402conf check <url> --network testnet` |
| x402 v2 的 `PAYMENT-REQUIRED` 头（base64 JSON） | `src/wire.ts` | — | `x402conf decode <header>` |
| Kite 结算资产的地址合法性 | `src/checks/c2-challenge.ts`（`isAddress`） | `KITE_ASSET_ADDRESS` | 同上 |
| 收款钱包与配置一致 | `src/checks/c2-challenge.ts`（`c2.pay-to-match`） | `KITE_EXPECTED_PAY_TO` / `--expected-pay-to` | 同上 |
| 协议能力自检（未确证端点不硬编码） | `src/networks.ts`（`verified` 字段） | `KITE_RPC_URL` | `x402conf networks` |
| EIP-712 域构造（`name` / `version` / `chainId` / `verifyingContract`）与域分隔符 | `src/eip712.ts` | — | `test/eip712.test.ts`（与 viem 逐字节比对 + 固定黄金值） |
| EIP-3009 `TransferWithAuthorization` 的字段序与类型散列 | `src/eip712.ts` | — | 同上 |
| 签名可恢复性（`ecrecover` 结果须等于 `authorization.from`） | `src/checks/c3-authorization.ts` | — | `x402conf authorize <url> --payment-signature @sig.txt` |
| 签名规范性（`v ∈ {27,28}`、低 s） | `src/eip712.ts` + `c3.signature-*` | — | 同上 |

C3 纳入 Kite 的方式不是「提到 Kite 这个词」，而是把 **Kite 两条链的 chainId 真正写进 EIP-712 域**，再用一次真实的 `ecrecover` 反证：签名里承诺的链、代币、金额与挑战里说的完全一致。`c3.signature-recovery` 失败时，检查器会报告「它其实是对着 2366 签的」或「用的是 `version="2"`」——这类错在真实集成里就是收不到钱。

C1 / C4 / C5 的判定逻辑都作为库函数提供（`checkManifestConsistency` / `checkSettlementOrder` / `checkReplayIdempotency`）。其中 C4 已补上探针执行层：`x402conf verify` 启动独立的 mock upstream 与 mock facilitator，从它们的请求日志生成 `upstreamCalled` / `settled` 观测，而不是采信被测服务自己写的响应头。C1 的清单解析与 C5 的三次重复请求编排仍未实现，因此没有对应 CLI 子命令。路径与验收方式见 [docs/CHECKS.md](docs/CHECKS.md)。

## 3. 功能清单

| 编号 | 检查项 | 状态 |
|---|---|---|
| C1 | 清单一致性（`service.yaml` / `.well-known/x402` 与实测挑战对比） | 判定层已实现（`checkManifestConsistency`，12 断言）；清单解析与探针执行未实现 |
| **C2** | **402 挑战结构（10 条断言）** | **已实现** |
| **C3** | **授权可构造（EIP-712 域 + EIP-3009 签名可恢复，14 条断言）** | **已实现** |
| C4 | 结算时序（无签名不转发、失败不结算、成功返收据） | 判定层 + sandbox 探针执行层已实现（`x402conf verify`，12 断言）；仅测内置合成卖家，无 live |
| C5 | 重放与幂等（同签名 / 同键 / 换键绕过均不二次扣款） | 判定层 + sandbox 探针执行层已实现（`x402conf verify-replay`，13 断言）；仅测内置合成卖家，无 live |

命令行能力：

| 命令 | 作用 |
|---|---|
| `x402conf check <url>` | 对单条端点执行 C2，输出人类可读报告或 `--json` |
| `x402conf authorize [url]` | 对一份 `PAYMENT-SIGNATURE` 执行 C3；可在线取挑战，也可 `--challenge <path>` 全离线 |
| `x402conf verify` | 对内置 sandbox 执行 C4 四探针；`--defect` 可注入 6 种缺陷做反证 |
| `x402conf verify-replay` | 对内置 sandbox 执行 C5 三场景各两次尝试；`--defect` 可注入 7 种重放/幂等缺陷做反证 |
| `x402conf networks` | 列出内置 Kite 网络与端点确证状态 |
| `x402conf decode <value>` | 解码 `PAYMENT-*` 头，便于排障 |

明确不做（Non-goals）：不实现 facilitator，不托管资金，不做 Web UI，不替代安全审计，不在 CI 中发送真实交易。

## 4. 环境要求

- Node.js **>= 22**（使用内置 `fetch` 与 `AbortSignal.timeout`）
- npm 10+
- 无需数据库、无需 Docker、无需链上账户即可完成全部默认检查

## 5. 安装与启动

```bash
git clone <你的仓库地址>/kite-x402-conformance.git
cd kite-x402-conformance
npm ci
npm run build
node dist/cli.js --version   # 0.2.0
```

无需构建直接运行（开发态）：

```bash
npx tsx src/cli.ts check http://localhost:8080/v1/echo
```

## 6. 配置示例

全部配置可选，默认值即可跑 dry-run。复制 `.env.example` 为 `.env` 后按需填写：

| 变量 | 必填 | 说明 |
|---|---|---|
| `KITE_NETWORK` | 否 | `testnet`（默认）或 `mainnet` |
| `KITE_RPC_URL` | 否 | `networks` 命令会把它显示为当前网络的 rpc 覆盖值；本版本**不**发起链上调用 |
| `KITE_FACILITATOR_URL` | 否 | **预留**：本版本没有任何断言读取它，C4 才会用到 |
| `KITE_ASSET_ADDRESS` | 否 | **预留**：本版本不参与资产一致性判断；C2 只校验挑战里的地址格式，C3 的 `verifyingContract` 取自挑战 |
| `KITE_EXPECTED_PAY_TO` | 否 | 设置后 `c2.pay-to-match` 会比较收款地址 |
| `KITE_PAYER_PRIVATE_KEY` | 否 | **预留字段**：`0.2.0` 中没有任何代码读取它，实盘模式（`--pay`）尚未实现 |

`.env` 已在 `.gitignore` 中；仓库只提交 `.env.example`，不含任何真实密钥。

## 7. 使用示例

**示例 A：对本地示例卖家做一次完整体检**

```bash
npm run example                                  # 终端 1：起一个合成卖家（:8080）
node dist/cli.js check http://localhost:8080/v1/echo \
  --expected-pay-to 0x1234567890123456789012345678901234567890
```

实测输出（10 条断言全过，退出码 0）：

```
PASS  c2.status  HTTP status is 402
PASS  c2.header  PAYMENT-REQUIRED header present
PASS  c2.decode  header decodes to JSON
PASS  c2.version x402 version is 2
PASS  c2.scheme  scheme is exact
PASS  c2.network network matches expected Kite chain
PASS  c2.asset   asset address is valid
PASS  c2.pay-to  payTo is a valid address
PASS  c2.amount  amount is positive atomic integer
PASS  c2.pay-to-match payTo matches the configured receiver
10 passed, 0 failed, 0 skipped
```

**示例 B：对方返回 402 但没有 `PAYMENT-REQUIRED` 头**

```bash
DEMO_MODE=broken npm run example                 # 终端 1：坏样本（:8080）
node dist/cli.js check http://localhost:8080/v1/echo
```

```
FAIL  c2.header  PAYMENT-REQUIRED header present
      no PAYMENT-REQUIRED header on the 402 response
SKIP  c2.decode  header decodes to JSON
1 passed, 1 failed, 1 skipped
```

退出码 `1`（critical 失败）。注意 `SKIP` 明确不是通过。

**示例 C：CI 用的机器可读输出**

```bash
node dist/cli.js check https://api.example.com/v1/data --json > report.json
```

**示例 D：手工排查一个头的载荷**

```bash
node dist/cli.js decode "$PAYMENT_REQUIRED_HEADER"
```

**示例 E：端到端验一份付款载荷（C3）**

```bash
npm run example                                  # 终端 1：合成卖家（:8080）
npm run example:pay --silent > sig.txt           # 终端 2：--silent 避免 npm 横幅写进签名文件
node dist/cli.js authorize http://localhost:8080/v1/echo --payment-signature @sig.txt
```

```
14 passed, 0 failed, 0 skipped
```

`mock-payer.ts` 用 Hardhat 账户 #1 的公开测试私钥签名——它持有零余额，脚本不连任何链，只在本地算一次 EIP-712 签名。想看不通过的形态，把评估时刻推到载荷过期之后：

```bash
node dist/cli.js authorize http://localhost:8080/v1/echo --payment-signature @sig.txt --now 1800000000
# FAIL  c3.window  authorisation window is open at evaluation time
# 13 passed, 1 failed, 0 skipped   → 退出码 1
```

**示例 F：CI 里对一份抓包载荷重跑（完全不联网）**

```bash
node dist/cli.js authorize --challenge challenge.txt --payment-signature @sig.txt --now 1700000000 --json
```

**示例 G：C4 结算时序的可复现端到端验证（仅 sandbox）**

```bash
node dist/cli.js verify --json
# 12 passed, 0 failed, 0 skipped，exit=0

node dist/cli.js verify --defect forged-claim --json
# 11 passed, 1 failed, 0 skipped，exit=1
# FAIL c4.upstream-success.settled：卖家返回了收据，mock facilitator 却没有收到 /settle
```

`--json` 中带 `sandbox.captures`（两个 mock 的原始请求日志），可以独立复核每条观测来自哪里。这里是本地合成服务，没有真实链上交易；详见 [docs/CLI.md](docs/CLI.md)。

**示例 H：C5 重放与幂等的可复现端到端验证（仅 sandbox）**

```bash
node dist/cli.js verify-replay --json
# 13 passed, 0 failed, 0 skipped，exit=0

node dist/cli.js verify-replay --defect idem-cached-rebill --json
# 10 passed, 3 failed, 0 skipped，exit=1
# FAIL c5.idempotency.cached / no-rebill / no-forward
# sandbox.contradictions 记录「缓存命中但仍结算+转发」的原始冲突
```

`--json` 的 `sandbox` 除 `captures` 与 `observations` 外还有 `contradictions`：当缓存命中却仍发生副作用时，runner 保留原始冲突、把观测规范化成合法输入，让三条真正亏钱的断言照常失败，而不是让整组场景因输入矛盾被判非法后全部 skip。`idem-no-cache` 反证则显示 seller 响应里写着 `x-c5-cache-claim: hit`，runner 仍按独立缓存日志判为未命中。

完整命令与参数见 [docs/CLI.md](docs/CLI.md)。

## 8. 已知限制

1. **C4 / C5 的 CLI 只测内置 sandbox**：`verify` 与 `verify-replay` 从独立 mock 的请求日志采集观测，能真实发现结算时序与重放/幂等缺陷，但被测卖家是仓库自带的合成实现，没有接真实 facilitator、没有链上交易。C5 的「重新签名」用本地标记模拟**同 nonce 的另一份有效载荷**，不读链上 `authorizationState`。C3 的「通过」也只证明**载荷与挑战自洽**——它不证明链上该代币支持 EIP-3009、不证明付款人有余额、不证明 `nonce` 未被用过，这些都需要 RPC，属 live 模式范围。
2. **mainnet 端点未确证**：`src/networks.ts` 中 mainnet 的 RPC 与区块浏览器为 `null`，需通过配置提供；`verified: false` 会在报告里提示。
3. **字段名按别名容忍**：不同 SDK 版本对 `maxAmountRequired` / `amount`、`payTo` / `payToAddress` 命名不一致，检查器同时接受；缺失时判失败，不猜。
4. **不做资金操作**：`check` 只对目标发 GET，`authorize` 只做离线的 `ecrecover`；`verify` 与 `verify-replay` 只与本地 mock / 合成卖家通信，不连真实 facilitator、不广播交易。签名只出现在示例脚本里，且用的是公开测试私钥。
5. **智能合约钱包签名判 skip 不判 pass**：ERC-6492 包裹签名需要账户实现才能验证，本版本不建模，报告里会明确标成「未检查」。

完整清单见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## 9. 文档索引

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 目录结构、模块职责、关键流程、本地开发、扩展方式 |
| [docs/CLI.md](docs/CLI.md) | 命令、参数、输出、退出码、CI 集成 |
| [docs/CHECKS.md](docs/CHECKS.md) | 每个检查项的断言、级别与依据 |
| [docs/TESTING.md](docs/TESTING.md) | 测试命令、覆盖场景、构建与发布、排障 |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | 已知限制与未接通能力 |
| [docs/EVIDENCE.md](docs/EVIDENCE.md) | 真实 testnet 运行证据台账（如有） |
| [docs/SUBMISSION.md](docs/SUBMISSION.md) | 提交材料与登记状态模板 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献流程与提交前检查 |
| [CHANGELOG.md](CHANGELOG.md) | 版本记录 |

## 10. 许可

Apache-2.0，见 [LICENSE](LICENSE)。

本仓库为原创实现，从空仓库初始化，未 fork 任何仓库。工程实践（如 `/healthz` 与 `/readyz` 语义分离、结算成功后再返回、目录快照与退避）参考了同期 Kite x402 模板的公开文档与代码组织方式，**未复制其中任何代码**；`CarryWang/kite-x402-explorer` 与 `gokite-ai/kite_counter_dapp` 无 LICENSE，其实现不作为可复用来源。详细来源说明见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。
