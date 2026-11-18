# 检查项规格

每个检查项都要写明：断言什么、依据什么、失败算多严重。这份文件是判定逻辑的唯一说明来源，代码与它不一致时以本文件为准并修代码。

## 总表

| 编号 | 检查项 | 断言数 | 状态 | 目标周 |
|---|---|---|---|---|
| C1 | 清单一致性（`service.yaml` / `.well-known/x402` vs 实测） | — | 未实现 | W3 |
| **C2** | **402 挑战结构** | **10** | **已实现** | W1 ✅ |
| **C3** | **授权可构造（EIP-712 域 + EIP-3009 可恢复签名）** | **14** | **已实现** | W2 ✅ |
| C4 | 结算时序（无签名不转发、上游失败不结算、成功返收据） | — | 未实现 | W2 |
| C5 | 重放与幂等 | — | 未实现 | W3 |

## C2 · 402 挑战结构

输入：响应状态码 + 响应头。输出：10 条断言。全部为纯函数，不发请求。

| 断言 id | 断言 | 级别 | 依据 |
|---|---|---|---|
| `c2.status` | 状态码为 `402` | critical | x402 用 402 表达「需付费」 |
| `c2.header` | 存在 `PAYMENT-REQUIRED` 头（大小写不敏感） | critical | x402 v2 的挑战载体 |
| `c2.decode` | 头值可解为 JSON（base64 / base64url / URL 编码 / 裸 JSON） | critical | 便于排查各实现的编码差异 |
| `c2.version` | `x402Version === 2` | critical | 本期以 v2 为基准 |
| `c2.scheme` | 支付选项 `scheme === "exact"` | critical | Kite 模板统一使用 exact |
| `c2.network` | `network` 归一化后等于期望的 CAIP-2（2366 / 2368） | critical | 收错链等于收不到钱 |
| `c2.asset` | 资产字段存在且地址通过 `isAddress` | critical | 缺资产时客户端连 `verifyingContract` 都构造不出来；地址拼错则转账失败 |
| `c2.pay-to` | 收款地址通过 `isAddress` | critical | 同上 |
| `c2.amount` | 金额为正整数（原子单位，不接受小数、负数、科学计数） | critical | 小数金额会被合约按整数截断 |
| `c2.pay-to-match` | 配置了期望收款地址时，实际值必须一致 | critical | 防止被替换收款方 |

### 字段别名

不同 SDK 版本命名不一致，检查器按下列别名读取；**全部缺失时判失败，不使用默认值**。`network` / `chainId` 这类可数值可字符串的字段用 `pickRaw` 读取，**空字符串会被跳过**，因此 `network: ""` 不会遮住后面有效的 `chainId`。别名表实现在 `src/checks/parse.ts`，C2 与 C3 共用同一份。

| 语义 | 接受的字段名 |
|---|---|
| 支付选项容器 | `accepts`（数组取首项，或直接为对象） |
| 版本 | `x402Version` |
| scheme | `scheme` |
| 网络 | `network` / `chainId` / `chain` |
| 资产 | `asset` / `token` / `assetAddress` |
| 收款地址 | `payTo` / `payToAddress` / `recipient` / `receiver` |
| 金额 | `amount` / `maxAmountRequired` / `maxAmount` / `price` |

### 网络字段归一化

`eip155:2368`、`2368`、`"2368"` 三种写法都接受并归一到 CAIP-2；`kite-testnet` 之类自定义别名不认（本期不开这个口子，避免把错链当对链）。具体实现见 `src/networks.ts` 的 `matchNetwork`。

### 前置失败时的 skip 规则

- 缺 `PAYMENT-REQUIRED` → `c2.header` 失败，`c2.decode` 跳过，后续不再执行。
- 头解不出 JSON → 停止，不出后续断言。
- 支付选项里没有 `asset` → `c2.asset` **critical 失败**（不是 skip）：客户端无法构造 EIP-712 `verifyingContract`，这不是「无法判断」而是「无法支付」。
- 载荷里没有 `accepts` → `c2.scheme` 失败，网络/资产/地址/金额全部跳过。

这样做的原因：一个根因不应该刷出十条红字，但也绝不允许把「没检查」显示成「通过」。

## C3 · 授权可构造

C2 问「卖家收费要求写对了吗」，C3 问另一半：「客户按这个要求签出来的付款，能不能真的结算」。全部离线完成——不连 RPC、不用私钥、不发请求，因此可以在 CI 里对一份抓包载荷重跑。

输入：`PAYMENT-REQUIRED` 头值、`PAYMENT-SIGNATURE` 头值、期望网络、评估时刻（`now`，由 runner 注入）。输出：14 条断言。

### 设计原则：每条断言对应一个真实拒绝码

C3 不发明规则。每条断言都对应 `@x402/evm` 里 facilitator 已经实现的一个拒绝分支，来源是该包 `exact/facilitator` 的错误码常量表：

