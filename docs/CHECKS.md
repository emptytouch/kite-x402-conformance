# 检查项规格

每个检查项都要写明：断言什么、依据什么、失败算多严重。这份文件是判定逻辑的唯一说明来源，代码与它不一致时以本文件为准并修代码。

## 总表

| 编号 | 检查项 | 断言数 | 状态 | 目标周 |
|---|---|---|---|---|
| C1 | 清单一致性（`service.yaml` / `.well-known/x402` vs 实测） | **12** | **已实现（判定层）** | W3 ✅ |
| **C2** | **402 挑战结构** | **10** | **已实现** | W1 ✅ |
| **C3** | **授权可构造（EIP-712 域 + EIP-3009 可恢复签名）** | **14** | **已实现** | W2 ✅ |
| **C4** | **结算时序（无签名不转发、上游失败不结算、成功返收据）** | **12** | **已实现** | W2 ✅ |
| **C5** | **重放与幂等（同签名 / 同键 / 换键绕过）** | **13** | **已实现** | **W3 ✅** |

## C1 · 清单一致性

清单声称的服务参数，和客户端实际拿到的 402 挑战，是两份独立信息。卖家把 `service.yaml` / `.well-known/x402` 写错（收款地址过期、网络写错、金额与端点不符、端点加量却没更新清单）时，客户端按清单集成就会付错钱或被拒付；反过来，实测端点没有出现在清单里，说明清单已经漂移。C1 把这两份信息放在一起比对。

**这是纯判定函数，不解析 YAML、不发请求。** 清单解析与 HTTP 探针由 runner 负责；判定层只接收已结构化的声明条目与实测条目。这样判定逻辑不绑定某一种清单格式，也不会把「解析失败」伪装成「不一致」。

输入契约：

```ts
type ManifestSource = "static-file" | "well-known" | "challenge-echo" | "unknown";

interface ManifestEntry {
  readonly path: string;              // "/v1/echo"
  readonly network: string | number;  // "eip155:2368" | 2368
  readonly payTo: string;             // 0x… 40 hex
  readonly asset: string;             // 0x… 40 hex
  readonly amount: string;            // 原子单位、无前导零的十进制整数字符串
}

interface ObservedEntry {
  readonly path: string;
  readonly responseStatus: number;    // 必须 402
  readonly hasPaymentRequired: boolean;
  readonly network: string | number;
  readonly payTo: string;
  readonly asset: string;
  readonly amount: string;
}

interface ManifestConsistencyInput {
  readonly source: ManifestSource;    // 清单来自哪里，决定比对是否有意义
  readonly manifest: readonly ManifestEntry[];
  readonly observed: readonly ObservedEntry[];
}
```

`source` 是本检查的核心：`challenge-echo` 表示清单是用实测挑战反推生成的——这种「清单」和实测必然一致，比对是同义反复，必须明确失败；`unknown` 表示 runner 无法证明清单独立采集，不能算通过；只有 `static-file` / `well-known` 才允许继续判定。判定层无法自证 runner 的诚实性，只能基于它提供的来源元数据做决定。

输出：固定顺序的 12 条断言。

| 断言 id | 断言 | 级别 | 失败对应的亏损场景 |
|---|---|---|---|
| `c1.input` | 输入结构合法：数组、必需自有字段、类型与格式（路径、`0x` 地址、原子单位金额、可解析网络） | critical | 畸形输入下给出「一致」结论，比没有检查更危险 |
| `c1.source-independent` | 清单来源为 `static-file` 或 `well-known` | critical | 清单是挑战回显，比对自证；`unknown` 为 skip，不能算 pass |
| `c1.manifest-present` | 清单至少声明一个端点 | critical | 空清单 vs 实测端点，若算通过则完全漏报 |
| `c1.observed-present` | 至少有一个实测端点观测 | critical | 空观测下所有比对空洞通过 |
| `c1.challenge-shape` | 每个实测端点返回 402 且带 `PAYMENT-REQUIRED` | critical | 对 200 响应做「挑战一致性」判定，结论无意义 |
| `c1.no-undeclared` | 每个实测付费端点都在清单中声明 | critical | 端点加量未入清单，客户按清单集成会漏付/被拒 |
| `c1.no-ghost` | 每个清单声明端点都有对应的 402 实测 | critical | 清单列了不存在的服务端点，客户按清单集成直接失败 |
| `c1.network-match` | 同路径声明网络与实测网络 chainId 一致 | critical | 客户按 2368 付款、服务端按 2366 收，签名域错配 |
| `c1.pay-to-match` | 同路径声明收款地址与实测一致（大小写归一） | critical | 付款打到旧地址或第三方地址 |
| `c1.asset-match` | 同路径声明资产地址与实测一致 | critical | 客户付错代币，卖家收不到款 |
| `c1.amount-match` | 同路径声明金额与实测原子单位金额一致 | critical | 按清单报价付款被拒，或超付 |
| `c1.no-conflict` | 清单内同一 `(path, network)` 没有值互相矛盾的重复声明 | warning | 同端点同网络两个报价，客户选哪个都可能是错的 |

