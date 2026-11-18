# 提交材料模板

每次提交给组织者时填这张表。四阶段状态**必须分开写**——登记 PR 合并、生态映射生效、commit 被抓取、开发者归因是四件不同的事。

## 1. 基本信息

| 项 | 内容 |
|---|---|
| 仓库链接 | `https://github.com/emptytouch/kite-x402-conformance` |
| 许可证 | Apache-2.0 |
| 当前版本 | `0.2.0` |
| 首次公开日期 | _YYYY-MM-DD_ |
| 本期新增 commit 区间 | `<first-sha>..<last-sha>`（`git log --oneline <range>`） |

## 2. 本期变更

| 变更 | 说明 | 关联 commit |
|---|---|---|
|  |  |  |

写法要求：一条变更一行，说清「改了什么、为什么改」，不要贴 commit message 原文。

## 3. 测试结果

```
$ npm run check
> tsc --noEmit          （无输出 = 通过）
> vitest run
 Test Files  5 passed (5)
      Tests  100 passed (100)
> tsc -p tsconfig.build.json
```

附退出码，并注明执行环境（Node 版本、操作系统）。

## 4. 运行演示

```
$ npm run example                      # 合成卖家 :8080
$ node dist/cli.js check http://localhost:8080/v1/echo
... 10 passed, 0 failed, 0 skipped     # exit=0

$ DEMO_MODE=broken PORT=8081 npm run example
$ node dist/cli.js check http://localhost:8081/v1/echo
... 1 passed, 1 failed, 1 skipped      # exit=1

$ npm run example:pay > sig.txt                       # 对挑战真实签名（本地计算）
$ node dist/cli.js authorize http://localhost:8080/v1/echo --payment-signature @sig.txt
... 14 passed, 0 failed, 0 skipped     # exit=0
```

如涉及真实 testnet 结果，另附 `docs/EVIDENCE.md` 中的对应行与交易链接。

## 5. Open Dev Data 登记状态

| 阶段 | 状态 | 证据 |
|---|---|---|
| ① 登记 PR | **已提交（OPEN，CI 通过）**，截至 2026-11-18 尚未合并 | https://github.com/electric-capital/open-dev-data/pull/3153 |
| ② 生态映射生效 | 未确认（依赖 ① 合并） | developerreport 侧截图或链接 |
| ③ Commit 抓取 | 未开始（依赖 ②） | 统计页面表现 |
| ④ 开发者归因 | 未确认（依赖 ②） | 归属页面 |

> ① 的 PR 创建于 2026-11-17，`build` 检查 19 秒通过、无冲突、无 review。②–④ 尚未发生，不能提前写成「已生效」。

## 6. 技术关联证据（供核验）

| 关联点 | 证据位置 |
|---|---|
| Kite 网络常量（2366 / 2368、CAIP-2） | `src/networks.ts` + `x402conf networks` 输出 |
| 挑战网络字段校验 | `src/checks/c2-challenge.ts` 的 `c2.network` 断言 + 对应测试 |
| x402 v2 头编解码 | `src/wire.ts` + `test/wire.test.ts` |
| 收款地址 / 资产地址校验 | `src/checks/c2-challenge.ts` 的 `c2.asset`、`c2.pay-to`、`c2.pay-to-match` |
| Kite chainId 进入 EIP-712 域 | `src/eip712.ts` 的 `eip712DomainSeparator` + `test/eip712.test.ts` 的固定黄金值 |
| EIP-3009 授权可恢复（离线 `ecrecover`） | `src/checks/c3-authorization.ts` 的 `c3.signature-recovery` + `test/c3-authorization.test.ts` |
| 签名规范性（v ∈ {27,28}、低 s） | `src/eip712.ts` 的 `parseSignature65` + `c3.signature-format` / `c3.signature-low-s` |
| 依赖 | `package.json`：`viem` 用于地址校验、EIP-712 编码与签名恢复，`zod` 用于载荷校验 |

## 7. 月度活跃台账（任务一另记）

本文件只记任务二。任务一的活跃天数按实际开发日期汇总，不拿 PR 合并日替代；两者不要混在同一张表里。

## 8. 提交前自查

- [ ] `npm run check` 全绿，输出已附
- [ ] commit 作者为本人账号（`git log --format='%an <%ae>'` 全部一致）
- [ ] 无密钥、无私钥、无 `.env`、无构建产物、无 `node_modules`
- [ ] `README.md`、「已知限制」、「证据台账」与实际实现一致
- [ ] `CHANGELOG.md` 已记录本次版本
- [ ] 演示命令可被他人原样复现
