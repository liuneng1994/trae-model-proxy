# trae-model-proxy

把 TRAE CLI 可用的模型以标准 API 暴露出来，供 Claude Code、Codex 以及其他 OpenAI / Anthropic 兼容客户端使用。

## 支持的接口

| 接口 | 客户端 | 说明 |
| --- | --- | --- |
| `GET /v1/models` | 通用 | 列出 TRAE 模型 |
| `POST /v1/chat/completions` | OpenAI SDK / 通用 agent | 支持流式与 tool calls |
| `POST /v1/responses` | Codex | OpenAI Responses API |
| `POST /v1/messages` | Claude Code | Anthropic Messages API |
| `POST /v1/messages/count_tokens` | Claude Code | 粗略 token 估算 |
| `GET /healthz` | 运维 | 登录状态、模型数量、上游地址 |

## 工作原理

```text
Claude Code ── Anthropic /v1/messages ──┐
Codex ─────── OpenAI /v1/responses ─────┼──> trae-model-proxy ──> TRAE 模型网关
OpenAI SDK ── /v1/chat/completions ─────┘
```

代理复用本机 `~/.trae/cli/auth.json` 中的 TRAE 登录凭证，把三种客户端协议转换成 TRAE 的 `llm_raw_chat` 协议，并处理流式文本、reasoning 和 tool calls。

## 环境要求

- Node.js >= 20（本机验证版本为 Node 26）
- 已安装并登录 TRAE CLI：`traecli login`
- 能访问 `copilot-cn.bytedance.net`

## 启动

```bash
cd trae-model-proxy
npm start
```

默认监听 `127.0.0.1:8787`。

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/v1/models
```

## 一键安装部署

```bash
cd trae-model-proxy
npm run install:all
```

会依次：

1. 检查 Node.js >= 20 和 `traecli login` 状态
2. 缺少 `codex` / `claude` 时安装到 `~/.local`
3. 配置 Codex 和 Claude Code
4. 安装并启动用户级后台服务
5. 等待 `/healthz` 通过

自定义参数：

```bash
npm run install:all -- --model trae/GPT-5.4 --effort medium --port 8787
npm run install:all -- --no-service      # 只配置客户端
npm run install:all -- --no-clients      # 只安装服务
npm run install:all -- --replace         # 停止占用端口的旧进程
```

服务管理：

```bash
npm run service:status
npm run service:start
npm run service:stop
npm run service:restart
npm run service:uninstall
```

- macOS：`~/Library/LaunchAgents/com.trae.model-proxy.plist`
  - 日志：`~/Library/Logs/trae-model-proxy.log`、`~/Library/Logs/trae-model-proxy.err.log`
- Linux：`~/.config/systemd/user/trae-model-proxy.service`
  - 日志：`journalctl --user -u trae-model-proxy -f`
- 不需要 sudo，服务以当前用户身份运行，登录后自动启动。

## 一键配置 Codex 和 Claude Code

```bash
cd trae-model-proxy
npm run setup
```

默认会：

- 写入 `~/.codex/config.toml`，注册 `trae_proxy` provider
- 合并写入 `~/.claude/settings.json` 的 `env`
- 默认模型 `trae/Seed-2.1-Turbo`
- 默认推理强度 `high`
- 修改前自动备份原配置

自定义模型和推理强度：

```bash
npm run setup -- --model trae/GPT-5.4 --effort medium
npm run setup -- --model trae/DeepSeek-V4.1-Flash --small-model trae/DeepSeek-V4-Flash
```

只配置其中一个：

```bash
npm run setup:codex
npm run setup:claude
```

预览或卸载：

```bash
npm run setup -- --dry-run
npm run setup:uninstall
```

如果设置了代理 API key：

```bash
npm run setup -- --api-key my-secret
# Codex 需要按提示 export TRAE_PROXY_API_KEY=my-secret
```

支持的选项：

| 选项 | 说明 |
| --- | --- |
| `--model <id>` | 两个客户端使用的模型 |
| `--small-model <id>` | Claude Code 的 small/fast 模型 |
| `--effort low\|medium\|high` | 推理强度 |
| `--base-url <url>` | 代理地址，默认 `http://127.0.0.1:8787` |
| `--api-key <key>` | 可选的代理 API key |
| `--codex-only` / `--claude-only` | 只配置一个客户端 |
| `--uninstall` | 移除代理配置 |
| `--dry-run` | 只打印，不写文件 |
| `--force` | 覆盖冲突的 Codex 顶层配置 |

## 在 /model 中选择模型

Codex 和 Claude Code 都支持通过 `/model` 切换模型：

