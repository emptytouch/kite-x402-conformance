# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Planned

- C4：结算时序检查——无签名不转发、上游 4xx/5xx 不结算、成功返回收据（W2）
- C5：重放与幂等检查（W3）
- C1：与 `service.yaml` / `.well-known/x402` 的清单一致性比对（W3）
- `--pay` 实盘模式与 `docs/EVIDENCE.md` 首条 live 记录（W4）
- `doctor` 环境自检（W4）
- `--reporter=junit` 与退出码在 CI 模板中的示例（视需求）

## [0.2.0] - 2026-11-18

第二个可运行版本：补上「客户签出来的付款能不能结算」这一半判定。仍然不发交易、不连 RPC。当前定稿包含 100 个自动化测试；C3 与下方定稿前加固均落在 `85061d1`，未单独发布补丁版本。

### Added

- **C3 检查器**（`src/checks/c3-authorization.ts`）：14 条断言，覆盖挑战可用性、载荷结构、`accepted` 与报价绑定、收款方与金额绑定、地址合理性、EIP-712 域可推导性、有效期窗口、剩余可重放时间、签名长度与 `v` 规范性、低 s、以及 EIP-3009 签名可恢复性。每条断言都对应 `@x402/evm` 中 facilitator 的一个真实拒绝码，映射表见 `docs/CHECKS.md`
- **失败归因**：恢复失败时自动尝试 `version` ∈ {挑战值, "1", "2"} × `chainId` ∈ {挑战值, 2366, 2368} 的组合，直接报告「它其实是用 `version="2"` 签的」这类结论，而不是只给出一个不匹配的地址
- **`src/eip712.ts`**：显式实现 EIP-712 域分隔符、`TransferWithAuthorization` 结构散列、EIP-3009 摘要，以及不归一化的 65 字节签名解析（含 `v ∈ {27,28}` 与低 s 判定）
- **`authorize` 命令**：`--payment-signature <value|@path>`、`--challenge <path>`（离线模式）、`--now`（按指定时刻评估窗口）、`--min-validity`、`--max-window`
- **`examples/mock-payer.ts`**：对示例卖家的挑战真实签名并输出 `PAYMENT-SIGNATURE`，用于端到端演示（公开测试私钥，不连链）
- **`src/checks/parse.ts`**：C2 与 C3 共用的字段别名读取，替代两份各自维护的实现
- **`chainIdFromNetworkField`**：把 `eip155:2368` / `2368` / `"2368"` 统一转成数字 chainId 的唯一入口
- 测试从 30 个增至 100 个（C3 新增 39 个、EIP-712 16 个、定稿前对抗性审查追加 15 个）

### Changed

- `authorize` 的载荷结构按 SDK 实际的 v2 schema 校验：`{ x402Version, accepted, payload: { authorization, signature } }`。`accepted` 缺失判 critical —— v2 schema 要求它存在，且 facilitator 会解引用 `payload.accepted.network`
- 有效期判定对齐参考实现：`validBefore >= now + 6`，而不是 `> now`
- `c3.window-span` 统计的是「从当前时刻起还剩多少可重放时间」（`validBefore - now`），不是 `validBefore - validAfter`。参考客户端固定发 `validAfter: "0"`，用差值会得到约 1.7e9 秒，没有任何判别力
- JSON 输出字段：`url` → `target`，并新增 `command`。两个命令共用同一份结构
- `examples/mock-seller.ts` 改为真实 v2 形状（`resource` 在顶层，`amount` / `maxTimeoutSeconds` / `extra` 在选项内），`extra.name` 改成 `"Demo USD"` 以免被误认为真实代币的域
- 配置口径：`KITE_FACILITATOR_URL` 和 `KITE_ASSET_ADDRESS` 如实标注为 C4 预留；`KITE_RPC_URL` 在 `networks` 命令里显示为当前网络的 rpc 覆盖值，本版本不发起链上调用

### 定稿前对抗性审查

以下问题均在 `0.2.0` 定稿前用构造输入**实测复现**并修复，不是静态猜测；修复已包含在 `85061d1` 与 `0.2.0` 中。

#### Security

- **ERC-6492 fail-open**：一个 65 字节垃圾签名，只要末尾 32 字节等于 ERC-6492 magic，就会让 `c3.signature-format` / `c3.signature-low-s` / `c3.signature-recovery` 三条断言全部 `skip`，`0 failed`、退出码 `0`。现在除 magic 尾缀外还要求 `parseErc6492Signature` 能解出非零 factory 与非空 calldata；伪造签名落回 `parseSignature65` 并判 critical 失败。
- **`authorize` 缺少链绑定**：挑战是 `eip155:2366`、`--network testnet` 时，`c3.domain-config` 仍可用挑战自述的 chainId 组域并让恢复通过，报告却写着 `eip155:2368`。现在 domain 必须同时匹配 `--network`，否则 critical 失败且不跑恢复。

