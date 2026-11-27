# 已知限制

本文件说明：哪些能力已经可用、哪些还没有、哪些是故意不做。**报告里看到的结论只覆盖这里写明的范围。**

## 实现状态

| 能力 | 状态 | 说明 |
|---|---|---|
| C2：402 挑战结构（10 条断言） | ✅ 已实现 | 见 `docs/CHECKS.md` |
| C3：授权可构造（14 条断言，EIP-712 域 + EIP-3009 恢复） | ✅ 已实现 | 见 `docs/CHECKS.md` |
| CLI：`check` / `authorize` / `verify` / `verify-replay` / `verify-manifest` / `networks` / `decode` | ✅ 已实现 | `verify` / `verify-replay` 仅内置 sandbox；`verify-manifest` 是真实 HTTP 黑盒探针，见 `docs/CLI.md` |
| 配置校验（环境变量 + 地址格式） | ✅ 已实现 | 非法值启动即失败 |
| JSON 输出（stdout） | ✅ 已实现 | 尚未写文件、未出 JUnit |
| C1 清单一致性（判定层 + 清单解析 + HTTP 探针） | ✅ 已实现 | `src/manifest.ts` 解析 JSON / 受限 YAML，`src/probes/manifest.ts` 对真实端点发 402 探针；**不发付款、不结算、不读链**，清单真实性由来源标记而非密码学验证 |
| C4 结算时序（判定层 + sandbox runner） | ✅ 已实现 | `checkSettlementOrder` 纯函数 12 断言；`x402conf verify` 用独立 mock 日志产生四探针观测。**只测内置合成卖家，不连真实服务** |
| C5 重放与幂等（判定层 + sandbox runner） | ✅ 已实现 | `checkReplayIdempotency` 纯函数 13 断言；`x402conf verify-replay` 用独立 mock upstream / facilitator / cache 日志产生三场景观测。**只测内置合成卖家，不读链上 `authorizationState`** |
| `doctor` 环境自检 | ❌ 未实现 | 计划 W4 |
| `--pay` 实盘模式 | ❌ 未实现 | 私钥变量已预留，当前版本**没有任何代码读取它** |
| `probes/`（周期探测）、`reporters/`（JUnit/SARIF） | ❌ 未实现 | 仅规划，未落空壳代码 |

## 模拟与真实的分界

