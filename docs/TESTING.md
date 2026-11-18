# 测试、构建与排障

## 测试命令

```bash
npm test           # vitest run，单次执行（CI 用这个）
npm run test:watch # 监听模式，本地开发用
npm run typecheck  # tsc --noEmit，严格模式
npm run build      # 产出 dist/
npm run check      # 上面三步串起来，提交前必跑
```

当前基线：**5 个测试文件 / 100 个用例全绿**（`typecheck` 无输出即通过）。

## 覆盖场景

| 测试文件 | 覆盖点 |
|---|---|
| `test/c2-challenge.test.ts`（21） | 完整合规载荷全过；非 402；缺头；头不可解码；非 v2；网络错误；数字 chainId；地址非法；收款方不一致；未配置收款方时 skip；金额 `0` / `12.5` / `-5` / `1e6` 四种非法；`amount` 别名；`accepts` 为对象；无支付选项 |
| `test/wire.test.ts`（8） | base64 往返；裸 JSON；base64url；百分号编码；垃圾输入 fail-closed；空值；header 名大小写 |
| `test/networks.test.ts`（9） | 链 id 常量；未确证网络不伪造端点；CAIP-2 / 数字 / 字符串归一化；跨网络拒绝；缺失值 fail-closed |
| `test/c3-authorization.test.ts`（46） | 完整载荷 14 条全过；挑战缺失/不可解码/无选项；载荷缺失/不可解码；v1 载荷拒绝；`accepted` 缺失与漂移；收款方与金额不符；零地址与自转；`extra` 缺失；窗口未开始/即将过期/恰好 6 秒/倒置/按注入时刻评估；`maxTimeoutSeconds` 告警与覆盖；v=0/1；高 s；ERC-6492 skip；内容不符；域版本与 chainId 归因；字段别名与多问题上报 |
| `test/eip712.test.ts`（16） | 域分隔符与摘要对齐 viem；固定黄金值；只改 version/chainId/name 时摘要变化；结构散列逐字段敏感；签名恢复；v=0/1 与高 s 判定；长度/非 hex/越界 v 拒绝 |

**未覆盖**：真实网络请求、真实 facilitator、真实链上结算。C3 的签名是测试内用固定私钥真实生成的（不是桩），但**没有**向任何链接广播；`examples/mock-payer.ts` 也一样，只做本地 EIP-712 计算。真实结算属 C4/C5，见 `docs/CHECKS.md` 的「待确认项」。

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
