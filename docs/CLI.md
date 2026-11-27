# CLI 使用说明

本文件是命令行接口的完整说明：命令、参数、输出格式、退出码与 CI 集成方式。

## 命令总表

| 命令 | 作用 | 状态 |
|---|---|---|
| `x402conf check <url>` | 对单条端点执行 C2 检查 | 已实现 |
| `x402conf authorize [url]` | 对一份 `PAYMENT-SIGNATURE` 载荷执行 C3 检查 | 已实现 |
| `x402conf verify` | 对内置 sandbox 卖家执行 C4 四探针结算时序检查 | 已实现（仅 sandbox） |
| `x402conf verify-replay` | 对内置 sandbox 卖家执行 C5 三场景重放/幂等检查 | 已实现（仅 sandbox） |
| `x402conf verify-manifest` | 解析独立清单并对真实端点发 402 探针，执行 C1 清单一致性检查 | 已实现（真实 HTTP 黑盒，非 live） |
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
x402conf v0.2.0
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
  "version": "0.2.0",
  "command": "check",
  "target": "http://localhost:8080/v1/echo",
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

字段约定：`results[].status ∈ {pass, fail, skip}`，`results[].level ∈ {critical, warning}`。id 稳定，可用于 CI 里做白名单或趋势统计。`command` 与 `target` 在 `check` / `authorize` 两个命令间一致，`target` 是 URL 或 `challenge:<path>`。

> `0.1.0` 的 `check` JSON 用 `url` 字段；`0.2.0` 起统一为 `target` 并新增 `command`。两个字段一次性替换，未保留旧名以避免同一份报告里出现两套键。

## `authorize`

```bash
x402conf authorize [url] --payment-signature <value|@path> [options]
```

校验「客户按这份挑战签出来的 `PAYMENT-SIGNATURE`，能不能真的结算」。14 条断言全部离线完成：不签名、不发交易、不连 RPC。

| 参数 | 默认 | 说明 |
|---|---|---|
| `[url]` | — | 从该端点取 402 挑战；与 `--challenge` 二选一 |
| `--payment-signature <value>` | 必填 | 头部原值；`@path` 表示从文件读取（便于处理长值） |
| `--challenge <path>` | — | 用已保存的挑战（base64 头值或裸 JSON）代替在线获取 |
| `--network <name>` | 取 `KITE_NETWORK`，否则 `testnet` | `mainnet` 或 `testnet` |
| `--timeout <ms>` | `10000` | 取挑战时的请求超时 |
| `--now <unixSeconds>` | 当前时间 | 用指定时刻评估有效期窗口 |
| `--min-validity <seconds>` | `6` | 要求的最小剩余有效期 |
| `--max-window <seconds>` | 取挑战的 `maxTimeoutSeconds`，否则 `3600` | 剩余可重放时间的告警上限 |
| `--json` | `false` | 输出机器可读 JSON |

### `--now` 为什么必须存在

抓包得到的载荷，过几分钟就自然过期了。如果窗口永远按系统时钟评估，任何对历史载荷的重跑都会在 `c3.window` 上失败，离线校验就没法在 CI 里做。`--now` 把评估时刻变成显式输入，同时也让「过期」这件事本身可以被测试。

### 两种数据来源

```bash
# 在线：现取挑战，现验载荷（挑战与载荷必须来自同一个报价）
x402conf authorize http://localhost:8080/v1/echo --payment-signature @sig.txt

# 离线：挑战与载荷都来自文件，完全不联网
x402conf authorize --challenge challenge.txt --payment-signature @sig.txt --now 1700000000
```

离线模式是 CI 的主力用法：把一次真实运行的挑战与载荷存成夹具，之后每次改代码都重跑同一份证据。

### 人类可读输出

```
$ x402conf authorize http://localhost:8080/v1/echo --payment-signature @sig.txt

x402conf v0.2.0
target  http://localhost:8080/v1/echo
network eip155:2368

PASS  c3.domain-config  EIP-712 domain is derivable from the challenge
      name="Demo USD" version="1" chainId=2368
PASS  c3.signature-recovery  signature recovers to the authorising payer
      recovers to 0x70997970C51812dc3A010C7d01b50e0d17dc79C8, matching authorization.from
...
14 passed, 0 failed, 0 skipped
```

失败时的输出会直接给出归因，而不是只说「不匹配」：

```
FAIL  c3.signature-recovery  signature recovers to the authorising payer
      signature recovers to 0x3f1c…, not to 0x7099…. It does recover under
      version="2" chainId=2368 — the payload was signed against a different
      EIP-712 domain than the challenge advertises
```

### JSON 输出