- 仓库自带的 `examples/mock-seller.ts` 是**合成数据**：占位 `payTo` 与 `asset`，不对应任何真实账户，也不发生任何转账。`extra.name` 故意写成 `"Demo USD"`，避免被误认为某个真实代币的 EIP-712 域。
- `examples/mock-payer.ts` 用 Hardhat 账户 #1 的公开测试私钥签名，只为让签名可复现；该私钥持有零余额，脚本不连任何链，只在本地算一次 EIP-712 签名。
- C3 的「通过」只证明**载荷自洽**：签名确实是按挑战自述的域对挑战自述的金额签的。它不证明链上该代币真的支持 EIP-3009，也不证明付款人有余额。
- `x402conf verify-manifest` 确实对真实端点发 `GET` 并解码 402 挑战，但这是**黑盒一致性**：不发付款、不结算、不读链上状态，也不验证清单是否真由该卖家发布、是否被篡改。来源独立性只靠 `--manifest`（本地文件）或不同 origin 的 `/.well-known/x402` 提供；同 origin 清单标 `unknown` 并退出码 3，不判通过。runner 对非 402 / 无头响应使用固定占位值，让 `c1.challenge-shape` 明确失败，而不是拿占位值去做假比对；头存在但解不出 JSON、缺支付字段或含 unsafe number 则是 runner 错误（退出码 3）。
- 仓库内所有自动化测试使用固定夹具或注入的 fetcher，**不访问外部网络**；手工演示可以访问本地合成卖家，见 `docs/EVIDENCE.md`。
- `x402conf verify` 的观测来自 runner 自己启动的独立 mock upstream / facilitator 的**请求日志**，不是来自被测 seller 的响应头。`forged-claim` 反证模式已固化在测试里：seller 返回合法-looking 的 `PAYMENT-RESPONSE` 却从不调用 facilitator 时，`receipt` 通过而 `settled` 失败。这个信任边界只对内置 sandbox 成立。
- `x402conf verify-replay` 的 `settled` / `upstreamCalled` / `cacheHit` 来自三个独立 mock 的请求日志；seller 响应里的 `x-c5-cache-claim: hit` 只作证据。`idem-no-cache` 反证：响应自报命中、cache 日志连一次 `GET` 都没有，runner 仍判未命中并让 `cached` / `no-rebill` / `no-forward` 失败。
- 判定层拒绝 `cacheHit && (settled || upstreamCalled)`。`idem-cached-rebill` 正是这种输入：runner 保留原始冲突到 `sandbox.contradictions`，把观测规范化为 `cacheHit: false` 让三条断言照常失败。规范化只在 sandbox runner 内发生；库调用方若提交矛盾输入仍会被判 `c5.scenarios` 失败 + 其余 skip。
- C5 的「同 nonce 重新签名」用本地第二个合法签名标记模拟，不读链上 `authorizationState`；「缓存命中」来自本地 mock cache，不代表真实服务端缓存策略。
- C4 / C5 runner 都依赖 seller 在**响应返回前**完成对上游与 facilitator 的调用。runner 在每次探针 / 尝试前清空日志并顺序等待响应，因此同步调用能可靠归属；若被测卖家在后台异步结算，日志可能落到下一次尝试，需要该卖家自己提供按请求关联的遥测。当前 sandbox seller 不存在这个问题（C5 的 cache 查询同样在响应前完成）。
- 内置 mock facilitator 对任何 `/settle` 调用都返回 200：C4 检验的是**卖家是否在正确时点调用结算**，不是 facilitator 是否批准结算，也不检验交易是否上链。
- 目前**没有**任何真实链上结算记录。若后续产生，必须写入 `docs/EVIDENCE.md` 并附可点开的交易链接；在此之前，任何「已验证真实结算」的说法都不成立。`verify` / `verify-replay` 通过只意味着「在 sandbox 观测下时序或重放防护正确」，不意味着被测对象是真实服务、也不意味着观测来自真实结算。

## 未确证的信息

| 项 | 处理 |
|---|---|
| Kite mainnet RPC 与区块浏览器地址 | 不硬编码，`networks.ts` 中为 `null`，需 `KITE_RPC_URL` 提供；`networks` 命令显示 `verified=false` |
| Kite facilitator 的正式地址 | 不硬编码，走 `KITE_FACILITATOR_URL` |
| 挑战载荷可选字段全集 | 只校验必需字段；未知字段不算失败 |
| 清单是否由卖家授权发布、是否带有效签名 | 不验证。`verify-manifest` 只按来源标记区分 `static-file` / `well-known` / `unknown`；拿到一份被篡改但格式合法的清单，C1 会如实报告它与实测不一致，但不会证明哪一方被篡改 | `--source` 与 `manifest.source` |
| 结算资产地址（USDT / pieUSD） | 不硬编码。`KITE_ASSET_ADDRESS` 会被校验和加载，但本版本**没有断言读取它**：C2 只验地址格式，C3 的 `verifyingContract` 取自挑战 |
| mainnet 结算资产的 `name` / `version` | 未从公开来源确证，不硬编码。C3 的 `c3.domain-config` 只要求挑战自述这两个字段，正确性由「签名能否按该域恢复」间接证明 |

不硬编码的原因：写错一个地址会让工具给出「通过」的错误结论，比拒绝运行更危险。

## 容忍与严格度的取舍

