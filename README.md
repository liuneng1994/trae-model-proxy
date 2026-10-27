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
| `GET /healthz` | 运维 | 就绪检查；登录或模型目录不可用时返回 503 |
| `GET /v1/capabilities` | 通用 | 当前代理支持的能力和兼容性限制 |

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
- 默认主模型 `trae/GPT-6.1-Sol-max`
- 默认使用模型目录中的 max variant，并把真实 max context 配置给 Claude Code
- 默认推理强度 `xhigh`
- Claude auto mode 使用客户端 classifier，不探测 TRAE 上游不支持的 server-side classifier
- 默认 subagent、teammate 和 workflow agent 继承主会话模型；`/model` 切换后不再固定使用另一模型
- 使用 fullscreen TUI、auto memory 和 700K auto-compact window
- 启用 `aws-serverless`、`frontend-design` 两个已安装的官方插件
- 修改前自动备份原配置

自定义模型和推理强度：

```bash
npm run setup -- --model trae/GPT-5.4 --effort medium
npm run setup -- --model trae/DeepSeek-V4.1-Flash --small-model trae/DeepSeek-V4.1-Flash
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

新安装会写入私有的 `.trae-model-proxy-install.json` 清单。卸载仅恢复仍由代理管理的配置值，保留安装后用户自行修改的值、其他 hooks 和权限。已有冲突配置需要显式 `--force`；旧版本没有安装清单时，应从 `.bak.*` 手动恢复，不能推断原配置。

如果设置了代理 API key，推荐通过环境变量传入，避免密钥出现在命令行参数和 shell 历史中：

```bash
export TRAE_PROXY_API_KEY=my-secret
npm run setup
```

`--api-key` 仍兼容，但不推荐；配置预览会脱敏密钥。

支持的选项：

| 选项 | 说明 |
| --- | --- |
| `--model <id>` | 两个客户端使用的主模型 |
| `--subagent-model <id>` | 默认 `inherit`，继承主会话模型；只有显式指定 ID 时使用独立子模型 |
| `--small-model <id>` | Claude Code 的 small/fast 模型 |
| `--effort low\|medium\|high\|xhigh\|max` | 推理强度 |
| `--no-max` | 使用标准 `__dev` variant，不切换到 `max_key` |
| `--context-window <tokens>` | 覆盖 Claude Code 的上下文窗口探测值 |
| `--base-url <url>` | 代理地址，默认 `http://127.0.0.1:8787` |
| `--api-key <key>` | 可选的代理 API key |
| `--codex-only` / `--claude-only` | 只配置一个客户端 |
| `--uninstall` | 移除代理配置 |
| `--dry-run` | 只打印，不写文件 |
| `--force` | 覆盖冲突的 Codex 顶层配置 |

## 在 /model 中选择模型

Codex 和 Claude Code 都支持通过 `/model` 切换模型：

- **Codex**：setup 脚本会生成 `~/.codex/trae-models.json`，并写入 `model_catalog_json`。Codex 的 `/model` 会直接列出 TRAE 模型，不依赖代理在线刷新。
- **Claude Code**：setup 脚本会写入 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`，Claude Code 会请求代理的 `/v1/models`。代理会暴露五类 ID：
  - `claude-trae-<模型名>`，例如 `claude-trae-Seed-2.1-Turbo`；
  - `claude-trae-<模型名>-max[1m]`，供 Claude `/model` 发现并选择 Max；
  - `trae/<模型名>`，显式路由到模型目录的 standard backend；
  - `trae/<模型名>-max`，例如 `trae/GPT-5.6-Sol-max`；这类 ID 会路由到模型目录的 `max_key`；
  - Claude Code 能识别的别名：`claude-opus-4-6` → GPT-6.1-Sol、`claude-sonnet-4-5` → Seed-2.1-Turbo、`claude-sonnet-4-6` → GPT-5.6-Sol、`claude-haiku-4-5` → DeepSeek-V4-Flash。

  setup 默认选择 `trae/<模型名>-max`，并按目录中的 `max_context_window` 写入
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，避免 Claude Code 对自定义模型按 200K 提前 compact。
  不支持 max 的模型继续使用标准 backend 和标准窗口。
- 支持 max 的每个模型都会以 `claude-trae-<模型名>-max[1m]` 出现在 Claude
  `/model` 中；精确的 `trae/<模型名>` / `trae/<模型名>-max` ID 可用于配置文件
  和命令行。setup 会为 standard、Max 和精确路由 ID 分别写入正确的
  `autoCompactWindow`。`[1m]` 用于绕过 Claude Code 对自定义 `claude-*` ID 的
  200K cap，实际 compact 上限仍按 TRAE 目录的 800K/1M 窗口计算。
- Claude Code 可能把自定义模型名规范化成 `claude-gpt-5-6-sol-max` 或追加 `[1m]` 后缀；代理会自动归一化并映射回对应的 TRAE 模型。
- `npm run setup` 会清除旧的 `~/.claude/cache/gateway-models.json`，避免 `/model` 继续显示旧的 provider 标签（例如 `Coconut ...`）。
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
export ANTHROPIC_MODEL=trae/GPT-6.1-Sol-max
export ANTHROPIC_SMALL_FAST_MODEL=trae/DeepSeek-V4.1-Flash-max
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=800000
```