在 `check` 的字段基础上多一个 `evaluatedAt`（实际用于窗口判定的 unix 秒），其余结构相同。

## `verify`

```bash
x402conf verify [options]
```

在**内置 sandbox** 中执行 C4 的四个结算时序探针，输出 12 条断言。sandbox 由三个本地 HTTP 服务组成：独立 mock upstream、独立 mock facilitator，以及作为被测对象的合成 seller。`upstreamCalled` / `settled` 取自 mock 请求日志，**不采信 seller 自报头**。

| 参数 | 默认 | 说明 |
|---|---|---|
| `--defect <mode>` | `none` | 注入一个结算缺陷，取值见下表 |
| `--timeout <ms>` | `5000` | 单个请求超时 |
| `--json` | `false` | 输出机器可读 JSON，附原始 mock 日志 |

命令不接受位置参数：`verify free-access` 会被拒绝并返回退出码 3，不会静默退化成默认模式。

`--defect` 取值：

| 值 | 注入的缺陷 | 预期失败断言 |
|---|---|---|
| `none` | 无 | 无 |
| `free-access` | 无签名也转发并结算 | `c4.unsigned.*` 三条 |
| `forged-signature` | 错误签名也放行 | `c4.invalid-signature.*` 三条 |
| `charge-on-error` | 上游 503 仍结算 | `c4.upstream-error.no-settle` |
| `skip-settlement` | 上游 2xx 不结算 | `c4.upstream-success.settled` / `receipt` |
| `bad-receipt` | 结算了但收据 hash 非法 | `c4.upstream-success.receipt` |
| `forged-claim` | 没结算却自报合法收据 | `c4.upstream-success.settled` |

```bash
$ x402conf verify
...
PASS  c4.upstream-success.settled  upstream 2xx is settled
PASS  c4.upstream-success.receipt  200 with PAYMENT-RESPONSE txHash 0xabab…
12 passed, 0 failed, 0 skipped

$ x402conf verify --defect charge-on-error
...
FAIL  c4.upstream-error.no-settle  upstream returned 503 but settlement happened
11 passed, 1 failed, 0 skipped
# exit=1
```

`--json` 在 `check` 的结构上多出 `sandbox` 对象：

```json
{
  "command": "verify",
  "target": "sandbox:charge-on-error",
  "network": "eip155:2368",
  "sandbox": {
    "defect": "charge-on-error",
    "endpoints": { "seller": "http://127.0.0.1:…", "upstream": "http://127.0.0.1:…", "facilitator": "http://127.0.0.1:…" },
    "observations": [{ "probe": "upstreamError", "responseStatus": 503, "upstreamCalled": true, "upstreamStatus": 503, "settled": true, "settlementStatus": 200 }],
    "captures": { "upstreamError": { "upstream": [ … ], "facilitator": [ … ] } }
  },
  "summary": { "pass": 11, "fail": 1, "skip": 0, "criticalFail": 1, "warningFail": 0 }
}
```

`captures` 是两个 mock 的原始请求日志，可独立复核观测来源。`target` 前缀 `sandbox:` 且报告中的提示行会写明「mock upstream + mock facilitator, no real chain, no funds」——**这不是真实结算证据**。

`verify` 不读取任何环境变量（包括 `KITE_*`）；每次运行都绑定临时端口并在结束时关闭全部服务。CI 用法：

```bash
x402conf verify --json > x402-c4-report.json
x402conf verify --defect forged-claim --json > x402-c4-negative-control.json   # 期望 exit=1
```

## `verify-replay`

```bash
x402conf verify-replay [options]
```

在**内置 sandbox** 中执行 C5 的三个重放场景，每个场景两次真实 HTTP 请求，输出 13 条断言。sandbox 由独立 mock upstream、mock facilitator、独立 mock cache 与有状态合成 seller 组成。`settled` / `upstreamCalled` / `cacheHit` 分别取自 facilitator / upstream / cache 的请求日志；seller 响应中的 `x-c5-cache-claim` 只是证据，不参与判定。

| 参数 | 说明 |
|---|---|
| `--defect <mode>` | 注入一种重放缺陷：`none`（默认）、`nonce-rebill`、`idem-no-cache`、`idem-cached-rebill`、`nonce-reuse-bypass`、`bad-receipt`、`forged-claim`、`first-not-settled` |
| `--timeout <ms>` | 每次请求的超时，默认 5000，必须是正整数且在 Node 定时器范围内 |
| `--json` | 输出机器可读报告，含 `sandbox.captures` / `observations` / `contradictions` |

命令不接受位置参数：`verify-replay idem-no-cache` 返回退出码 3，不会静默降级成 `none`。