| 场景 | 当前策略 | 风险 |
|---|---|---|
| 网络字段 `eip155:2368` / `2368` / `"2368"` | 全部接受并归一 | 宽松但方向一致，不会把错链放进来 |
| 自定义网络别名（如 `kite-testnet`） | **不接受** | 宁可失败，避免误认 |
| 金额为数字字符串 | 接受 | 若官方只允许字符串，将来会收紧 |
| 字段命名差异 | 按别名表读取 | 别名表需随 SDK 更新 |
| 签名结尾字节为 `0` / `1` | **判 critical 失败**（比 viem 严） | 链上 `ecrecover` 只认 27/28，0/1 会返回零地址；宽松会漏掉一类必炸的载荷 |
| 高 s 签名 | **判 critical 失败** | reference facilitator 对 EOA 付款人一律拒绝；对已部署合约账户有豁免，而 C3 不查 `getCode`，因此对智能钱包会偏严 |
| ERC-6492 包裹签名 | 格式/低 s/恢复三条 **skip**，不判 pass | 恢复内层签名需要账户实现，C3 不建模；标成 pass 会给出虚假信心 |
| 载荷里的地址 | 与 C2 同：`isAddress` 严格校验（混合大小写要求校验和正确） | 抓包手工改过的地址会被拦下 |

## 明确不做

1. **不发交易、不托管资金**：`check` 与 `verify-manifest` 只发 GET，`authorize` 只离线验签，`verify` / `verify-replay` 只与本地 mock 通信。没有任何命令会广播付款或结算交易。
2. **不做安全审计**：本工具判断「协议一致性」，不判断合约是否安全、经济模型是否合理。
3. **不判断服务真实性**：能返回合规 402 不意味着服务真的提供内容、也不意味着收款方诚实；C1 也不验证清单是否真由该卖家发布。
4. **不做界面**：本期是 CLI 工具；`probes/` 若将来需要看板另立项目。
5. **C3 不查链上事实**：`nonce` 是否已用、余额是否够、代币是否支持 EIP-3009、挑战的 `extra.name/version` 是否与链上 `name()`/`version()` 一致——这四项都需要 RPC，留给 C4/C5 的实盘范围。C3 的结论边界是「载荷与挑战自洽」。
6. **判定层不采集观测**：`checkSettlementOrder` / `checkReplayIdempotency` / `checkManifestConsistency` 都是纯函数，只消费调用方注入的输入。C4 / C5 的采集由 `src/probes/settlement-order.ts` 与 `src/probes/replay.ts` 完成，C1 由 `src/probes/manifest.ts` 完成；前两者只针对内置 sandbox，第三者只做真实 HTTP 黑盒探针。接入真实 facilitator、真实缓存或链上遥测仍未实现，不会因为有了 runner 就获得这些能力。
7. **C5 不验证 nonce 的链上状态**：它只判定三次重复提交（同签名换键、同键重试、同 nonce 重签）的两尝试观测是否合规。`settled` / `upstreamCalled` / `cacheHit` 都由 runner 注入；服务端自报这些值会使结论可被伪造，观测源可信度不在判定层能力内。链上 `authorizationState` 的核验属未来 live 模式。
8. **不替代 explorer**：目录、协议演示、只读诊断由 `kite-x402-explorer` 负责；本项目只做判定。

## 来源与原创性

- 本仓库为原创实现，从空仓库初始化，未 fork 任何仓库。
- 工程实践（`/healthz` 与 `/readyz` 语义分离、结算后再返回、目录快照与退避、fail-closed 验证器注入）参考了同期 Kite x402 模板的公开文档与代码组织方式；**未复制其中代码**。
- `CarryWang/kite-x402-explorer` 与 `gokite-ai/kite_counter_dapp` 无 LICENSE 文件，其实现不作为可复用来源，本项目也未使用其代码。
- 协议依据来自公开的 x402 v2 约定、EIP-3009 与 EIP-712 规范；具体字段以实际模板响应为准，差异处已在 `docs/CHECKS.md` 的「待确认项」列出。