比对规则：

- 路径按原字符串精确匹配（runner 负责规范化 query / trailing slash）。`no-undeclared` / `no-ghost` 只做路径级覆盖判定；同一路径声明与观测网络不同时，只由 `c1.network-match` 报告，不重复算作「未声明」。
- 网络统一经 `chainIdFromNetworkField` 转为 chainId 后比较，接受 `eip155:2368` / `2368` / 数字 `2368`；无法解析视为输入非法。
- 地址按 `0x` + 40 hex 校验，比较时转小写；非规范地址视为输入非法，不做「看起来像」的猜测。
- 金额是原子单位整数字符串，必须无前导零；`00100` 与 `100` 不视为同一声明，输入校验直接拒绝。JSON number 一律拒绝——`JSON.parse` 可能已经把大于 2^53 的金额悄悄改写。
- 跨路径比对：断言级别汇总，任一路径不一致即该断言失败，`evidence` 列出具体路径；不是每条路径各出一条断言。

skip 规则（级联，skip 永远不等于通过）：

1. `c1.input` 失败 → 其余 11 条全部 skip。
2. `c1.source-independent` 为 `challenge-echo`（fail）或 `unknown`（skip）→ 其余 10 条全部 skip。
3. `c1.manifest-present` 或 `c1.observed-present` 失败 → 其后的断言全部 skip。
4. 四个值级断言（`network` / `pay-to` / `asset` / `amount`）只在双方都有该路径时判定；路径缺失已由 `no-undeclared` / `no-ghost` 报告，不在值级断言里重复判失败。

### C1 明确不检查的东西

- 不解析 `service.yaml` / `.well-known/x402` 的原始文本，也不验证清单来源是否真的来自声明的 origin——runner 负责，判定层只能看 `source` 元数据。
- 不验证清单是否被篡改、是否有有效签名。
- 不发送付款、不读取链上状态、不核验收款地址是否属于卖家。
- 不替代 C2（挑战结构）、C3（授权可构造）、C4（结算时序）、C5（重放幂等）；清单一致但挑战本身写错仍会被 C2 抓到。

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

## C4 · 结算时序

C2 问「收费要求写对了吗」，C3 问「客户签出来的付款能不能结算」。C4 问第三件、也是唯一直接涉及钱的问题：**服务端把结算放在了正确的时点吗**。它不解析签名，也不读链，只依据四个探针的观测结果判断时序。

### 依据：每条断言对应一个真实的亏损场景

依据来自方案稿 §2 的两条借鉴：`axum`「只有上游返回 `<400` 才结算」与 `hono`「结算后再返回内容」。把它展开成四种请求，每种对应一个可直接量化损失的失败模式：

| 探针 | 期望时序 | 违反时的后果 |
|---|---|---|
| 无签名请求 | 返回 402，上游不被调用，不结算 | 不付钱就拿到付费内容，收入直接损失 |
| 错误签名请求 | 返回 402，上游不被调用，不结算 | 伪造授权也能拿到内容或被扣款 |
| 上游 4xx/5xx | 上游被调用，但**不结算** | 用户付了钱却没拿到内容（白扣钱） |
| 上游 2xx | 上游被调用、结算成功、返回 200 且 `PAYMENT-RESPONSE` 含 tx hash | 内容白送，或付了款却拿不到可对账的凭据 |