如果设置了 `PROXY_API_KEY`，把 `ANTHROPIC_AUTH_TOKEN` 改成对应的值。

### Codex

`~/.codex/config.toml`：

```toml
model = "trae/GPT-6.1-Sol"
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
ANTHROPIC_MODEL=trae/GPT-6.1-Sol-max \
claude -p "Reply with exactly: CLAUDE_OK"
```

Claude Code 对自定义模型会提示 `unrecognized model` 并按 200k 上下文处理，这是客户端的模型元数据提示，不影响调用。需要工具调用时加 `--allowedTools "Read"` 等参数。

## 工具调用与推理

- `tool_choice` 支持 `auto` / `none` / `required` / 指定工具。由于 TRAE 上游会拒绝原生 `tool_choice` 字段，代理会把它转换成系统指令，再交给模型执行。
- Responses API 会透传模型的 `reasoning`，输出 `response.reasoning_summary_text.delta/done`；Codex 设置 `model_reasoning_summary = "detailed"` 即可看到。
- Anthropic 的 `thinking` / `output_config.effort`、OpenAI 的 `reasoning_effort` 都会映射到上游的 `reasoning_effort`。
- Anthropic 的 `cache_control` 会在 system / tool_result 文本块上保留。
- Responses 支持 namespace 函数工具和 Codex `custom` / freeform 工具：上游以 `{input: string}` 函数传递，客户端接收 `custom_tool_call` 和原始输入；代理不执行补丁或 shell，也不原生校验 Lark grammar。

## 自动 compact

Claude Code 的 auto-compact 会通过 `/v1/messages` 发送一个“只输出文本、不要调用工具”的总结请求。代理会按普通请求处理，把总结返回给 Claude Code，然后继续下一轮。

