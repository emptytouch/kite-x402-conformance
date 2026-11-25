# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **C5 探针执行层**（`src/probes/replay.ts` + `src/sandbox/replay-seller.ts` + `src/sandbox/mock-services.ts`）：`x402conf verify-replay` 启动独立 mock upstream / facilitator / **cache** 与有状态的合成 seller，按 `nonceReplay` / `idempotencyKey` / `nonceReuse` 三场景各发两次真实 HTTP 请求。`settled` / `upstreamCalled` / `cacheHit` 只从三个 mock 的请求日志生成；seller 自报的 `x-c5-cache-claim` 只作证据，不参与判定
- **矛盾观测的显式规范化**：判定层拒绝 `cacheHit && (settled || upstreamCalled)` 作为输入。runner 遇到「缓存命中但仍结算/转发」时保留原始冲突到 `sandbox.contradictions`，把观测规范化为 `cacheHit: false`，让 `cached` / `no-rebill` / `no-forward` 照常失败，而不是整组场景被判非法后全部 skip
- **七种可注入重放缺陷**：`nonce-rebill`、`idem-no-cache`、`idem-cached-rebill`、`nonce-reuse-bypass`、`bad-receipt`、`forged-claim`、`first-not-settled`（另有良性 `none`）。三场景在 seller 内各自隔离重放状态，调换顺序不影响判定；`idem-no-cache` 自报命中却从不查缓存，`idem-cached-rebill` 命中仍结算，`forged-claim` 给出合法-looking 收据却零 `/settle`，`first-not-settled` 既不结算也不给收据
- **CLI `verify-replay` 子命令**：`--defect` / `--timeout` / `--json`，退出码沿用 0/1/2/3 契约；位置参数明确拒绝，避免与 C4 相同的 Commander 静默降级
- **C4 探针执行层**（`src/probes/settlement-order.ts` + `src/sandbox/`）：`x402conf verify` 启动独立的 mock upstream、mock facilitator 与内置合成 seller，顺序执行四个探针；`upstreamCalled` / `settled` 只从两个 mock 的请求日志生成，seller 自报的 `PAYMENT-RESPONSE` 只进入收据校验。JSON 报告附 `sandbox.captures` 原始日志与 `sandbox.observations`，可独立复核观测来源
- **六种可注入缺陷**：`--defect free-access | forged-signature | charge-on-error | skip-settlement | bad-receipt | forged-claim`。每种只改一处时序决策，测试断言各自必须失败的 `c4.*` 断言，证明检查器不是空跑。`forged-claim` 是信任边界反证：合法-looking 收据 + 零 `/settle` 调用，`receipt` 通过而 `settled` 失败
- **CLI `verify` 子命令**：`--defect` / `--timeout` / `--json`，退出码沿用 0/1/2/3 契约；位置参数被明确拒绝（Commander 默认会静默丢弃，实测 `verify free-access` 曾退化成 `none` 并给出全绿，已加回归测试）
- 测试从 184 个增至 202 个（`test/settlement-order-runner.test.ts` 新增 18 个：七种模式、mock 日志归属、信任边界对照、参数 fail-closed、四个 CLI 契约用例）；C5 runner 再增至 222 个（`test/replay-runner.test.ts` 新增 20 个：八种模式、场景顺序隔离、缓存自报反证、矛盾规范化、mock 日志归属、参数 fail-closed、四个 CLI 契约用例）
- **C4 判定层**（`src/checks/c4-settlement-order.ts`）：`checkSettlementOrder({ observations })`，12 条 `c4.*` 断言，按四个探针观测判定结算时序——无签名返回 402 且不转发不结算、错误签名返回 402 且不转发不结算、上游 4xx/5xx 不结算、上游 2xx 必须结算并返回 200 与含合法 tx hash 的 `PAYMENT-RESPONSE`。每条断言对应一个真实亏损场景，映射见 `docs/CHECKS.md`
- **收据校验**：`PAYMENT-RESPONSE` 经 `decodeHeaderValue` 解码，接受顶层或 `receipt` / `settlement` 嵌套下的 `txHash` / `transactionHash` / `tx` / `hash`，要求 `/^0x[0-9a-fA-F]{64}$/`；空对象、占位字符串、格式错误一律 critical 失败，不 skip
- **fail-closed 输入校验**：探针缺失、重复、字段类型非法（含 `settled: "false"` 字符串、越界状态码）→ `c4.probes` 失败，其余 11 条全部 skip；上游失败探针未触达上游时 `no-settle` skip（不是 pass）；无签名/错误签名探针即使被转发，其 `no-settle` 仍照常判定
- 测试从 100 个增至 124 个（`test/c4-settlement-order.test.ts` 新增 24 个：正例 1、时序与收据反例 13、skip 与输入边界 10）
- 定稿前对抗性审查（均由构造输入实测复现并加回归测试）：

  - `upstreamError` 探针返回 2xx/3xx 时曾把 `no-settle` 判为 pass（失败场景根本没构造出来，绿色结论是空洞的），现要求 4xx/5xx 前置
  - 非字符串 `PAYMENT-RESPONSE` 头值会让 `raw.trim()` 抛异常而非给出结论，现改为输入校验失败
  - 矛盾观测曾给出绿灯：`settled:false, settlementStatus:200`（声称没结算却有扣款状态）、`settled:true, settlementStatus:500`（结算失败却声称成功）、`upstreamCalled:false, upstreamStatus:200`（声称没转发却拿到上游状态）。现 `c4.probes` 校验布尔量与配套状态码的一致性，矛盾输入整体失败
  - 收据别名容忍与 parse.ts 对齐：空串跳过、只读自有属性（防原型污染）、`receipt` / `settlement` 两个包装独立解析；非空但格式错误的 hash 仍是明确失败，不被后续别名掩盖
  - 上游返回 2xx/3xx 时的 skip 原因文本原写「upstream was never called」，与事实相反，现报告实际 called/status