### 输入：runner 注入的可信观测，不是客户端自说自话

关键限制：`upstreamCalled`、`settled` 这两项**无法从单个客户端响应推出**——服务端可以对着客户端说「结算成功」，背地里既没结算也没转发。所以 C4 断言本身不发请求、不读环境，输入是 runner / mock 环境注入的四个探针观测：

```ts
interface ProbeObservation {
  readonly probe: "unsigned" | "invalidSignature" | "upstreamError" | "upstreamSuccess";
  readonly responseStatus: number;                       // 服务端给客户端的状态码
  readonly responseHeaders: Record<string, string>;      // 含 PAYMENT-RESPONSE
  readonly upstreamCalled: boolean;                      // 上游是否真的收到请求
  readonly upstreamStatus: number | undefined;           // 上游状态码，未调用时为 undefined
  readonly settled: boolean;                             // 结算是否真的发生
  readonly settlementStatus: number | undefined;         // 结算接口状态，未结算时为 undefined
}
```

`responseHeaders` 的值必须是字符串；非字符串会让 `c4.probes` 输入校验失败，而不是让解码过程抛异常。

**跨字段一致性也是输入校验的一部分**：布尔量与配套状态码必须自洽，否则不能当真值使用——让服务端自报 `settled:false, settlementStatus:200` 却判 `no-settle` 为 pass，正是 C4 要防的「没付款也扣钱」。以下四种矛盾组合在 `c4.probes` 阶段失败，其余断言全部 skip：

- `settled === true` 但 `settlementStatus` 缺失，或不是 2xx（结算接口返回失败却声称结算成功）；
- `settled === false` 但 `settlementStatus` 有值（声称没结算却有结算状态）；
- `upstreamCalled === true` 但 `upstreamStatus` 缺失；
- `upstreamCalled === false` 但 `upstreamStatus` 有值。

若 runner 的上游确实「调了但没拿到状态码」，它应把 `upstreamCalled` 记为 `false`（从 C4 的视角，没有可判定状态码的上游调用不产生可判定观测）。五个探针语义字段自洽是 `c4.probes` 的契约；放宽它等于把判定建立在自相矛盾的输入上。

这四个观测必须由**能观察到上游与结算接口的那一层**产生。只拿一个 URL 跑 `fetch` 无法填满这个输入——判定层因此保持为纯函数，观测由独立的 runner 层采集。

### 探针执行层（已实现，仅内置 sandbox）

`src/probes/settlement-order.ts` 提供 `runSandboxSettlementProbes()`，CLI 对应 `x402conf verify`。它启动三个各自独立的本地 HTTP 服务：mock upstream、mock facilitator，以及作为**被测对象**的 sandbox seller，然后依次发四个探针。

观测生成规则是这条检查的可信基础：

1. 每个探针开始前清空两个 mock 的调用日志；探针顺序执行，并等待 seller 返回后才读日志。因此一条日志只可能属于当前探针，不需要 seller 回传关联 id。
2. `upstreamCalled` / `upstreamStatus` 只从 mock upstream 的请求日志取；`settled` / `settlementStatus` 只从 mock facilitator 的 `/settle` 日志取。
3. seller 响应头（包括 `PAYMENT-RESPONSE`）只作为 `responseHeaders` 传给收据校验，**从不参与** `upstreamCalled` / `settled` 的判定。

第 3 条有一个专门的反证模式 `forged-claim`：seller 在完全没有调用 facilitator 的情况下，返回一个带合法 tx hash 的 `PAYMENT-RESPONSE`。此时 `c4.upstream-success.receipt` 会通过，但 `c4.upstream-success.settled` 必须失败。测试 `test/settlement-order-runner.test.ts` 对照 `none` 与 `forged-claim` 两次运行，锁住这条信任边界。

sandbox seller 内置 7 种模式（`none` 与 6 种缺陷），每种缺陷只改一处时序决策：