已用 mock 上游验证完整链路：大上下文 → compact 请求 → summary 响应 → 第二个问题继续。测试使用 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`，避免真实消耗 100k+ tokens。

Anthropic usage 中的 `input_tokens` 只包含未缓存输入，已缓存部分单独放在
`cache_read_input_tokens` / `cache_creation_input_tokens`；代理会从 TRAE 返回的总
`prompt_tokens` 中扣除这两项，避免 Claude Code 重复计算上下文并提前 compact。

## 缓存与 subagent 会话

默认 subagent/workflow 使用 `inherit` 跟随主会话模型，辅助 classifier 默认使用
DeepSeek-V4.1-Flash Max。代理保留客户端提供的合法 `cache_control`（`ephemeral`，可选
`ttl: 5m/1h`），覆盖 system、普通 user/assistant 文本、图片、工具结果及工具定义；
不会自动添加断点，也不能保证 TRAE 原生支持某个 TTL。

工具参数和结构化输出 schema 使用稳定的对象键序列化；数组、消息和工具列表仍保持
客户端原始顺序。这样不会因为等价 JSON 对象的属性插入顺序不同而改变工具 schema。

会话标识优先使用 `x-session-id` / `x-claude-code-session-id`，conversation 优先使用
`x-conversation-id` / `x-thread-id`；也支持 `metadata.session_id/conversation_id/thread_id/agent_id`。
子 thread 标识优先于共享父 session。同一请求重试以及代理内搜索多轮复用这些 ID。
没有可靠标识时每次请求生成独立 ID，不根据 prompt、user ID 或父任务 ID 猜测共享会话。
本机 Claude Code 已观察到发送 `x-claude-code-session-id`。TRAE 缓存池字段未实证启用，
因此代理不发送猜测的 `parent_session_id/use_prompt_cache_pool/prompt_cache_key`。

缓存观测：

- 日志 `upstream.usage`：每次上游用量、cache read/write 和读取比例。
- 日志 `request.done.usage`：同一次客户端请求中所有上游轮次的总用量。
- `/metrics`：`proxy_input_tokens_total`、`proxy_output_tokens_total`、
  `proxy_cache_read_tokens_total`、`proxy_cache_write_tokens_total` 和
  `proxy_usage_reports_total`，按 model/variant/protocol 区分。
- token 级命中比例为 cache-read 总量 / input 总量，不等于请求命中率，也不代表跨模型
  能共享缓存。没有上游 usage 时不伪造用量。日志不保存 prompt、工具内容或会话 ID。

可用合成上下文测量真实缓存效果（需要 TRAE 登录，会消耗模型额度）：

```bash
npm run test:live-cache
# 可选：CACHE_TEST_MODELS=trae/GPT-6.1-Sol-max npm run test:live-cache
```

测试比较带/不带断点、重复请求、新会话、等价 schema 和继承上下文；结果写入临时
JSON 文件。它是小样本观测，不是严格随机 A/B 实验，耗时包括上游调度及生成，不能
单凭耗时下降证明缓存优化。默认 `npm test` 不运行此测试。

## Claude auto mode

TRAE 的 `llm_raw_chat` 不实现 Anthropic 的 `safeguards` / `safeguard_results`
协议，因此无法提供 Anthropic server-side classifier 的免计费能力。`npm run setup`
会按照 [Claude Code 官方建议](https://code.claude.com/docs/en/auto-mode-classifier-billing)
设置 `CLAUDE_CODE_AUTO_MODE_SERVER=0`：auto mode 继续正常
工作并直接使用 Claude Code 客户端 classifier，同时避免每个新会话先进行一次必然失败的
server-side classifier 探测和兼容性提示。客户端 classifier 仍会调用模型，因此 `npm run setup`
同时设置 `CLAUDE_CODE_AUTO_MODE_MODEL` 和 `CLAUDE_CODE_BG_CLASSIFIER_MODEL` 指向本地
small/fast 模型（默认 `trae/DeepSeek-V4.1-Flash-max`），避免验证请求占用主模型额度。

`/auto-mode-setup` 和 Claude Code hooks 会使用结构化输出。代理会把客户端提供的
JSON Schema 转成系统指令，由模型按 schema 输出 JSON；这是模拟实现，不是上游原生能力。

## Anthropic Web Search

代理接受 `web_search_20250305` 工具定义并在代理端执行工具循环，返回
`server_tool_use` / `web_search_tool_result`，不会将服务端工具交给客户端执行。

**默认使用 TRAE 自带搜索**，复用本机 TRAE 登录凭证，无需第三方 API key。
搜索调用 `https://copilot-cn.bytedance.net/api/ide/v1/web_search`，请求为
`{user_input: query}`，把返回的 `references`（`uri/title/snippets`）转换成搜索结果。
已用公开文档查询验证真实“模型调用 → TRAE 搜索 → 继续回答”的流式链路。

可选配置：

- `TRAE_WEB_SEARCH_URL`：覆盖 TRAE 搜索地址（测试或其他网关）。
- `PROXY_WEB_SEARCH_PROVIDER=disabled`：禁止实际搜索，调用返回 `tool_unavailable`。
- `PROXY_WEB_SEARCH_URL`：改用你信任的自定义搜索服务，优先于默认 TRAE 后端。
- `PROXY_WEB_SEARCH_API_KEY`：自定义后端可选 Bearer key；不会向其发送 TRAE 凭证。
- 自定义接口接受 `POST` JSON：`{query, max_results, allowed_domains, blocked_domains, user_location}`。
- 自定义接口返回 `{results: [{url, title, content}]}`，其中 `content` 可用 `snippet` 替代。

查询会发送给选择的搜索后端，可能消耗 TRAE 额度。代理在结果侧检查域名限制，
不保证搜索引擎只检索这些域名；TRAE 当前不支持精确 `user_location`，带该设置的
搜索调用返回 `invalid_input`，不静默忽略。搜索失败返回 `tool_unavailable`，不伪造结果。
结果摘录以进程内密钥加密后返回，重启后旧摘录无法解密，但 URL/title 仍可保留。
当前是兼容实现，不提供原生 Anthropic citation、搜索计费或动态过滤；带 Web Search
的流式请求按模型轮次缓冲文本，搜索期间发送 ping。

## 测试

```bash
npm test
```

测试包括 SSE 的 LF/CRLF/CR 和 UTF-8 分片、协议请求与流式/非流式响应、模型 Standard/Max 元数据、凭证过期、截断/限流/超时、HTTP 鉴权与参数验证，以及隔离配置的部署生命周期测试。所有默认测试使用本地 mock，不调用真实 TRAE 上游。