- **Codex**：setup 脚本会生成 `~/.codex/trae-models.json`，并写入 `model_catalog_json`。Codex 的 `/model` 会直接列出 TRAE 模型，不依赖代理在线刷新。
- **Claude Code**：setup 脚本会写入 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`，Claude Code 会请求代理的 `/v1/models`。代理会暴露两类 ID：
  - `claude-trae-<模型名>`，例如 `claude-trae-Seed-2.1-Turbo`；
  - Claude Code 能识别的别名：`claude-opus-4-6` → GPT-6.1-Sol、`claude-sonnet-4-5` → Seed-2.1-Turbo、`claude-sonnet-4-6` → GPT-5.6-Sol、`claude-haiku-4-5` → DeepSeek-V4-Flash。

  使用 `claude-trae-*` 时 Claude Code 会提示 `unrecognized model` 并假设 200k 上下文，但调用正常；使用上面的别名不会出现该警告。
- 推理强度：Codex 使用 `model_reasoning_effort`；Claude Code 使用 `MAX_THINKING_TOKENS` / `output_config.effort`；OpenAI 客户端使用 `reasoning_effort`。

## 自动刷新模型目录

代理会按 `TRAE_MODEL_REFRESH_MS`（默认 5 分钟）自动调用 `traecli models --json`：

- 刷新内存中的模型列表；
- 模型有变化时自动更新 `~/.codex/trae-models.json`；
- Codex 下次读取模型目录（新会话或重新打开 `/model`）即可看到新模型；
- `POST /v1/models/refresh` 可手动触发；
- `TRAE_MODEL_REFRESH_MS=0` 可关闭定时刷新；
- `PROXY_SYNC_CODEX_CATALOG=0` 只刷新内存，不写 Codex 文件。

## 排队信息

TRAE 上游在排队或限流时会发送 `progress_notice` 事件。代理会：

- 在代理日志中打印排队消息；
- Codex：通过 `response.in_progress(status="queued")` 和 reasoning summary 展示；
- Claude Code：在 thinking 块中展示 `[TRAE queue] ...`；
- OpenAI Chat：在 `reasoning_content` 中展示 `[TRAE queue] ...`。

实时查看排队进度：

```bash
curl http://127.0.0.1:8787/v1/queue
curl -N http://127.0.0.1:8787/v1/queue/stream
```

`/healthz` 也会返回最近的 `queue` 状态。

## 客户端配置

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=local-proxy
export ANTHROPIC_MODEL=trae/Seed-2.1-Turbo
export ANTHROPIC_SMALL_FAST_MODEL=trae/DeepSeek-V4-Flash
```

如果设置了 `PROXY_API_KEY`，把 `ANTHROPIC_AUTH_TOKEN` 改成对应的值。

### Codex

`~/.codex/config.toml`：

```toml
model = "trae/Seed-2.1-Turbo"
model_provider = "trae_proxy"

[model_providers.trae_proxy]
name = "TRAE Proxy"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
env_key = "TRAE_PROXY_API_KEY"
```

```bash
export TRAE_PROXY_API_KEY=local-proxy
```

### OpenAI SDK / 其他 agent

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="local-proxy",
)
```

## 已验证

本机验证通过：

- **Codex CLI 0.163.0**：文本回复、shell tool 调用、reasoning summary、`/model` 目录
- **Claude Code 2.1.308**：文本回复、Read/Bash tool 调用、图片 tool_result、thinking/effort、`/model` 发现、`count_tokens`、自动 compact

Codex：

```bash
CODEX_HOME=/tmp/codex-trae-proxy \
TRAE_PROXY_API_KEY=local-proxy \
codex exec -s read-only "Reply with exactly: CODEX_OK"
```

Claude Code：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_AUTH_TOKEN=local-proxy \
ANTHROPIC_MODEL=trae/Seed-2.1-Turbo \
claude -p "Reply with exactly: CLAUDE_OK"
```

Claude Code 对自定义模型会提示 `unrecognized model` 并按 200k 上下文处理，这是客户端的模型元数据提示，不影响调用。需要工具调用时加 `--allowedTools "Read"` 等参数。

## 工具调用与推理

- `tool_choice` 支持 `auto` / `none` / `required` / 指定工具。由于 TRAE 上游会拒绝原生 `tool_choice` 字段，代理会把它转换成系统指令，再交给模型执行。
- Responses API 会透传模型的 `reasoning`，输出 `response.reasoning_summary_text.delta/done`；Codex 设置 `model_reasoning_summary = "detailed"` 即可看到。
- Anthropic 的 `thinking` / `output_config.effort`、OpenAI 的 `reasoning_effort` 都会映射到上游的 `reasoning_effort`。
- Anthropic 的 `cache_control` 会在 system / tool_result 文本块上保留。

## 自动 compact

Claude Code 的 auto-compact 会通过 `/v1/messages` 发送一个“只输出文本、不要调用工具”的总结请求。代理会按普通请求处理，把总结返回给 Claude Code，然后继续下一轮。

