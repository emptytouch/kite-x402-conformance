# 真实运行证据台账

记录**真实 testnet** 上的可核验结果。规则只有三条：

1. **不得编造**。任何一行都必须对应一次真实执行，交易哈希必须能在区块浏览器打开。
2. **区分模式**：`dry-run` 表示只读取 402 挑战、未签名未转账；`live` 表示发生了真实结算。
3. **没有证据就留空**。空表是可接受的，假记录不可接受。

## 当前状态

截至 `0.2.0` 及后续的 C1 / C4 / C5 增量：**尚无 live 记录**。C3 是离线的签名可恢复性检查——不发送交易、不读取链上状态。C4 / C5 已补上 sandbox 探针执行层（`x402conf verify` / `verify-replay`），但它们启动的是独立 mock upstream / facilitator / cache 与仓库内置合成卖家，不连真实服务、不读链。C5 的「重新签名」是本地标记模拟的同 nonce 另一份载荷，不读链上 `authorizationState`。`--pay` 仍未实现，工具当前不具备采集真实结算证据的能力，因此本表只有 dry-run / sandbox 记录。

`0.2.0` 新增一条 dry-run 记录（C3），见下表；它证明的是「载荷与挑战自洽」，不是「链上结算成功」。C1 通过只意味着「在给定清单与观测下声明一致」，C4 通过只意味着「在 sandbox 观测下时序正确」，C5 通过只意味着「在 sandbox 观测下三场景的重复提交都没有二次扣款」——清单是否真实、观测本身是否来自真实结算，本版本无法自证。

## sandbox 验证（不是 live 证据）

`2026-11-24` 在 Node `v22.22.2` / Windows 上实测，命令与输出如下（构建产物 `node dist/cli.js`）：

```bash
$ node dist/cli.js verify
12 passed, 0 failed, 0 skipped        # exit=0

$ node dist/cli.js verify --defect forged-claim
11 passed, 1 failed, 0 skipped        # exit=1；失败项 c4.upstream-success.settled

$ node dist/cli.js verify-replay
13 passed, 0 failed, 0 skipped        # exit=0

$ node dist/cli.js verify-replay --defect idem-cached-rebill
10 passed, 3 failed, 0 skipped        # exit=1；失败项 c5.idempotency.cached / no-rebill / no-forward
```

`verify --defect forged-claim` 是**负对照**：合成卖家返回了一个带合法 tx hash 的 `PAYMENT-RESPONSE`，但 mock facilitator 没有收到任何 `/settle` 调用。`c4.upstream-success.receipt` 因此通过，而 `c4.upstream-success.settled` 失败——这证明判定用的是 mock 日志，不是卖家自报头。七种模式（含 `none`）的失败断言对照表见 `docs/CHECKS.md`。

C5 的负对照更有针对性：`idem-no-cache` 的响应里写着 `x-c5-cache-claim: hit`，但独立 cache 日志里没有任何 `GET`，runner 判为未命中并让 `cached` / `no-rebill` / `no-forward` 失败；`idem-cached-rebill` 则真的命中缓存却仍结算并转发，runner 把原始冲突记入 `sandbox.contradictions` 后规范化观测，三条断言照常失败。八种模式（含 `none`）的失败断言对照表见 `docs/CHECKS.md`。

这里的 tx hash `0xabab…` 是固定合成值，对应任何链上交易都不成立；`--json` 报告里的 `sandbox.captures` 是本地 mock 请求日志，不是链上收据。**这一节不构成真实结算证据，也不改变『尚无 live 记录』的结论。**

## 记录模板

| 日期 | 目标服务 | 网络 | 模式 | 结论 | 交易哈希 | 备注 |
|---|---|---|---|---|---|---|
| 2026-11-16 | `http://localhost:8080/v1/echo`（合成卖家） | eip155:2368 | dry-run | C2 10/10 通过 | — | 示例数据，非真实服务 |
| 2026-11-18 | `http://localhost:8080/v1/echo`（合成卖家 + `mock-payer`） | eip155:2368 | dry-run | C3 14/14 通过 | — | 签名为本地计算，私钥为公开测试键，未广播 |
| _YYYY-MM-DD_ | _https://…_ | _eip155:2368_ | _dry-run / live_ | _x passed_ | _0x…（live 必填）_ | _执行人_ |

## 填写要求

- **live 记录**必须同时给出：交易哈希、区块浏览器链接、执行者 GitHub 账号、执行命令原文。
- **dry-run 记录**必须给出完整命令与退出码。
- 失败结果同样要记（`结论` 写实际失败项），失败记录比成功记录更有说服力。
- 每次记录后同步更新 `CHANGELOG.md` 的对应版本说明。

## 相关命令

```bash
# dry-run（只读挑战，不转账）
node dist/cli.js check https://<target>/v1/<endpoint> --json

# sandbox（本地 mock + 合成卖家，不是真实结算）
node dist/cli.js verify --json
node dist/cli.js verify-replay --json

# 未来 live 模式的调用形式（当前版本未实现，勿使用）
# node dist/cli.js check https://<target>/v1/<endpoint> --pay
```
