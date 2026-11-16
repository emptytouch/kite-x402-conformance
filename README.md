# kite-x402-conformance

对 Kite 链上的 x402 收费 API 做**黑盒一致性检查**的命令行工具。输入一个 URL，输出「这个服务是否按 x402 v2 的约定收费」。

当前版本 `0.1.0`，已实现 **C2：402 挑战结构**的完整检查链（含 30 个自动化测试与 CI），其余检查项按路线图推进。

```
$ x402conf check http://localhost:8080/v1/echo

PASS  c2.status   HTTP status is 402
PASS  c2.header   PAYMENT-REQUIRED header present
PASS  c2.network  network matches expected Kite chain
...
10 passed, 0 failed, 0 skipped
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

后续 C3（EIP-712 / EIP-3009 授权构造）、C4（`/verify` → 上游 → `/settle` 时序）、C5（重放与幂等）会继续把 facilitator 交互纳入检查，路径与验收方式见 [docs/CHECKS.md](docs/CHECKS.md)。

## 3. 功能清单

| 编号 | 检查项 | 状态 |
|---|---|---|
| C1 | 清单一致性（`service.yaml` / `.well-known/x402` 与实测挑战对比） | 未实现（路线图 W3） |
| **C2** | **402 挑战结构（10 条断言）** | **已实现** |
| C3 | 授权可构造（EIP-712 域 + EIP-3009 签名可恢复） | 未实现（W2） |
| C4 | 结算时序（无签名不转发、失败不结算、成功返收据） | 未实现（W2） |
| C5 | 重放与幂等（同签名不二次结算、幂等键命中缓存） | 未实现（W3） |

命令行能力：

| 命令 | 作用 |
|---|---|
| `x402conf check <url>` | 对单条端点执行 C2，输出人类可读报告或 `--json` |
| `x402conf networks` | 列出内置 Kite 网络与端点确证状态 |
| `x402conf decode <value>` | 解码 `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE` 头，便于排障 |

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
node dist/cli.js --version   # 0.1.0
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
| `KITE_RPC_URL` | 否 | 留空使用内置 testnet RPC；mainnet 端点未确证，需自行提供 |
| `KITE_FACILITATOR_URL` | 否 | 与 facilitator 相关的检查（C4 起）使用 |
| `KITE_ASSET_ADDRESS` | 否 | 结算资产地址，用于金额/资产一致性判断 |
| `KITE_EXPECTED_PAY_TO` | 否 | 设置后 `c2.pay-to-match` 会比较收款地址 |
| `KITE_PAYER_PRIVATE_KEY` | 否 | **预留字段**：`0.1.0` 中没有任何代码读取它，实盘模式（`--pay`）尚未实现 |

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

完整命令与参数见 [docs/CLI.md](docs/CLI.md)。

## 8. 已知限制

1. **只覆盖 C2**：签名可构造性（C3）、结算时序（C4）、重放与幂等（C5）尚未实现，报告不会对这三类给出结论。
2. **mainnet 端点未确证**：`src/networks.ts` 中 mainnet 的 RPC 与区块浏览器为 `null`，需通过配置提供；`verified: false` 会在报告里提示。
3. **字段名按别名容忍**：不同 SDK 版本对 `maxAmountRequired` / `amount`、`payTo` / `payToAddress` 命名不一致，检查器同时接受；缺失时判失败，不猜。
4. **不做资金操作**：默认模式只发一次 GET，不签名、不转账。

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