已用 mock 上游验证完整链路：大上下文 → compact 请求 → summary 响应 → 第二个问题继续。测试使用 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`，避免真实消耗 100k+ tokens。

## 测试

```bash
npm test
```

当前覆盖 SSE 分片解析、三种协议的请求转换、模型/别名解析、Codex 目录生成、429 重试、队列解析、指标和安全比较。

## 可观测性

```bash
curl http://127.0.0.1:8787/healthz        # 登录、模型数、目录同步、最近队列状态
curl http://127.0.0.1:8787/metrics        # Prometheus 文本指标
curl http://127.0.0.1:8787/v1/queue       # 当前排队状态
curl -N http://127.0.0.1:8787/v1/queue/stream  # 排队进度 SSE
curl -X POST http://127.0.0.1:8787/v1/models/refresh
npm run doctor                        # 代理、Codex、Claude 配置体检
```

- 每个响应带 `x-request-id`。
- `PROXY_LOG_FORMAT=json` 可输出 JSON 日志。
- 非 loopback 监听且未设置 `PROXY_API_KEY` 时会拒绝启动，除非显式设置 `PROXY_ALLOW_INSECURE_BIND=1`。

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PROXY_HOST` | `127.0.0.1` | 监听地址 |
| `PROXY_PORT` | `8787` | 监听端口 |
| `PROXY_API_KEY` | 空 | 非空时要求客户端携带 Bearer / x-api-key |
| `TRAE_DEFAULT_MODEL` | `DeepSeek-V4.1-Flash` | 未指定 model 时的默认模型 |
| `TRAE_CHAT_URL` | `https://copilot-cn.bytedance.net/api/ide/v2/llm_raw_chat` | TRAE 模型网关地址 |
| `TRAE_ACCESS_TOKEN` | 空 | 覆盖 `auth.json` 中的 access token |
| `TRAE_AUTH_FILE` | `~/.trae/cli/auth.json` | TRAE 登录凭证路径 |
| `TRAECLI_BIN` | `traecli` | 用于读取模型目录 |
| `PROXY_REQUEST_TIMEOUT_MS` | `300000` | 上游请求超时 |
| `TRAE_MAX_ATTEMPTS` | `3` | 上游 429/5xx 最大尝试次数 |
| `TRAE_RETRY_BASE_MS` | `500` | 重试退避基数 |
| `TRAE_RETRY_MAX_MS` | `10000` | 单次重试最大等待 |
| `TRAE_MODEL_REFRESH_MS` | `300000` | 模型目录自动刷新间隔，0 关闭 |
| `PROXY_SYNC_CODEX_CATALOG` | `1` | 是否自动写 Codex 模型目录 |
| `PROXY_CODEX_CATALOG_PATH` | `~/.codex/trae-models.json` | Codex 模型目录路径 |
| `PROXY_QUEUE_KEEPALIVE_MS` | `15000` | 排队 SSE 心跳间隔 |
| `PROXY_LOG_FORMAT` | `text` | `text` 或 `json` |
| `PROXY_ALLOW_INSECURE_BIND` | `0` | 允许非 loopback 且无 API key 启动 |
| `PROXY_VERBOSE` | `0` | 输出调试日志 |

## 协议抓包（开发用）

`scripts/capture.mjs` 可以把 TRAE CLI 的请求转发到本地抓包服务并记录到 `captures/`：

```bash
node scripts/capture.mjs
TRAE_API_BASE_URL=http://127.0.0.1:8788 traecli exec -m Seed-2.1-Turbo "reply OK"
```

抓包文件包含完整 prompt 和工具定义，已加入 `.gitignore`，不要提交到仓库。

## 已知限制

- TRAE 的 `llm_raw_chat` 是内部协议，TRAE CLI 升级后可能需要重新抓包调整字段。
- 文本、reasoning、tool calls、图片 tool_result 已支持（上游要求图片至少 14px）；普通文档/PDF 内容未做转换。
- `tool_choice` 会转换成系统指令，不是原生上游字段；强制工具调用的确定性弱于原生支持。
- `/v1/messages/count_tokens` 是启发式估算，不是精确 tokenizer。
- Access token 过期后需要手动执行 `traecli login`，代理不会自动刷新。
- 上游返回 429 / 5xx 会自动重试；4019 等风控错误不会重试。
- 本工具只适合本机个人使用，默认只监听 `127.0.0.1`，不要直接暴露到公网。

## 安全说明

- 代理不会把 access token 写入日志或响应。
- 抓包脚本会对 `authorization`、cookie 等敏感头做脱敏。
- 建议保持 `PROXY_API_KEY` 非空，尤其是在共享机器或容器中运行。
