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

- **Codex CLI 0.163.0**：文本回复、shell tool 调用
- **Claude Code 2.1.308**：文本回复、Read tool 调用

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
- 文本、reasoning、tool calls 已支持；图片输入按 `image_url` 尽力透传，未做完整验证。
- `tool_choice` 暂未强制透传，模型会根据工具描述自行决定是否调用。
- 上游返回 429 / 4019 时，代理会返回对应的 429 / 403 错误，需要等待配额恢复或重新 `traecli login`。
- 本工具只适合本机个人使用，默认只监听 `127.0.0.1`，不要直接暴露到公网。

## 安全说明

- 代理不会把 access token 写入日志或响应。
- 抓包脚本会对 `authorization`、cookie 等敏感头做脱敏。
- 建议保持 `PROXY_API_KEY` 非空，尤其是在共享机器或容器中运行。