本机已安装 Claude Code 和 Codex 时，可额外运行客户端测试：

```bash
npm run test:clients
```

该测试使用临时客户端配置和本地 mock 上游，验证实际客户端文本和工具往返，不修改真实用户配置。客户端版本不同可能需要调整工具契约；mock 通过不能证明真实上游支持所有模型和参数。

显式执行真实 TRAE 搜索验证（需要登录，会发送公开文档查询并可能消耗模型额度）：

```bash
npm run test:live-search
```

覆盖直接搜索、非流式和流式“模型 → 搜索 → 回答”链路。默认 `npm test` 跳过真实上游和本机客户端测试。

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
| `PROXY_API_KEY` | 空 | 非空时除 `/healthz` 和 OPTIONS 外，所有接口要求 Bearer / x-api-key |
| `TRAE_DEFAULT_MODEL` | `DeepSeek-V4.1-Flash` | 未指定 model 时的默认模型 |
| `TRAE_MAX_MODE` | `1` | 旧别名/裸模型名默认路由到 max variant；显式 `trae/<模型>` 始终为 standard，`trae/<模型>-max` 始终为 Max |
| `TRAE_CHAT_URL` | `https://copilot-cn.bytedance.net/api/ide/v2/llm_raw_chat` | TRAE 模型网关地址 |
| `TRAE_ACCESS_TOKEN` | 空 | 覆盖 `auth.json` 中的 access token |
| `TRAE_AUTH_FILE` | `~/.trae/cli/auth.json` | TRAE 登录凭证路径 |
| `TRAECLI_BIN` | `traecli` | 用于读取模型目录 |
| `PROXY_REQUEST_TIMEOUT_MS` | `300000` | 整个生成请求超时 |
| `TRAE_UPSTREAM_HEADERS_TIMEOUT_MS` | `30000` | 等待上游响应头超时；与整体请求超时取较小值 |
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
- 上游返回 429 / 5xx 会在未输出内容时自动重试，并遵循有上限的 `Retry-After`；输出后出错不重试。未收到 `done` 的截断流返回错误，不会伪装成功。
- Responses 输出达到 token 上限时返回 `status: incomplete`、`incomplete_details.reason: max_output_tokens`；流式发送 `response.incomplete`。
- 采样参数（`temperature` / `top_p` 等）、`n > 1`、Responses 服务端历史/存储及除 Anthropic Web Search 外的 hosted tools 未实现；明确返回 400，不再静默忽略。结构化输出使用系统指令模拟，并非原生 schema 保证。
- stop 序列（`stop` / `stop_sequences`，最多 4 个）由代理在输出侧模拟：命中第一个序列后截断文本，Anthropic 返回 `stop_reason: "stop_sequence"`，OpenAI 返回 `finish_reason: "stop"`。
- reasoning/thinking 是上游推理文本的兼容摘要，不是 Anthropic 原生签名 thinking。
- 本工具只适合本机个人使用，默认只监听 `127.0.0.1`，不要直接暴露到公网。

## macOS 锁屏与休眠恢复

锁屏本身不会停止 LaunchAgent，但系统休眠会暂停进程和网络。`KeepAlive` 只能重启退出的进程，不能恢复暂停期间已经失效的请求。

代理检测到 30 秒以上的执行间隔时，会取消旧请求并记录 `runtime.resumed`，客户端需要重新发起请求；不会重放已输出的内容。上游请求使用非复用连接，等待响应头默认最多 30 秒，降低唤醒后旧连接卡住的影响。`/healthz.runtime` 返回活动请求数和最近恢复记录。长时间事件循环阻塞也会触发这项保护，它不是原生 macOS 唤醒通知。

排查时先运行：

```bash
curl --max-time 10 http://127.0.0.1:8787/healthz
npm run service:status
```

若需清理当前运行进程中的旧连接，可运行 `npm run service:restart`（会中断正在进行的请求）。已运行的服务不会自动加载源码改动，更新后需要重启。真实锁屏/休眠恢复仍需在本机验证；本地 mock 只能验证取消和重连逻辑。

## 安全说明

- 代理不会把 access token 写入日志或响应。
- 抓包脚本会对 `authorization`、cookie 等敏感头及敏感 query 参数做脱敏；目录为 0700，文件为 0600。请求/响应 body 仍包含原始 prompt、工具参数及可能的业务敏感信息，不会自动脱敏。
- 建议保持 `PROXY_API_KEY` 非空，尤其是在共享机器或容器中运行。