| `--defect` | 注入的缺陷 | 必须失败的断言 |
|---|---|---|
| `none` | 无 | 无（12 条全过） |
| `free-access` | 无签名也转发并结算 | `unsigned.status` / `no-forward` / `no-settle` |
| `forged-signature` | 错误签名也放行 | `invalid-signature.status` / `no-forward` / `no-settle` |
| `charge-on-error` | 上游 503 仍结算 | `upstream-error.no-settle` |
| `skip-settlement` | 上游 2xx 不结算、无收据 | `upstream-success.settled` / `receipt` |
| `bad-receipt` | 结算了但收据 hash 非法 | `upstream-success.receipt` |
| `forged-claim` | 没结算却自报合法收据 | `upstream-success.settled` |

这套 runner **只测内置合成 seller**：它不连真实 facilitator、不发交易、不读链。通过只说明「在 sandbox 观测下时序正确」，不是任何真实服务的合规证据。接真实服务需要对方指向同一组 mock 并提供等价遥测，或另写 live runner——两者都未实现，见 `docs/LIMITATIONS.md`。

### 断言表（12 条）

| 断言 id | 断言 | 级别 | 判定要点 |
|---|---|---|---|
| `c4.probes` | 四个探针观测齐全且字段类型合法 | critical | 前置条件；缺任一探针即失败，其余断言 skip |
| `c4.unsigned.status` | 无签名请求返回 402 | critical | 服务端必须索要付款，而不是 200/5xx |
| `c4.unsigned.no-forward` | 无签名请求未触达上游 | critical | `upstreamCalled === false` |
| `c4.unsigned.no-settle` | 无签名请求未结算 | critical | `settled === false`；防止「没付款也扣钱」 |
| `c4.invalid-signature.status` | 错误签名返回 402 | critical | 验证失败统一 402，不是 5xx（与 axum 错误语义一致） |
| `c4.invalid-signature.no-forward` | 错误签名未触达上游 | critical | `upstreamCalled === false` |
| `c4.invalid-signature.no-settle` | 错误签名未结算 | critical | `settled === false` |
| `c4.upstream-error.forwarded` | 上游失败探针确实触达一个 4xx/5xx 上游 | critical | 前置：没触达失败上游就无法判断「失败时是否结算」；上游返回 2xx/3xx 说明失败场景没构造出来 |
| `c4.upstream-error.no-settle` | 上游 4xx/5xx 时不结算 | critical | 核心断言：`upstreamStatus >= 400 && settled === false` |
| `c4.upstream-success.forwarded` | 上游成功探针确实触达上游且返回 2xx | critical | 前置：`upstreamStatus ∈ [200,300)` |
| `c4.upstream-success.settled` | 上游 2xx 时确实结算 | critical | `settled === true`；内容不能白送 |
| `c4.upstream-success.receipt` | 返回 200 且 `PAYMENT-RESPONSE` 可解码、含合法 tx hash | critical | 收据是唯一可对账凭据；hash 必须是 `0x` + 64 hex |

### 为什么把「转发」和「结算」拆成两条

它们在不同环节失守，修法不同：`no-forward` 失败说明验证中间件放行得太早（改 middleware）；`no-settle` 失败说明结算被调用在错误分支上（改 settle 触发条件）。合成一条断言会让报告只说「时序错了」，无法定位。

### 收据为什么必须含 tx hash

`PAYMENT-RESPONSE` 存在但字段是空对象、占位字符串或格式错误的 hash，看起来像「拿到了收据」，实际无法在浏览器打开、也无法写进 `docs/EVIDENCE.md`。C4 用 `decodeHeaderValue` 解码后读取 `txHash` / `transactionHash` / `tx` / `hash` 别名（见 `src/checks/parse.ts` 的字段名容忍策略），并要求 `/^0x[0-9a-fA-F]{64}$/`。解析失败、字段缺失、格式错误一律 critical 失败，不 skip。

别名读取遵循 parse.ts 的两条既有规则：**空串跳过**（所以 `txHash: ""` 不遮住后面的 `transactionHash: <valid>`）；**只读自有属性**（`Object.hasOwn`，进程级原型污染不能造出假 hash）。`receipt` 与 `settlement` 两个包装各自独立解析，一个非空字符串但非对象的包装不会吞掉另一个里的合法 hash。注意「空串跳过」与「非空但格式错误即失败」是两条不同规则：后者是真实发现，不能被后续别名掩盖。

