# 测试、构建与排障

## 测试命令

```bash
npm test           # vitest run，单次执行（CI 用这个）
npm run test:watch # 监听模式，本地开发用
npm run typecheck  # tsc --noEmit，严格模式
npm run build      # 产出 dist/
npm run check      # 上面三步串起来，提交前必跑
```

当前基线：**10 个测试文件 / 222 个用例全绿**（`typecheck` 无输出即通过）。其中 C1 判定层 29 个、C4 判定层 24 个、C5 判定层 31 个、C4 sandbox runner 与 CLI 契约 18 个、C5 sandbox runner 与 CLI 契约 20 个。

## 覆盖场景

| 测试文件 | 覆盖点 |
|---|---|
| `test/c2-challenge.test.ts`（21） | 完整合规载荷全过；非 402；缺头；头不可解码；非 v2；网络错误；数字 chainId；地址非法；收款方不一致；未配置收款方时 skip；金额 `0` / `12.5` / `-5` / `1e6` 四种非法；`amount` 别名；`accepts` 为对象；无支付选项 |
| `test/wire.test.ts`（8） | base64 往返；裸 JSON；base64url；百分号编码；垃圾输入 fail-closed；空值；header 名大小写 |
| `test/networks.test.ts`（9） | 链 id 常量；未确证网络不伪造端点；CAIP-2 / 数字 / 字符串归一化；跨网络拒绝；缺失值 fail-closed |
| `test/c3-authorization.test.ts`（46） | 完整载荷 14 条全过；挑战缺失/不可解码/无选项；载荷缺失/不可解码；v1 载荷拒绝；`accepted` 缺失与漂移；收款方与金额不符；零地址与自转；`extra` 缺失；窗口未开始/即将过期/恰好 6 秒/倒置/按注入时刻评估；`maxTimeoutSeconds` 告警与覆盖；v=0/1；高 s；ERC-6492 skip；内容不符；域版本与 chainId 归因；字段别名与多问题上报 |
| `test/eip712.test.ts`（16） | 域分隔符与摘要对齐 viem；固定黄金值；只改 version/chainId/name 时摘要变化；结构散列逐字段敏感；签名恢复；v=0/1 与高 s 判定；长度/非 hex/越界 v 拒绝 |
| `test/c4-settlement-order.test.ts`（24） | 四探针全合规 12 条全过；无签名被转发/被结算；错误签名被转发/被结算/返回非 402；上游 4xx/5xx 结算（核心亏损场景）；上游 2xx/3xx 冒充失败探针时 no-settle 必须 skip 而非空绿；上游 2xx 未结算；收据缺失或返回非 200；tx hash 顶层与嵌套别名、大小写、坏 hash/占位/不可解码 fail-closed；空串别名与坏包装不遮蔽合法 hash、原型键不生效；矛盾布尔量/状态码整体拒绝；非字符串头值不崩溃；探针缺失/重复/字段非法；上游未触达的 skip 级联；skip 不被误报为 pass |
| `test/settlement-order-runner.test.ts`（18） | 真实 HTTP 起三个本地服务跑四探针；良性模式 12/12 且观测值来自 mock 日志；六种缺陷模式各自的失败断言精确匹配；`forged-claim` 与 `none` 收据相同但结算判定相反（信任边界反证）；captures 不跨探针重复；非法 defect / timeout；`isSandboxDefect` 拒绝继承键；CLI 位置参数假绿回归、`--defect` 退出码与 JSON |
| `test/replay-runner.test.ts`（20） | 真实 HTTP 起四个本地服务跑三场景×两次尝试；良性 13/13 且观测只来自 mock 日志；七种缺陷各自失败项精确匹配；场景顺序隔离（首次不被其他场景签名污染）；`idem-no-cache` 自报命中但 cache 日志无 `GET` 的反证；`idem-cached-rebill` 矛盾规范化 + `sandbox.contradictions` 原始证据；`forged-claim` 与 `first-not-settled` 收据行为对照；captures 按场景与尝试归属；非法 defect / timeout（含溢出上界）；`isC5Defect` 拒绝继承键；CLI 位置参数假绿回归、`--defect` 退出码与 JSON |

