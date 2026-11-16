# 检查项规格

每个检查项都要写明：断言什么、依据什么、失败算多严重。这份文件是判定逻辑的唯一说明来源，代码与它不一致时以本文件为准并修代码。

## 总表

| 编号 | 检查项 | 断言数 | 状态 | 目标周 |
|---|---|---|---|---|
| C1 | 清单一致性（`service.yaml` / `.well-known/x402` vs 实测） | — | 未实现 | W3 |
| **C2** | **402 挑战结构** | **10** | **已实现** | W1 ✅ |
| C3 | 授权可构造（EIP-712 域 + EIP-3009 可恢复签名） | — | 未实现 | W2 |
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
| `c2.asset` | 资产地址通过 `isAddress` | critical | 防止拼错地址导致转账失败 |
| `c2.pay-to` | 收款地址通过 `isAddress` | critical | 同上 |
| `c2.amount` | 金额为正整数（原子单位，不接受小数、负数、科学计数） | critical | 小数金额会被合约按整数截断 |
| `c2.pay-to-match` | 配置了期望收款地址时，实际值必须一致 | critical | 防止被替换收款方 |

### 字段别名

不同 SDK 版本命名不一致，检查器按下列别名读取；**全部缺失时判失败，不使用默认值**。

| 语义 | 接受的字段名 |
|---|---|
| 支付选项容器 | `accepts`（数组取首项，或直接为对象） |
| 版本 | `x402Version` |
| scheme | `scheme` |
| 网络 | `network` / `chainId` / `chain` |
| 资产 | `asset` / `token` / `assetAddress` |
| 收款地址 | `payTo` / `payToAddress` / `recipient` / `receiver` |
| 金额 | `maxAmountRequired` / `amount` / `maxAmount` / `price` |

### 网络字段归一化

`eip155:2368`、`2368`、`"2368"` 三种写法都接受并归一到 CAIP-2；`kite-testnet` 之类自定义别名不认（本期不开这个口子，避免把错链当对链）。具体实现见 `src/networks.ts` 的 `matchNetwork`。

### 前置失败时的 skip 规则

- 缺 `PAYMENT-REQUIRED` → `c2.header` 失败，`c2.decode` 跳过，后续不再执行。
- 头解不出 JSON → 停止，不出后续断言。
- 载荷里没有 `accepts` → `c2.scheme` 失败，网络/资产/地址/金额全部跳过。

这样做的原因：一个根因不应该刷出十条红字，但也绝不允许把「没检查」显示成「通过」。

## 待确认项（写在明面上，不猜）

| 项 | 现状 | 处理方式 |
|---|---|---|
| 挑战载荷的官方字段全集 | 以实际模板响应为准，可能存在未覆盖的可选字段 | 只校验必需字段；新增字段不视为失败 |
| 金额是否允许 `"1000"` 字符串 | 当前接受数字与数字字符串 | 若官方明确要求字符串，收紧为字符串 |
| mainnet facilitator 地址 | 未从公开来源确证 | 不硬编码，走 `KITE_FACILITATOR_URL` |

## 新增检查项的要求

1. id 前缀与编号一致（`c3.*`、`c4.*`），不复用已有 id。
2. 每条断言必须能单独解释「为什么它会让人亏钱或被骗」，否则降级为 warning。
3. 正例 1 个、反例 ≥3 个、边界 ≥1 个，写在同编号的测试文件里。
4. 断言不得读取环境变量或发起请求——需要外部数据的部分由 runner 注入。
5. 同步更新本文件与 `CHANGELOG.md`。