### 前置失败时的 skip 规则

- 四个探针任一缺失或字段非法 → `c4.probes` 失败，其余 11 条全部 skip。
- 上游失败探针没触达上游、或上游返回的不是 4xx/5xx（2xx/3xx）→ `c4.upstream-error.forwarded` 失败，`c4.upstream-error.no-settle` skip（失败场景没构造出来时，`settled === false` 是空洞的，不能当成「正确没结算」）。
- 上游成功探针没触达或未返回 2xx → `c4.upstream-success.forwarded` 失败，`c4.upstream-success.settled` 与 `receipt` skip。
- 无签名 / 错误签名探针里 `upstreamCalled === true` 时，`no-settle` 仍然照常判断，不因前置失败而 skip——「既转发又结算」比「只转发」更严重，需要同时出现在报告里。

skip 恒不等于通过：报告底部的提示与 C2/C3 一致。

### C4 明确不检查的东西

| 项 | 原因 | 归属 |
|---|---|---|
| 签名本身是否有效 | 离线验签是 C3 的职责 | C3 |
| 链上 tx 是否真的成功落块 | 需要 RPC 读收据 | 未来 runner 的 live 模式 |
| `nonce` 是否被二次结算 | 需要跨请求状态 | C5 |
| 服务端是否谎报 `upstreamCalled` / `settled` | 判定层无法自证；sandbox runner 通过独立的 mock 日志规避，真实服务仍需自己的可信遥测 | `src/probes/settlement-order.ts`（sandbox），真实遥测未实现 |

## C5 · 重放与幂等

C4 问「一次请求里的结算时点对不对」。C5 问第四件、也是直接影响付款人钱包的问题：**同一笔付款被提交两次时，会不会扣两次钱**。它不是「请求去重」的性能检查，而是 nonce 与 Idempotency-Key 两道防线的有效性检查。

### 依据：三条会被真实扣款的重复路径

| 探针 | 请求关系 | 正确行为 | 违反后的后果 |
|---|---|---|---|
| `nonceReplay` | 同一 `PAYMENT-SIGNATURE` 提交两次，第二次带**新**的 `Idempotency-Key` | 第二次 402，不结算 | 只靠幂等键去重的服务会在换 key 后二次扣款；这是最常见的假幂等 |
| `idempotencyKey` | 同一 key、同一载荷重试两次（网络超时重发的典型形态） | 第二次返回缓存结果，不结算、不转发 | 客户端重试一次就被扣两次，或拿到与首次不同的内容无法对账 |
| `nonceReuse` | 同一 authorization.nonce 重新签一条消息后提交（绕过「签名字节相同」的检查） | 第二次 402，不结算 | 只按签名字符串去重的实现会被重新签名绕过，链上 nonce 才是最终防线 |

注意 `nonceReplay` 与 `nonceReuse` 的区别：前者要求「同一签名字节」，后者要求「同一 nonce 但签名不同」。只做前者会让「重新签名 + 换 nonce 之外的字段」溜过去；只做后者无法证明签名级去重。两条独立存在，不是重复检查。

### 输入：runner 注入的两次尝试观测

与 C4 相同，`settled` / `upstreamCalled` / `cacheHit` **无法从单个客户端响应推出**，必须由能看到 facilitator、上游与缓存的那一层注入。C5 是纯函数：不发请求、不读环境、不读时钟。

```ts
interface ReplayAttempt {
  readonly responseStatus: number;                    // 该次尝试返回客户端的状态
  readonly responseHeaders: Record<string, string>;   // 含 PAYMENT-RESPONSE
  readonly responseBodyHash: string;                  // 响应体的稳定摘要，用于比对缓存结果
  readonly settled: boolean;                          // 该次尝试是否真的结算
  readonly settlementStatus: number | undefined;
  readonly upstreamCalled: boolean;
  readonly upstreamStatus: number | undefined;
  readonly cacheHit: boolean;                         // 该次尝试是否命中服务端幂等缓存
}

interface ReplayScenarioObservation {
  readonly scenario: "nonceReplay" | "idempotencyKey" | "nonceReuse";
  readonly first: ReplayAttempt;
  readonly second: ReplayAttempt;
}
```