| 断言 id | 断言 | 级别 | facilitator 拒绝码 |
|---|---|---|---|
| `c3.challenge` | 挑战可解码，且至少含一个支付选项 | critical | —（C3 前置条件） |
| `c3.payment` | `PAYMENT-SIGNATURE` 可解码为 JSON 对象 | critical | `invalid_payload` |
| `c3.payload-version` | 载荷 `x402Version === 2` | critical | 载荷 schema 的 `literal(2)` |
| `c3.payload-shape` | `payload.authorization` 六个 EIP-3009 字段齐全、类型正确（`nonce` 为 32 字节 hex，其余为地址或十进制整数） | critical | `invalid_payload` |
| `c3.accepted-binding` | `payload.accepted` 的 scheme / network / asset / payTo / amount 与挑战中**某一个** advertised 选项一致；匹配不到即判失败（过期或外来报价）。两侧都没有 `network` 时**不视为一致** | critical | `invalid_exact_evm_network_mismatch` |
| `c3.binding-payto` | `authorization.to` 等于报价的 `payTo` | critical | `invalid_exact_evm_recipient_mismatch` |
| `c3.binding-value` | `authorization.value` 等于报价金额（按 bigint 比较，不按字符串） | critical | `invalid_exact_evm_authorization_value` |
| `c3.address-sanity` | `from` / `to` 均非零地址 | critical | 零地址无法恢复出有效签名 |
| `c3.address-sanity`（同一断言的告警分支） | `from !== to` | warning | **facilitator 不拒绝自转付款**，只是工程建议，不作为结算判定 |
| `c3.domain-config` | 挑战的 `extra.name` / `extra.version` 存在，`network` 可解析出 chainId 且等于 `--network` 指定链，`asset` 是合法地址 | critical | `invalid_exact_evm_missing_eip712_domain` + `invalid_exact_evm_network_mismatch` |
| `c3.window` | `validAfter <= now` 且 `validBefore >= now + 6` | critical | `..._payload_authorization_valid_after` / `..._valid_before` |
| `c3.window-span` | 剩余可重放时间 `validBefore - now` 不超过 `maxTimeoutSeconds`（缺省 3600） | warning | —（工程建议，非协议拒绝） |
| `c3.signature-format` | 签名为 65 字节 `r‖s‖v`，且 `v ∈ {27, 28}` | critical | `invalid_exact_evm_failed_to_parse_signature` |
| `c3.signature-low-s` | `s <= secp256k1n / 2` | critical | `invalid_exact_evm_non_canonical_signature` |
| `c3.signature-recovery` | 用挑战里的域复算 digest，`ecrecover` 结果等于 `authorization.from` | critical | `invalid_exact_evm_signature` |

### 为什么「恢复出付款人」一条就够证明域是对的

EIP-3009 的签名摘要由三部分拼成，任何一部分不同都会得到完全不同的摘要，恢复出的地址就是一个随机地址：

```
digest = keccak256(0x1901 ‖ domainSeparator ‖ structHash)
domainSeparator = keccak256(abi.encode(typeHash, keccak256(name), keccak256(version), chainId, verifyingContract))
structHash      = keccak256(abi.encode(authTypeHash, from, to, value, validAfter, validBefore, nonce))
```

所以 `c3.signature-recovery` 通过，等于同时证明了：域字段（含 `name` / `version` / `chainId` / `verifyingContract`）、六个授权字段的取值、`v` 的归一化方式——三项同时正确。反过来，只要它失败，其余全对也没有意义。

`src/eip712.ts` 手写了这段编码，而不是直接调 `hashTypedData`，原因是签名失败时唯一有用的产物是「哪一段字节对不上」，一个不透明摘要给不出这个信息。手写实现与 viem 的 `domainSeparator` / `hashTypedData` 在测试里逐字节比对（`test/eip712.test.ts`），并在测试中固定了一组 Kite testnet 的黄金值。

### 失败时给出归因，而不是只说「不匹配」

`c3.signature-recovery` 失败时，检查器会换用不同的 `version`（`"1"` / `"2"`）与 `chainId`（挑战值 / 2366 / 2368）重新组域再恢复一次：

- 命中某个组合 → 报告里直接写出「它其实是用 `version="2" chainId=2368` 签的」。这正是实践中最常见的两类错：把 EIP-712 `version` 写成了链上 `chainId` 的口径，或者对着 mainnet 签名却发给 testnet 服务。
- 全部不命中 → 明确说「没有任何 version/chainId 组合能恢复到付款人，所以差异在签名内容、代币 `name` 或私钥」，不猜。

`evidence` 里同时保留 `digest`、`domainSeparator`、`recovered`、`matchesUnder`，任何人可以拿这些值独立复算。

### 与 viem `parseSignature` 的差异（有意为之）

viem 的 `parseSignature` 接受结尾字节为 `0` / `1`（把它当作 `yParity`），离链恢复照常工作。但链上 `ecrecover` 只认 `27` / `28`，传 `0` / `1` 会返回零地址，`transferWithAuthorization` 随即 revert——付款方以为付了，实际没付。