```bash
$ x402conf verify-replay
...
13 passed, 0 failed, 0 skipped   # exit=0

$ x402conf verify-replay --defect idem-cached-rebill
FAIL  c5.idempotency.cached
FAIL  c5.idempotency.no-rebill
FAIL  c5.idempotency.no-forward
10 passed, 3 failed, 0 skipped   # exit=1
```

`--json` 的 `command` 为 `verify-replay`，`sandbox` 对象结构：

```json
{
  "command": "verify-replay",
  "sandbox": {
    "defect": "idem-cached-rebill",
    "endpoints": { "seller": "…", "upstream": "…", "facilitator": "…", "cache": "…" },
    "observations": ["…"],
    "captures": { "nonceReplay": { "first": { "upstream": [], "facilitator": [], "cache": [] }, "second": {} } },
    "contradictions": [
      { "scenario": "idempotencyKey", "attempt": "second", "cacheHitRaw": true, "settled": true, "upstreamCalled": true }
    ]
  }
}
```

`captures` 按场景与尝试分别存放三组 mock 日志，每行只属于一次尝试。`contradictions` 记录「缓存命中却仍结算/转发」的原始冲突；runner 把该次观测规范化为 `cacheHit: false`，让三条亏钱断言照常失败。若没有这个规范化，整组场景会被判定层当作非法输入、其余断言全部 skip。

`verify-replay` 不读取任何环境变量；每次运行绑定临时端口并在结束时关闭全部服务（即使其中一个关闭失败也会尝试其余服务）。CI 用法：

```bash
x402conf verify-replay --json > x402-c5-report.json
x402conf verify-replay --defect forged-claim --json > x402-c5-negative-control.json   # 期望 exit=1
```

这是 sandbox 证据：没有真实 facilitator、没有链上交易、不读取 `authorizationState`，不构成 live 结算证据。

## `verify-manifest`

```bash
x402conf verify-manifest --manifest <path> --base-url <url> [options]
x402conf verify-manifest --manifest-url <url> --base-url <url> [options]
```

对**真实端点**执行 C1：从独立来源读清单，对清单声明的每个 path 发一次 `GET`，用实际响应的状态码与 `PAYMENT-REQUIRED` 头生成观测，再与声明逐项比对。输出 12 条 `c1.*` 断言。

| 参数 | 默认 | 说明 |
|---|---|---|
| `--manifest <path>` | — | 本地清单文件，来源标为 `static-file`；与 `--manifest-url` 二选一且必须选一个 |
| `--manifest-url <url>` | — | 远程清单，仅当路径严格为 `/.well-known/x402` 且与 `--base-url` 不同 origin 时标为 `well-known`，否则 `unknown` |
| `--base-url <url>` | 必填 | 被测服务的 origin，清单里的 path 按原字符串拼接到它后面 |
| `--timeout <ms>` | `10000` | 单次请求超时，同时用于拉取远程清单与每个探针 |
| `--source <source>` | 自动判定 | 显式断言来源：`static-file` / `well-known` / `unknown`；与自动判定不符则退出码 3 |
| `--json` | `false` | 输出机器可读 JSON，附解析后的清单与逐路径探针记录 |

命令不接受位置参数：`verify-manifest manifest.json` 返回退出码 3，不会静默降级。

**来源独立性。** 清单来自被测服务自己的挑战回显时，比对是同义反复，不能算通过。因此：

- 本地文件标 `static-file`，可直接判定；
- 远程清单必须同时满足「路径为 `/.well-known/x402`」且「与被测端点不同 origin」，才标 `well-known`；
- `localhost` 与 `127.0.0.1` / `[::1]` 视为同一台机器，不能拿它俩互相当独立来源；
- 其余情况标 `unknown`，C1 的来源断言 skip，命令退出码 3（不是 0）；
- `--source` 只能确认 runner 的判定，不能把 `unknown` 升级成 `well-known`。

**清单格式。** 接受 JSON 与受限 YAML（无锚点、无多行块、无流式集合）：

```yaml
endpoints:
  - path: /v1/echo
    network: eip155:2368
    payTo: "0x1234567890123456789012345678901234567890"
    asset: "0x0f5d2fb29fb7d3cfee444a200298f468908cc942"
    amount: "1000"
```

字段规则与 `docs/CHECKS.md` 的判定层契约一致：path 以 `/` 开头且不能逃逸 `--base-url` 的 origin；地址为 `0x` + 40 hex；金额为原子单位、无前导零的十进制整数**字符串**。JSON number 与 YAML 裸数字金额一律拒绝——`JSON.parse` 可能已悄悄改写大于 2^53 的值。YAML 中纯数字形式的 `network`（如 `2368`）也必须加引号；`eip155:2368` 可以不加。UTF-8 BOM、行尾注释与无缩进序列可接受。