`responseBodyHash` 由 runner 计算，检查器只比对是否相等，因此摘要算法由 runner 决定（如 sha256）。**检查器不比对原文**：一是避免把大 payload 塞进观测，二是判定层不负责校验摘要正确性——那是 runner 的契约。

### 跨字段一致性

与 C4 相同，布尔量与配套状态码必须自洽，否则不是可用观测：

- `settled === true` ↔ `settlementStatus` 存在且为 2xx；
- `upstreamCalled === true` ↔ `upstreamStatus` 存在；
- `cacheHit === true` 时 `settled` 必须为 `false`，且 `upstreamCalled` 必须为 `false`——缓存命中却重新结算或重新转发，本身就是被测缺陷，不是可接受的观测；
- 两个 `responseHeaders` 的值必须是字符串，`responseBodyHash` 必须是非空字符串。

`cacheHit === true && settled === true` 被判为**输入非法**而不是直接判 c5 断言失败：这种组合说明 runner 的观测自相矛盾，此时任何结论都不可信。

### 探针执行层（已实现，仅内置 sandbox）

`src/probes/replay.ts` 提供 `runReplayProbes()`，CLI 对应 `x402conf verify-replay`。它启动独立 mock upstream、mock facilitator、mock cache，以及作为被测对象的有状态合成 seller。三场景各发两次请求，每次请求前清空三个 mock 的日志，因此每行日志只属于当前这次尝试，不靠关联 id 或 seller 自述。

观测来源严格受限：`settled` 来自 facilitator 的 `/settle` 日志，`upstreamCalled` 来自 upstream 日志，`cacheHit` 来自 cache 的 `GET` 命中日志（且 key 必须是本次尝试的 key）。seller 响应里的 `x-c5-cache-claim: hit` 只作为证据保留在 `observations[].responseHeaders`，从不参与判定——`idem-no-cache` 模式专门验证这一点：响应声称命中，mock 日志里却连一次 `GET` 都没有。

seller 注入 7 种缺陷（`none` 为良性）：

| 模式 | 被测缺陷 | 预期失败断言 |
|---|---|---|
| `nonce-rebill` | 同签名换新 key 后二次结算并转发 | no-rebill / rejected / no-forward |
| `idem-no-cache` | 同 key 重试不查缓存、二次结算，并谎报缓存命中 | cached / no-rebill / no-forward |
| `idem-cached-rebill` | 命中缓存但仍结算并转发 | cached / no-rebill / no-forward |
| `nonce-reuse-bypass` | 同 nonce 换一份有效签名后二次结算 | no-rebill / rejected |
| `bad-receipt` | 结算成功但 tx hash 格式非法 | same-result |
| `forged-claim` | 零 `/settle` 却返回合法-looking 收据 | 三个 first-settled |
| `first-not-settled` | 首次既不结算也不给收据 | 三个 first-settled + same-result |

两个控制面的区别：`forged-claim` 自报收据但没结算，`same-result` 因两份收据一致而仍通过；`first-not-settled` 连收据都没有，`same-result` 也失败。

**矛盾观测的处理**：判定层把 `cacheHit && (settled || upstreamCalled)` 视为输入非法，`idem-cached-rebill` 正是这种情形。runner 不静默丢掉它，而是把原始冲突写入 JSON 报告的 `sandbox.contradictions`，再将 `cacheHit` 规范化为 `false` 提交判定。这样 `cached` / `no-rebill` / `no-forward` 三条精确失败；若不做规范化，整组场景会因输入矛盾被判非法、其余 12 条全部 skip，反而看不到真正亏钱的是哪一项。该规范化有变异测试反证（去掉后对应测试变红）。

三场景在 seller 内部各自隔离重放状态（签名与 nonce 集合按场景分开），因此调换 `SCENARIO_PLAN` 顺序不会让某场景的首次尝试被另一场景的签名污染。这条也有回归测试与变异反证。

这套 runner 只测内置合成 seller：不发真实交易、不读链上 `authorizationState`、不接真实 facilitator。通过只说明「在 sandbox 观测下三场景没有二次扣款」，不是任何真实服务的合规证据。

### 断言表（13 条）

