# CLI 使用说明

本文件是命令行接口的完整说明：命令、参数、输出格式、退出码与 CI 集成方式。

## 命令总表

| 命令 | 作用 | 状态 |
|---|---|---|
| `x402conf check <url>` | 对单条端点执行 C2 检查 | 已实现 |
| `x402conf networks` | 列出内置 Kite 网络、端点与确证状态 | 已实现 |
| `x402conf decode <value>` | 解码 `PAYMENT-*` 头，用于排障 | 已实现 |
| `x402conf doctor` | 环境自检（RPC 可达、chainId、资产地址） | 未实现（W4） |

`--help`、`--version` 由 commander 提供。

## `check`

```bash
x402conf check <url> [options]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `<url>` | 必填 | 要检查的端点，例如 `http://localhost:8080/v1/echo` |
| `--network <name>` | 取 `KITE_NETWORK`，否则 `testnet` | `mainnet` 或 `testnet` |
| `--timeout <ms>` | `10000` | 单次请求超时 |
| `--expected-pay-to <address>` | 取 `KITE_EXPECTED_PAY_TO` | 设置后比较挑战里的收款地址 |
| `--json` | `false` | 输出机器可读 JSON，便于 CI 解析 |

行为约定：

- 只发一次 `GET`，带 `Accept: application/json`；不签名、不发交易、不改动服务端状态。
- 传输层失败（连不上、超时）**不**给出协议结论，直接退出码 3。
- 报告里的 `SKIP` 永远不等于通过。

### 人类可读输出

```
x402conf v0.1.0
target  http://localhost:8080/v1/echo
network eip155:2368

PASS  c2.status  HTTP status is 402
      received 402
FAIL  c2.header  PAYMENT-REQUIRED header present
      no PAYMENT-REQUIRED header on the 402 response
SKIP  c2.decode  header decodes to JSON
      no header to decode

1 passed, 1 failed, 1 skipped
skipped checks were not evaluated; they are not evidence of success
```

### JSON 输出

```json
{
  "tool": "x402conf",
  "version": "0.1.0",
  "url": "http://localhost:8080/v1/echo",
  "network": "eip155:2368",
  "summary": { "pass": 10, "fail": 0, "skip": 0, "criticalFail": 0, "warningFail": 0 },
  "results": [
    {
      "id": "c2.status",
      "title": "HTTP status is 402",
      "level": "critical",
      "status": "pass",
      "detail": "received 402"
    }
  ]
}
```

字段约定：`results[].status ∈ {pass, fail, skip}`，`results[].level ∈ {critical, warning}`。id 稳定，可用于 CI 里做白名单或趋势统计。

## `networks`

```bash
$ x402conf networks
name      chainId   caip2           verified  rpc
mainnet   2366      eip155:2366     false     (not configured)
testnet   2368      eip155:2368     true      https://rpc-testnet.gokite.ai/
```

`verified=false` 表示该网络的端点未从公开来源确证，需要 `KITE_RPC_URL` 提供；报告里也会带同样的提示。

## `decode`

```bash
$ x402conf decode "$PAYMENT_REQUIRED_HEADER"
{
  "x402Version": 2,
  "accepts": [ { "scheme": "exact", "network": "eip155:2368" } ]
}
re-encoded: eyJ4NDAyVmVyc2lvbiI6MiwiYWNjZXB0cyI6W119
```

支持 base64、base64url、百分号编码与裸 JSON 四种输入；都解不出时退出码 3 并说明原因。

## 退出码

| 码 | 含义 | CI 建议 |
|---|---|---|
| `0` | 没有失败（可能包含 skip） | 通过 |
| `1` | 存在 critical 失败 | 阻断 |
| `2` | 只有 warning 失败 | 告警，不阻断 |
| `3` | 运行时错误（配置非法、传输失败、无法解码） | 重试一次后阻断 |

## CI 集成

```yaml
- name: x402 conformance
  run: |
    npx kite-x402-conformance check "$SERVICE_URL/v1/echo" --json > x402-report.json
  # 退出码 0/1/2/3 直接作为 job 结果，无需额外判断
```

GitHub Actions 里可按退出码分流：`1` 阻断合并，`2` 发评论，`3` 重试一次再判定。完整的本地验证流程见 [TESTING.md](TESTING.md)。