**探针语义。**

- 每个 path 顺序发一次 `GET`（`redirect: manual`，`Accept: application/json`），只解码这次真实响应；清单里自报的「观测值」与服务端自报的结算 / 缓存字段都不参与判定。
- 返回非 402、或 402 但没有 `PAYMENT-REQUIRED` 头，是**有效观测**：runner 用固定占位值保持判定层输入合法，由 `c1.challenge-shape` 明确失败，后续值级断言 skip，避免占位值制造假 mismatch 或空洞通过。
- 头存在但解不出 JSON、解出的文档没有支付选项、缺必需支付字段、或金额 / 链 id 在 `JSON.parse` 阶段已变成 unsafe number，属于 **runner 错误**：退出码 3，不输出 conformance 结论。
- 连接失败、超时、DNS 错误同样是 runner 错误（退出码 3）。「没连上」不是「清单不一致」。

```bash
$ x402conf verify-manifest --manifest manifest.json --base-url http://localhost:8080
...
PASS  c1.network-match   declared and observed networks agree
PASS  c1.amount-match    declared and observed amounts agree
12 passed, 0 failed, 0 skipped        # exit=0
```

`--json` 在 `check` 的结构上增加 `manifest` 对象：

```json
{
  "command": "verify-manifest",
  "target": "http://localhost:8099",
  "network": "eip155:2368",
  "manifest": {
    "source": "static-file",
    "baseUrl": "http://localhost:8099",
    "entries": [{ "path": "/v1/echo", "network": "eip155:2368", "payTo": "0x1234…", "asset": "0x0f5d…", "amount": "1000" }],
    "probes": [{
      "path": "/v1/echo",
      "status": 402,
      "hasPaymentRequired": true,
      "entry": { "path": "/v1/echo", "responseStatus": 402, "hasPaymentRequired": true, "network": "eip155:2368", "payTo": "0x1234…", "asset": "0x0f5d…", "amount": "1000" }
    }]
  },
  "summary": { "pass": 12, "fail": 0, "skip": 0, "criticalFail": 0, "warningFail": 0 }
}
```

顶层的 `network` 字段是 JSON 报告共有的展示位（此处为 `eip155:2368`），**清单来源只在 `manifest.source`**。C1 的网络判定使用清单与观测里的 `network`，不受这个展示字段影响。

出口码有一处 C1 专属规则：`source === "unknown"` 或「0 pass 且存在 skip」时退出 3，避免一份全是 skip 的报告被 CI 当作通过。其余按 0/1/2/3 通用契约。

```bash
x402conf verify-manifest --manifest manifest.json --base-url https://api.example.com --json > x402-c1-report.json
x402conf verify-manifest --manifest-url https://docs.example.org/.well-known/x402 \
  --base-url https://api.example.com --json > x402-c1-wellknown-report.json   # 期望 exit=0
```

**边界。** 这是真实 HTTP 黑盒探针：证明的是「清单写的」与「服务实际返回的 402 挑战」是否一致。它不发付款、不结算、不读链上状态，不验证清单是否真的由该卖家发布或签名，因此**不是 live 结算证据**，也不替代 C2 / C3 / C4 / C5。

## `networks`

```bash
$ x402conf networks
name      chainId   caip2           verified  rpc
mainnet   2366      eip155:2366     false     (not configured)
testnet   2368      eip155:2368     true      https://rpc-testnet.gokite.ai/
```

`verified=false` 表示该网络的端点未从公开来源确证。设置 `KITE_RPC_URL` 后，它会覆盖**当前网络**（`KITE_NETWORK`）那一行的 rpc 显示，并附一行说明：

```
$ KITE_RPC_URL=https://rpc.example/rpc x402conf networks
...
KITE_RPC_URL overrides rpc for testnet; it is not used for chain calls in 0.2.0
```

本版本不发起链上调用，所以这个覆盖值仅用于显示；不要把「填了 RPC」理解成「已经上链核验」。

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
| `3` | 运行时错误（配置非法、传输失败、无法解码、`verify` / `verify-replay` / `verify-manifest` 参数非法；`verify-manifest` 的清单解析失败、`source=unknown`、或只有 skip 没有 pass） | 重试一次后阻断 |

## CI 集成

```yaml
- name: x402 conformance
  run: |
    npx kite-x402-conformance check "$SERVICE_URL/v1/echo" --json > x402-report.json
  # 退出码 0/1/2/3 直接作为 job 结果，无需额外判断
```

GitHub Actions 里可按退出码分流：`1` 阻断合并，`2` 发评论，`3` 重试一次再判定。完整的本地验证流程见 [TESTING.md](TESTING.md)。