**未覆盖**：真实网络请求、真实 facilitator、真实链上结算。C3 的签名是测试内用固定私钥真实生成的（不是桩），但**没有**向任何链接广播；`examples/mock-payer.ts` 也一样，只做本地 EIP-712 计算。C4 / C5 runner 确实通过 HTTP 调用了 mock upstream / facilitator / cache，但被测卖家是仓库内置的合成实现（见 `src/sandbox/seller.ts` 与 `src/sandbox/replay-seller.ts`），没有测任何真实服务。真实结算、链上收据核验与接真实服务的观测采集均未实现，见 `docs/CHECKS.md` 与 `docs/LIMITATIONS.md`。

**非假绿验证**：在临时副本上做变异测试（改动后跑同一套测试，不碰工作树）——移除 C5 矛盾规范化、移除 seller 重放守卫、恢复 facilitator 单一合法签名、关闭 CLI 位置参数拒绝、去掉矛盾注入、把场景状态改回全局共享，每种变异都有对应测试变红，恢复后全绿。其中「场景状态改回全局共享」来自独立复审发现的真实缺陷：原实现的三场景共用一份签名集合，正确性依赖 `SCENARIO_PLAN` 的顺序，调换顺序会让后续场景的首次尝试被误判为重放并返回 402；现按场景隔离并有顺序独立性回归测试。

## 干净环境复现

CI 在 `ubuntu-latest` + Node 22 上只做四件事：`npm ci` → `typecheck` → `test` → `build`，最后加一个 `node dist/cli.js --version` 冒烟。步骤与本地完全一致，不依赖任何本机状态。

本地复现干净环境：

```bash
rm -rf node_modules dist
npm ci
npm run check
```

## 构建与发布

```bash
npm run build            # dist/（含 .d.ts 与 sourcemap）
npm pack --dry-run       # 先看清单，确认不含 .env / 密钥 / 测试产物
npm publish --access public
```

发布检查清单：

- [ ] `npm run check` 全绿
- [ ] `CHANGELOG.md` 已写本次版本
- [ ] `npm pack --dry-run` 输出里只有 `dist/`、文档、`LICENSE`、`.env.example`
- [ ] `git status` 干净，`git log` 作者为本人账号
- [ ] 打 tag 后再发布，tag 与 `package.json` 版本一致

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `x402conf: command not found` | 未安装或未 `npm link` | 用 `node dist/cli.js …` 或 `npx tsx src/cli.ts …` |
| 退出码 `3`，提示 `request failed` | 目标不可达 / 超时 | 先 `curl -i` 同 URL，确认服务在跑；这不是协议结论 |
| 退出码 `3`，提示 `invalid configuration` | 环境变量格式错误（如地址不是 0x 开头） | 按提示改 `.env`；地址必须通过 `isAddress` |
| 退出码 `1`，只有 `c2.header` 红 | 服务返回 402 但没带 `PAYMENT-REQUIRED` | 用 `curl -i` 看响应头；这是被检查方的问题 |
| 退出码 `1`，`c2.network` 红 | 挑战里写错链（如 mainnet 写成 testnet） | 加 `--network` 对齐，或让对方修 |
| `SKIP` 很多 | 前置断言失败导致后续未执行 | 先修第一条 fail，skip 会自然消失 |
| `npm run example` 端口占用 | 8080 已被占用 | `PORT=8090 npm run example`，并按新端口调 `check` |
| Windows 下 `tsx` 报编码错误 | 控制台编码 | 用 `chcp 65001` 或直接在 Git Bash 里跑 |
| `typecheck` 报 `Cannot find module './x.js'` | ESM 下导入必须带 `.js` 扩展名 | 源码内的相对导入一律写 `.js` |

## CI 之外的手工验证

改完 CLI 输出或退出码，建议手工跑一次完整演示（不要只看单测）：

```bash
npm run build
npm run example &                                   # 合成卖家 :8080
node dist/cli.js check http://localhost:8080/v1/echo
DEMO_MODE=broken PORT=8081 npm run example &        # 坏样本 :8081
node dist/cli.js check http://localhost:8081/v1/echo; echo "exit=$?"
```

预期：第一个 `10 passed / exit=0`，第二个 `1 passed, 1 failed / exit=1`。