`c3.signature-format` 因此比 viem 更严：`0` / `1` 判 critical 失败，但**不阻断**后续断言，恢复与低 s 检查仍会执行，报告里能同时看到「编码不合规」和「内容是对的」。

### `validBefore >= now + 6` 里的 6 来自哪里

参考实现 facilitator 的判定是 `validBefore < now + 6` 即拒绝。抓包重放时经常遇到「签名本身没错，只是只剩 3 秒」的情况，用 `> now` 会判为通过，用 `>= now + 6` 才和实际结算行为一致。可以用 `--min-validity` 覆盖。

### 前置失败时的 skip 规则

- 挑战缺失/不可解码/无 `accepts` → `c3.challenge` 失败，其余 13 条全部 skip。
- 载荷缺失/不可解码 → `c3.payment` 失败，其余 skip。
- `x402Version !== 2` → `c3.payload-version` 失败，其余 skip（v1 载荷结构不同，本期不猜）。
- 六个字段任一不合规 → `c3.payload-shape` 失败，其余 skip；但 `evidence.problems` 里列出**全部**问题（典型是序列化 bug，一次看全更快定位）。
- 域不可推导 → `c3.domain-config` 失败，`c3.signature-recovery` skip；签名格式与低 s 仍照常检查（它们不需要域）。
- 签名解析失败 → `c3.signature-format` 失败，低 s 与恢复 skip。
- 遇到 ERC-6492 包裹签名（智能合约钱包）→ 格式、低 s、恢复三条全部 **skip**，不判 pass。识别条件是「尾 32 字节为 magic **且**能按 `abi.encode(address,bytes,bytes)` 解出非零 factory 与非空 calldata」。只查 magic 尾缀会被 65 字节垃圾签名伪造，导致三条断言全部跳过、退出码 0——这是已经被修复的 fail-open。恢复内层签名仍需要账户实现，C3 不建模。

### 数值边界：拒绝已经被 JSON.parse 改写的数字

`JSON.parse("9007199254740993")` 得到 `9007199254740992`。如果把这个数按字符串输出，C2 会报告「金额是 9007199254740992」——那不是发送方写的值。`parse.ts` 的 `unsafeIntegerFields` 会识别这类字段，`c2.amount` 与 C3 的金额/chainId/`maxTimeoutSeconds` 一律拒绝它，并要求发送方改用十进制字符串。

### 多选项挑战

`accepts` 可以包含多个选项，客户端可以合法选其中任何一个。C3 会按 `payload.accepted` 选出匹配项再校验；`payload.accepted` 与**所有** advertised 选项都不一致时才判 `c3.accepted-binding` 失败。C2 的契约仍是「只检查第一个选项」，两者职责不同。

### C3 明确不检查的东西

| 项 | 原因 | 归属 |
|---|---|---|
| `nonce` 是否已被消耗 | 需读链上 `authorizationState(from, nonce)` | C4/C5 实盘范围 |
| 付款人余额是否足够 | 需读链上 `balanceOf` | 同上 |
| 代币是否真的支持 EIP-3009 | 需链上调用探测 | 同上 |
| 挑战的 `extra.name` / `version` 是否与链上 `name()` / `version()` 一致 | 需 RPC；只能验「自洽」（签名按挑战域恢复成功） | 同上 |
| 智能合约钱包（ERC-1271 / ERC-6492）的签名有效性 | 需账户实现，且低 s 规则对已部署合约账户有豁免 | 不建模 |
| 上游服务是否真的交付内容 | 与本工具定位无关 | 不做 |

## 待确认项（写在明面上，不猜）

| 项 | 现状 | 处理方式 |
|---|---|---|
| 挑战载荷的官方字段全集 | 以实际模板响应为准，可能存在未覆盖的可选字段 | 只校验必需字段；新增字段不视为失败 |
| 金额是否允许 `"1000"` 字符串 | 当前接受数字与数字字符串 | 若官方明确要求字符串，收紧为字符串 |
| mainnet facilitator 地址 | 未从公开来源确证 | 不硬编码，走 `KITE_FACILITATOR_URL` |
| mainnet 结算资产的 `name` / `version` | 未从公开来源确证 | 不硬编码；C3 只校验挑战自述与签名是否自洽 |

## 新增检查项的要求

1. id 前缀与编号一致（`c3.*`、`c4.*`），不复用已有 id。
2. 每条断言必须能单独解释「为什么它会让人亏钱或被骗」，否则降级为 warning。
3. 正例 1 个、反例 ≥3 个、边界 ≥1 个，写在同编号的测试文件里。
4. 断言不得读取环境变量或发起请求——需要外部数据的部分由 runner 注入（C3 的 `now` 就是这样注入的）。
5. 同步更新本文件与 `CHANGELOG.md`。
