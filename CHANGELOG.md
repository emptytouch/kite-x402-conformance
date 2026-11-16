# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Planned

- C3：EIP-712 域构造与 EIP-3009 签名可恢复性检查（W2）
- C4：结算时序检查——无签名不转发、上游 4xx/5xx 不结算、成功返回收据（W2）
- C5：重放与幂等检查（W3）
- C1：与 `service.yaml` / `.well-known/x402` 的清单一致性比对（W3）
- `--pay` 实盘模式与 `docs/EVIDENCE.md` 首条 live 记录（W4）
- `doctor` 环境自检（W4）
- `--reporter=junit` 与退出码在 CI 模板中的示例（视需求）

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