每条都以「重复提交时是否会亏钱」为存在理由。三个场景各有自己的 `first-settled` 前置：首次没结算成功时，该场景的「未二次结算」是空洞的——不能把「根本没扣过款」当成「成功阻止了重复扣款」。

| 断言 id | 断言 | 级别 | 为什么它防止亏损 |
|---|---|---|---|
| `c5.scenarios` | 三个场景齐全、字段类型合法、跨字段自洽 | critical | 前置；无有效观测时任何 pass 都是空洞的 |
| `c5.nonce-replay.first-settled` | 首次结算成功 | critical | 否则「未二次结算」没有意义 |
| `c5.nonce-replay.no-rebill` | 第二次未结算 | critical | **核心**：换 key 重放不得二次扣款 |
| `c5.nonce-replay.rejected` | 第二次返回 402 | critical | 不能让无效签名拿到付费内容 |
| `c5.nonce-replay.no-forward` | 第二次未触达上游 | critical | 验证中间件不得在无效签名时放行 |
| `c5.idempotency.first-settled` | 首次结算成功 | critical | 否则缓存命中检查没有意义 |
| `c5.idempotency.cached` | 第二次 `cacheHit === true` | critical | 未命中缓存说明去重失效，重试会二次执行 |
| `c5.idempotency.no-rebill` | 第二次未结算 | critical | 同 key 重试不得二次扣款 |
| `c5.idempotency.same-result` | 第二次状态码与 bodyHash 与首次一致，且收据 tx hash 相同 | critical | 内容或收据不一致时，客户端无法对账，也无法判断钱花到哪 |
| `c5.idempotency.no-forward` | 第二次未触达上游 | critical | 缓存命中仍调上游，会产生重复副作用 |
| `c5.nonce-reuse.first-settled` | 首次授权结算成功 | critical | 否则「未二次结算」没有意义，会出现全套绿灯却什么都没验证 |
| `c5.nonce-reuse.no-rebill` | 重新签名的第二次未结算 | critical | nonce 是链上去重的最终依据，不能靠签名字节去重 |
| `c5.nonce-reuse.rejected` | 重新签名的第二次返回 402 | critical | 重新签名不等于重新授权 |

`same-result` 复用 C4 的收据读取规则：解码 `PAYMENT-RESPONSE`，按 `txHash` / `transactionHash` / `tx` / `hash` 别名读取，空串跳过、非空但格式错误即失败、只读自有属性。若首次没有收据，该断言失败而不是 skip——结算成功却不给收据本身就无法对账。

### skip 规则

- 三个场景任一缺失、重复或字段非法 → `c5.scenarios` 失败，其余 12 条全部 skip。
- 某场景首次未结算 → 该场景的 `first-settled` 失败；**该场景其余断言仍照常判断**（二次结算比「没结算成功」更严重，需要同时出现在报告里），不因前置失败而 skip。这与 C4 的 unsigned/invalid-signature 探针处理一致。
- `idempotencyKey` 场景首次无有效收据 → `same-result` 失败，`cached` / `no-rebill` / `no-forward` 仍照常判断。
- 某次尝试返回 402 时，该场景的 `no-rebill` 与 `no-forward` 照常判断——服务端可能先扣款再返回错误，只报「正确拒绝了」会漏掉真实扣款。

skip 恒不等于通过。

### C5 明确不检查的东西

| 项 | 原因 | 归属 |
|---|---|---|
| nonce 在链上是否真的未消费 | 需要 `authorizationState(from, nonce)` RPC | 未来 runner 的 live 模式 |
| 幂等缓存的 TTL / 容量 / 淘汰策略 | 属于性能与配置，不是「会不会扣两次钱」 | 服务端自身测试 |
| 并发请求下的竞态去重 | 需要同时发多个请求的时序控制 | 未来 runner |
| 服务端自报 `settled` / `cacheHit` 是否真实 | sandbox runner 已用独立 mock 日志规避；`x-c5-cache-claim` 只作证据；真实服务仍需自己的可信遥测 | `src/probes/replay.ts`（sandbox），真实遥测未实现 |
| 收据 tx hash 对应的链上交易是否成功 | 需要读链 | 未来 runner 的 live 模式 |

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