#### Fixed

- **金额被静默取整**：`amount: 9007199254740993`（JSON 数字）在 `JSON.parse` 后变成 `9007199254740992`，C2 曾报 `pass` 并输出错误金额。`Number.isSafeInteger` 守门，超限字段改为明确失败并要求十进制字符串；chainId 与 `maxTimeoutSeconds` 同样处理。
- **多选项误判**：客户端合法选择 `accepts[1]` 时，C3 拿它与 `accepts[0]` 比对并判 critical 失败。现在按 `payload.accepted` 选出匹配选项；与所有选项都不匹配时判「过期或外来报价」。
- **自转付款误判**：`from === to` 被判 critical，但 facilitator 并不拒绝这种付款，违反「不发明规则」原则。降为 warning，并明确标注为工程建议；零地址仍为 critical。
- **库入口参数**：`checkAuthorization` 对非法 `expectedNetwork` / `NaN` / 负数现在在入口抛 `TypeError`，而不是在断言中途崩溃。
- 独立审查追加修复（均由构造输入复现）：

  - `c2.asset` 在选项缺少 `asset` 时只报 `skip warning`，退出码仍可为 0；缺资产意味着客户端无法构造 `verifyingContract`，改为 critical fail
  - `c3.accepted-binding` 在挑战与载荷两侧都没有 `network` 时，`null === null` 被当成一致而判 pass；现在两侧任一为空即记差异
  - `network: ""` 会经 `??` 遮住后面有效的 `chainId` 别名，导致合法链被判错；新增 `pickRaw` 跳过空字符串
  - `expectedNetwork` 用 `in` 判断，`"toString"` / `"constructor"` 等 `Object.prototype` 继承键能通过校验并让后续比较失真；改为 `Object.hasOwn`，并在 `matchNetwork`、`checkChallenge`、`checkAuthorization` 与 CLI 四处统一拦截

- 测试 85 → 100（新增 15 个回归用例；最终 `0.2.0` 为 100）

### Notes

- C3 的「通过」只证明载荷与挑战自洽。`nonce` 是否已用、余额是否够、代币是否支持 EIP-3009、挑战的 `name`/`version` 是否与链上一致，都需要 RPC，属 C4/C5 范围
- 对 ERC-6492 包裹签名（智能合约钱包）判 `skip` 而不是 `pass`：恢复内层签名需要账户实现，本版本不建模

## [0.1.0] - 2026-11-16

首个可运行版本。范围刻意收窄到「一条 URL 的 402 挑战是否合规」，先把判定链路做扎实。

### Added

- **C2 检查器**：402 挑战结构 10 条断言（状态码、头存在、可解码、v2、exact、网络、资产、收款地址、金额、收款方一致性）
- **CLI**：`check`（人类可读 / `--json`）、`networks`、`decode`
- **配置层**：环境变量 zod 校验，地址格式与私钥格式非法时启动即失败；所有配置项均可选
- **网络常量**：Kite mainnet 2366 / testnet 2368，CAIP-2 归一化；未确证端点保留为 `null` 并标记 `verified=false`
- **通信层**：`PAYMENT-REQUIRED` 头的 base64 / base64url / 百分号编码 / 裸 JSON 解码，畸形输入 fail-closed
- **退出码契约**：0 通过 / 1 critical 失败 / 2 warning 失败 / 3 运行时错误
- **示例卖家** `examples/mock-seller.ts`：正常与坏样本两种模式，用于本地演示，不含真实资金
- **测试**：3 个文件 30 个用例（C2 17、wire 8、networks 5）
- **CI**：`npm ci → typecheck → test → build → CLI smoke`
- **文档**：README、ARCHITECTURE、CLI、CHECKS、TESTING、LIMITATIONS、EVIDENCE、SUBMISSION、CONTRIBUTING

### Known limitations

- C1、C3、C4、C5 未实现，报告不对其给出结论
- 无 live 模式：私钥配置项已预留，但 `0.1.0` 中没有任何代码读取它
- mainnet 的 RPC 与区块浏览器地址未确证，需通过配置提供
- 输出仅到 stdout，尚不支持写入文件或 JUnit