### 边界说明

此处描述的是最初的判定层。后续已补上 sandbox runner，`x402conf verify` 可以端到端跑通四探针；但**只测内置合成卖家**，不连真实 facilitator、不发真实交易、不产生 live 证据。把服务端自报头部当观测仍会使结论可被伪造，runner 用独立 mock 日志规避这一点。见 `docs/LIMITATIONS.md` 与 `docs/ARCHITECTURE.md`。

- **C5 判定层**（`src/checks/c5-replay-idempotency.ts`）：`checkReplayIdempotency({ scenarios })`，13 条 `c5.*` 断言，按三场景的两尝试观测判定重复扣款——同签名换键重放、同键重试、同 nonce 重新签名。三个场景各有 `first-settled` 前置：首次没结算时「未二次扣款」是空洞的，不能算通过
- **C5 fail-closed 输入校验**：`settled` / `upstreamCalled` / `cacheHit` 与配套状态码必须自洽；`cacheHit` 同时 `settled` 或转发上游的观测判为输入矛盾（不是 verdict）；必需字段只读自有属性，防止原型污染供给扣款判定；两个合法可为 `undefined` 的状态字段允许键缺失，使观测经 JSON 往返后仍有效
- 测试从 124 个增至 155 个（`test/c5-replay-idempotency.test.ts` 新增 31 个）

### 边界说明

C5 现已补上 sandbox runner 与 `verify-replay` 子命令，三场景的 `settled` / `cacheHit` / `upstreamCalled` 观测来自独立 mock 日志。但被测对象仍是内置合成卖家：重新签名用本地标记模拟，不读链上 `authorizationState`，不连真实服务，不产生 live 证据。链上核验仍属未来 live runner。见 `docs/LIMITATIONS.md`。

- **C1 判定层**（`src/checks/c1-manifest.ts`）：`checkManifestConsistency({ source, manifest, observed })`，12 条 `c1.*` 断言，比较清单声明与实测 402 挑战的路径覆盖、网络、收款方、资产与原子单位金额。`source` 为 `challenge-echo`（清单由挑战反推）明确失败，`unknown` 只能 skip——清单与实测同源时比对是同义反复，不能算通过
- **C1 输入安全**：所有字段只读一次并快照为普通对象；原型继承字段拒绝；访问器换值不能制造空洞通过；抛出的值（包括自身字符串化也抛的值）转为 `c1.input=fail` + 其余 skip，不向调用方抛异常
- 测试从 155 个增至 184 个（`test/c1-manifest.test.ts` 新增 29 个）
- 规格见 `docs/CHECKS.md`；三轮独立对抗复审后无真实剩余缺陷

### 边界说明

C1 不解析 `service.yaml` / `.well-known/x402` 原始文本，不验证清单来源真实性或签名，不发请求。清单解析与观测采集由未来的 runner 提供，本版本无 CLI 子命令、无 live 证据。

### Planned

- C1 清单解析与 CLI 子命令；把 C4 / C5 runner 从内置 sandbox 扩展到真实服务（需要等价遥测）；链上 `authorizationState` 核验
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
