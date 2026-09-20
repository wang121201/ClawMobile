# ClawMobile Filter/Router Proxy

本目录提供一个零第三方依赖的 Node.js 22 服务。它向 OpenClaw 暴露兼容 OpenAI Chat
Completions 的应用程序编程接口（Application Programming Interface，API），用于隔离测试
工具过滤器（Filter）、请求级路由器（Router）和最终智能体模型（Agent Model）。

大语言模型（Large Language Model，LLM）在当前实验中有三个逻辑角色；同一个物理模型可以承担
多个角色，但每次服务请求必须显式标记角色：

- **Filter/Router Decision LLM**：FreeInference `deepseek-v4-flash`，只输出下一工具预测和参数复杂度；它是
  当前 Decision 能力上限条件。
- **Cloud Agent LLM**：FreeInference `deepseek-v4-flash`，生成真正的 Agent 回复或 Tool Call。它与
  Decision LLM 使用相同服务模型，但请求正文和观测标记彼此隔离。
- **Local Agent LLM**：这是实验中的逻辑角色，不等同于物理部署位置。`qwen3-8b` 由 XMU
  本地推理服务承载；`qwen3.6-35b` 由 FreeInference API 承载，在对应 Router 实验臂中只承担
  `local_agent` 逻辑角色。后者不是物理本地模型，采集和报告必须同时保留 FreeInference Provider
  身份与逻辑角色，不能写成 XMU 或物理 Local。

Tool Schema 是请求 `tools[]` 中原始的函数名称、描述和参数定义。Final 表示真正进入
Agent Loop 的模型响应；Decision helper 只预测，不执行工具，也不生成工具参数。

## 虚拟模型

| 虚拟模型 | 严格行为 |
| --- | --- |
| `cloud-full` | 完整原始请求和完整 Tool Schema 直接交给 Cloud Agent LLM。 |
| `local-full` | 完整原始请求和完整 Tool Schema 直接交给所配置的 Local Agent 逻辑角色；物理 Provider 可为 XMU 或远程 API。 |
| `filter` | Decision LLM 预测工具白名单；只从原始 `tools[]` 中筛选对应 Schema，Cloud Agent LLM 执行 Final。 |
| `router` | 历史 G4-R0：Decision LLM 每个 request 独立预测参数类别；`NO_ARGS`/`SIMPLE_ARGS` 交给 Local Agent LLM，`COMPLEX_ARGS` 交给 Cloud Agent LLM；只用于复现历史基线。 |
| `router-r1` | G4-R1：Decision LLM 只预测有限 `RouteClass`；静态策略仅允许一个空参数、只读观察 Tool 进入 Local Agent，Local 输出违反同一合同则在执行前回退 Cloud。 |
| `router-r2` | G4-R2：在 R1 合同上增加一个受新鲜同-cell `dumpId` 约束的 `android_ui_query` 能力；任何状态失效、依赖不明或合同违规均回退 Cloud。 |
| `router-rm` | G4-RM：DSV4预测中等规模Action Class；观察、grounded query、具有新鲜selected-center证据的tap和有界web search可进入Local，`android_shell`/`adb_shell`/`exec`及持久化、验证、恢复保持Cloud。 |
| `router-rm-scoped` | G4-RM-SC：保留8个有限RouteClass与预测后artifact guard，但Local只看到SC-v1 scoped context；本实验只允许observe、grounded query和grounded tap三类走Local，web保持Cloud。 |
| `router-fsm-scoped` | G4-FSM-SC（R2-FSM）：与G4-RM-SC共享模型、RouteClass、Exact Tool、Validator和SC-v1；唯一增量是预测前动态admissible RouteClass及Accepted Local Tool Result后的确定性transition/handoff。 |
| `router-fsm-scoped-repair` | G4-FSM-SC-Repair：在FSM+SC-v1上增加Standard Moderate Repair；只允许确定性规范化等价参数、绑定唯一新鲜dump/query证据或由唯一clickable/enabled中心编译tap坐标，完整重验后才执行。 |
| `router-fsm-scoped-repair-cloud-first` | FSM-SC-Repair的Cloud-first首个UI mutation实验变体。 |
| `router-fsm-scoped-repair-c1` / `router-fsm-scoped-repair-c2` | Route-Flex历史机制暴露变体；只用于对应冻结配置。 |
| `router-binary-tool` | DSV4二元`LOCAL_UI_CANDIDATE|CLOUD_REQUIRED`入口；Local生成Exact Tool，Proxy再确定性推导RouteClass并完整验证。 |
| `router-binary-tool-effect-aware` | Binary Tool的argument-aware UI-effect state maintenance变体。 |
| `router-binary-tool-effect-aware-strong-path-check` | Effect-aware变体加一次有界Cloud Strong-Path checkpoint。 |
| `router-explicit-binary-tool` | 不调用模型Router；由确定性FSM×Exact-Tool capability policy选择Cloud或一个精确Local Tool。 |
| `experiment` | 固定的 OpenClaw 实验入口；实际允许值以 `src/config.js` 导出的 `EXPERIMENT_STRATEGIES` 为唯一枚举，入站与采集中的 `virtual_model` 始终保持 `experiment`。 |

上表策略是同一 `experiment` 入口可选择的互斥进程配置，运行时枚举必须与 `EXPERIMENT_STRATEGIES`
逐字节一致。历史 `router` 在报告中显示为 G4-R0，但原始 arm/group ID
不重写。R1/R2 仍保持每 request 决策；它们不维护跨 cell 的可变 FSM。每次请求都只从同一
`result.run_id` 的可见消息历史确定性投影 `phase`、最新 observation/query 工件、工件新鲜度和
`pending_reobserve`。这个投影用于静态授权、拒绝和审计，不由 Decision LLM 自由生成。

`experiment` 解决 OpenClaw 一个 Agent Loop 只能使用一个默认模型的问题：所有 cell 都配置
`clawmobile-router/experiment`，每个独立 Proxy 进程再通过环境变量选择一个且仅一个实际策略。
`CLAW_ROUTER_ACTIVE_STRATEGY` 不会覆盖显式请求的虚拟模型。
显式虚拟模型在该变量缺失时仍可启动；`experiment` 在变量缺失时返回明确的配置错误，变量存在但不是
允许枚举中的策略之一时 Proxy 拒绝启动。

## Decision helper 协议

Filter 与 Router 使用相同 Prompt、`temperature=0`、动态 JSON Schema 和最多两次的严格
重试。输入包含：

- `<complete_request_context_json>`：除 `tools` 外的完整原请求；
- `<available_tools_json>`：未经改写的完整 `tools[]`；
- `tool_count`：可用工具定义数量。

模型响应必须严格且仅包含：

```json
{"k":3,"tools":["android_ui_dump","android_tap","android_screenshot"],"args_class":"SIMPLE_ARGS"}
```

`k` 必须等于 `tools.length`，工具名必须来自原始 Tool Schema，且 `args_class` 只能为：

- `NO_ARGS`：预期下一次 Tool Call 的规范化参数是空对象 `{}`；
- `SIMPLE_ARGS`：所有关键参数非空，可从当前上下文复制或确定性推导，不依赖新的设备状态；
- `COMPLEX_ARGS`：需要状态相关 handle、selector、坐标、自由形式命令、复合或批处理操作。

当没有工具或 `tool_choice` 明确为 `none` 时，helper 无合法意义，Proxy 记录 bypass 并使用
Cloud Full。

### R1/R2 有限 RouteClass 协议

R1/R2 不复用历史 `args_class` 作为 Local 权限。Decision LLM 只根据调用前的原始 request、完整
Tool Schema 和确定性 route-state 投影返回有限 JSON；静态代码拥有最终授权权：

- R1：`EVIDENCE_LOCAL` 或 `CLOUD`；Local 只允许恰好一个
  `android_screenshot {}`、`adb_screenshot {}`、`android_ui_dump {}` 或
  `adb_ui_dump_xml {}`。
- R2：除 R1 外可返回 `GROUNDED_QUERY_LOCAL`；只允许恰好一个 `android_ui_query`，且其
  `dumpId` 必须逐字匹配本 cell 最新且未被 mutation 失效的 dump 工件，selector 必须属于冻结字段。
- 无效 JSON、未知类别、状态/依赖不满足、Local Provider 错误或 Local Tool/schema 违规，全部在 Tool
  执行前使用完整原请求回退 Cloud。
- Decision、Local Agent 和 Cloud Agent 使用同一 `result.run_id`，但物理 Provider session 按角色隔离。

因此 R1/R2 的研究对象是“有限责任是否可安全委托”，而不是让 DSV4 自由生成 FSM、Tool 或权限。
R2 也不授权 tap、type、shell、持久化、恢复、权威验证或完成责任。

### RM-scoped 与 FSM-scoped 协议

两个新策略都使用同一个SC-v1 compiler，只改变Local输入，不改写Router看到的完整Request，也不改写Cloud fallback的原始Request。两者的Local集合固定为：

- `OBSERVE_UI_RAW` → `android_screenshot`、`adb_screenshot`、`android_ui_dump`或`adb_ui_dump_xml`；
- `QUERY_UI_GROUNDED` → 仅`android_ui_query`，并逐字绑定fresh `dump_id`；
- `INTERACT_UI_GROUNDED` → 仅`android_tap`或`adb_tap`，坐标必须等于fresh query的selected center且目标可点击、启用。

`RETRIEVE_WEB_BOUNDED`、持久化、shell/exec、恢复、权威验证和完成在这次配对实验中均保持Cloud。这不是声称qwen3.6永远不能处理它们，而是为了让本轮只测FSM控制这一变量。

`router-fsm-scoped`额外执行两步确定性控制：

1. 每个Request从已可见messages重建phase与fresh artifact，然后把当前允许的RouteClass子集直接写入DSV4 helper的严格JSON Schema；
2. Validator接受Local Tool Call后，以`result.run_id + tool_call_id`保存pending transition；下一Request必须出现匹配Tool Result并建立预期target phase。失败、缺失、错配或未类型化Result会消费该expectation，并把下一Request强制交给Cloud。

pending transition不跨`result.run_id`共享。它保存在唯一Proxy进程内存中；实验期间Proxy重启因此属于基础设施失败，不允许静默恢复。capture保存admissible set、SC-v1版本、pending/resolved transition、handoff原因和原始Tool Call ID，便于从raw evidence复算。

## 控制变量

Proxy 首先保存不可变的原始请求。Filter Final 只允许物理 `model` 与 `tools` 子集不同；
Router Final 只允许物理 `model/provider` 不同。Decision Prompt 和 Decision Response 都不会写回
Agent transcript。

Router 选择 Local 后会先缓冲非流式 JSON，验证 OpenAI Tool Call 合同；Local 无效、超时或
不可用时，才用完整原请求 fallback 到 Cloud。若原请求要求流式输出，通过验证的 Local JSON
会由 Proxy 合成标准 Server-Sent Events（SSE，服务器发送事件）。

`parameter_schema_subset_v1` 是 Router Local 参数校验级别：它逐个检查非空且唯一的 Tool Call
ID、允许的函数名、JSON 对象参数，以及旧 L1 实验 445 个真实入站请求中 32,485 份工具定义实际
使用的冻结 JSON Schema 子集（类型、必填项、枚举、常量、对象属性与额外属性、`anyOf`、正则属性、
数组/字符串/数值边界）。遇到不支持的 Schema 关键字或任何参数违规时必须 fail closed 并使用完整
原请求回退 Cloud。这个术语不表示实现了完整 JSON Schema 标准；成功的 Local 路径在响应头、路由
事件和派生响应中记录精确的 `validation_level=parameter_schema_subset_v1`。

该边界可由 `scripts/audit-parameter-schema-corpus.mjs <formal-corpus-root>` 重算；冻结语料路径、
选择规则、计数、关键字清单和所选请求记录 SHA-256 保存在
`parameter-schema-corpus-manifest.json`。Manifest 只证明历史真实请求覆盖面；运行时仍对任何未知
关键字 fail closed，不能把历史覆盖面当成未来 Schema 永远不变的假设。
有 Tool Call 时记录 `parameter_schema_applied=true`；合法的无 Tool Call 文本仍记录同一验证器版本，
但明确标记 `parameter_schema_applied=false`，不得把它计入参数 Schema 通过分母。

上述缓冲、合同验证和 JSON→SSE 合成只属于 `router` 的 Local 候选路径。`local-full`（包括
`experiment` 激活 `local-full`）保留入站 `stream` 与 `stream_options`，并原样中继上游响应，
不套用 Router adapter，也不产生 `local_agent_downstream` 派生响应记录。

## 完整模型调用采集

设置 `CLAW_ROUTER_CAPTURE_PATH` 后，每次请求、每次 helper retry、Cloud/Local Final、fallback
和 Local JSON→SSE 合成都写入同一 JSON Lines（JSONL，每行一个 JSON 对象）文件。记录包括：

- 完整入站请求；
- 实际发送到物理模型的请求和模型 ID；
- HTTP status 与脱敏 headers；
- 原始 Response 文本、Base64、字节数与 SHA-256；
- JSON 或 SSE 解析结果；
- SSE chunk 顺序和相对时间；
- request ID、角色、route、attempt、总延迟、HTTP 响应头延迟与首个响应 body chunk 延迟；历史兼容字段
  `ttft_ms` 仅是 `response_headers_elapsed_ms` 的别名，`ttft_semantics` 明确标记其不是真实首 token 时间；
- 原始 request/messages/tools/generation parameters 的 SHA-256。

## 会话与调用角色标记

实验会话（session）指一个任务从提交到结束的完整 Agent Loop；Agent 轮次（turn）指 OpenClaw
向本 Proxy 发起的一次 Chat Completions 请求；服务请求（service request）指 Proxy 对一个物理模型
发起的一次 HTTP 请求。一次 Filter 或 Router 轮次通常包含一个 Decision 服务请求和一个 Agent
服务请求，严格采用以下字段：

| 字段 | 作用域 | 定义 |
| --- | --- | --- |
| `session_id` | 一个任务 | 所有轮次共享的逻辑任务会话标识。 |
| `session_source` | 一个任务 | `session_id` 的来源，例如 `x-clawmobile-session-id`、`x-session-id` 或 `clawbench-run-marker`。 |
| `turn_id` / `proxy_request_id` | 一个 Agent 轮次 | Helper 与随后 Agent 请求共享，用于还原同一轮。 |
| `service_request_id` | 一个物理请求 | 每次 Helper retry、Agent、Local 或 fallback 都唯一。 |
| `attempt_index` | 同一轮次的一种调用角色 | 从 1 开始连续编号；无重试的 Final 调用为 1。 |
| `service_role` | 一个物理请求 | 取 `filter`、`router`、`agent` 或 `local-agent`。 |
| `call_role` | 一个物理请求 | 更细的内部角色，例如 `filter_helper`、`router_helper`、`cloud_agent`。 |
| `upstream_session_id` | 一个任务中的一种角色 | 发给物理服务的角色隔离会话标记。 |

Proxy 向 FreeInference 发送其官方支持的两个 Header：

- `X-Session-ID: cm-<session_id>-filter|router|agent|local-agent`：同一任务中按角色拆分服务会话；
- `X-Request-ID: cm-<service_role>-<uuid>`：唯一标记每次实际 API 调用，FreeInference 会在响应中回显。

本地 JSONL 同时保存上述字段和脱敏后的实际请求 Header，因此不依赖服务端日志权限也能复盘。Header
只用于关联，不代表有状态对话，不会代替 `messages`。Proxy 不向请求正文添加 `user`、`metadata`、
Decision 输出或任何会话消息，所以最终 Agent 仍收到该轮原始请求；标记也不能实现 Provider 队列、限流或
模型缓存的物理隔离。

`experiment` 是正式实验入口，只接受两类 cell 级权威 `session_id`：消息中恰好一个小写
`run:<32 个十六进制字符>` ClawBench 标记，或在没有任何 run marker 时提供一个有效的
`X-ClawMobile-Session-ID` / `X-Session-ID` 小写 32-hex Header。若两个 Header 同时存在，必须严格
相等；若 marker 与 Header 同时存在，所有 Header 必须严格等于 marker，且 `session_source` 必须是
`clawbench-run-marker`。重复相同 marker、多个不同 marker、非 32 位 marker、大写 marker、无效
Header 或任意冲突都会在物理模型请求前返回 HTTP 400。marker-like 值不能通过提供合法 Header 被
静默忽略。`CLAW_ROUTER_SESSION_ID` 不参与任何正式或兼容会话选择；`CLAW_ROUTER_CAMPAIGN_ID` 和
Proxy 随机标识也不得作为 `experiment` 回退。被拒绝的合法 JSON 请求仍会先保存 inbound capture，
但不会产生 upstream model call。

`upstream_session_id` 在 cell session 需要字符规范化或截断时附加原始值的 SHA-256 摘要片段，
避免两个不同 cell session 规范化成同一个上游会话；同一 cell 的 `filter`、`router`、`agent` 和
`local-agent` 后缀仍彼此隔离。

显式非 `experiment` 虚拟模型为保持诊断兼容，仍按入站两个 Session Header、ClawBench run marker、
`CLAW_ROUTER_CAMPAIGN_ID`、Proxy 进程级随机标识的顺序回退；不会读取
`CLAW_ROUTER_SESSION_ID`。cell session 唯一性以及手机、GPU 和服务等跨进程全局资源锁仍由 runner 负责。
Proxy 另有两把互相独立、进程级的先进先出（First In, First Out，FIFO）信号量：
`freeinference-global` 和 `xmu-8080` 的 `configured`（配置容量）都固定为 1。前者覆盖所有物理
FreeInference 调用，包括 helper、cloud Agent、使用 FreeInference 的 logical-local Agent 及每次 retry；后者覆盖
所有物理 XMU 调用及 retry。两种资源彼此不互相占用，所以各自最多一个 in-flight 请求，但 FreeInference 与 XMU
可以同时运行。

Authorization、API Key 和 Cookie 不写入采集文件。完整上下文可能包含设备和用户数据，采集
文件必须按实验数据管理。每条 JSONL 记录都在串行队列中完成 append、`fsync` 和关闭文件描述符后才
减少 `capture.pending`；`/health` 同时公开入队与 durable 的 record/model-call 累计计数。正式统计要求
`capture.pending=0`、`capture.errors=0`、两组计数严格相等，并与 copy-only 归档逐条计数一致。
物理 Provider 的 FIFO 等待时间单独写入 `provider_queue_wait_ms`，不计入 `latency_ms` 或
`provider_latency_ms`。信号量只在原始 JSON/SSE（Server-Sent Events，服务器发送事件）响应采集完成上述
durable flush 后释放；未启用 JSONL 采集时也会先完整排空原始响应 clone。传输错误、响应流错误和客户端 abort
都经过 `finally` 释放，避免遗留占用。

## 运行与测试

正式 phone-native 实验由 controller 启动唯一共享 Proxy；不要手工设置
`CLAW_ROUTER_ACTIVE_STRATEGY` 来运行 v4 campaign：

```bash
cd ~/ClawMobile/clawmobile-router-test-kit
./phone/run.sh services start
./phone/run.sh doctor
```

以下命令仅用于 Proxy 独立开发与单测：

```bash
cd ~/ClawMobile/clawmobile-router-test-kit/clawmobile-router-proxy
npm test

CLAW_ROUTER_DECISION_MODEL=deepseek-v4-flash \
CLAW_ROUTER_CLOUD_MODEL=deepseek-v4-flash \
CLAW_ROUTER_ACTIVE_STRATEGY=filter \
CLAW_ROUTER_ARM_ID=dsv4-filter-dsv4-agent \
CLAW_ROUTER_CAPTURE_PATH="$HOME/clawmobile-experiments/model-calls.jsonl" \
npm start
```

健康检查和不执行工具的两工具 smoke：

```bash
curl -fsS http://127.0.0.1:18081/health
curl -fsS http://127.0.0.1:18081/v1/models
node scripts/smoke.js filter
node scripts/smoke.js router
node scripts/smoke.js cloud-full
node scripts/smoke.js local-full
node scripts/smoke.js experiment
```

OpenClaw 注册：

```bash
openclaw config patch --file ./deploy/openclaw-router.patch.json5 --dry-run
openclaw config patch --file ./deploy/openclaw-router.patch.json5
openclaw config validate
```

## 配置变量

- `CLAW_ROUTER_DECISION_PROVIDER` / `CLAW_ROUTER_DECISION_MODEL`
- `CLAW_ROUTER_CLOUD_PROVIDER` / `CLAW_ROUTER_CLOUD_MODEL`
- `CLAW_ROUTER_LOCAL_PROVIDER` / `CLAW_ROUTER_LOCAL_MODEL`
- `CLAW_ROUTER_CLIENT_TOKEN`：必须显式注入且不能为空；Proxy 不再从 `clawmobile-router` Provider 的
  `apiKey` 回退读取。该值必须与 Decision、Cloud、Local 任一上游 Provider 的 API Key 或凭据 Header
  不同，否则 Proxy 在启动时 fail-closed。比较使用秘密的原始字符串，不做 trim，也不添加 `Bearer `
  等前缀。正式 token 必须由密码学安全随机源生成，具有至少 256-bit 随机性，并包含至少 32 个
  UTF-8 字节；Proxy 会 fail-closed 拒绝少于 32 字节的值。
- `CLAW_ROUTER_HOST` / `CLAW_ROUTER_PORT`
- `CLAW_ROUTER_LOG_PATH`
- `CLAW_ROUTER_CAPTURE_PATH`
- `CLAW_ROUTER_CAMPAIGN_ID`
- `CLAW_ROUTER_SESSION_ID`：已禁止作为任何会话回退；正式 runner 会显式 unset，Proxy 不读取它。
- `CLAW_ROUTER_ACTIVE_STRATEGY`：`experiment` 的实际策略，只允许 `cloud-full`、`local-full`、
  `filter`、各冻结Router/FSM/Repair/Binary策略；完整且唯一的允许集合由 `src/config.js` 的
  `EXPERIMENT_STRATEGIES` 导出，正式实验必须使用其中一个值。该变量不覆盖请求正文中显式选择的虚拟模型。
- `CLAW_ROUTER_ARM_ID`：采集中的实验臂标识，只允许 1–128 个字母、数字、点、下划线、冒号或连字符；
  `experiment` 未设置时回退为字面值 `experiment`，正式实验必须显式设置。
- `CLAW_ROUTER_STRATEGY_TIMEOUT_MS`
- `CLAW_ROUTER_ANSWER_TIMEOUT_MS`

`GET /health` 会公开 `active_strategy` 和 `arm_id`，供 runner 在每个 cell 启动前核对；
`provider_concurrency` 分别公开两种资源的 `configured`、`current`（当前占用）、`queued`（FIFO 等待数）和
`max_observed`（本进程观测到的最大同时占用）。响应只公开 Provider ID 和模型 ID，不包含 API Key、
Authorization 或 Cookie。

正式 provenance manifest 只记录秘密是否存在及其 fingerprint。Fingerprint 严格定义为：对秘密的
原始 UTF-8 字节直接计算 SHA-256；不 trim、不做大小写归一化、不添加任何前缀。Manifest 禁止额外字段、
嵌套秘密字段和带 userinfo、query 或 fragment 的凭据 URL。FreeInference 正式 Base URL 固定为
`https://freeinference.org/v1`。

默认只监听 loopback。只有显式设置 `CLAW_ROUTER_ALLOW_NON_LOOPBACK=1` 才允许非 loopback
监听。物理端点只从 OpenClaw Provider 配置读取，客户端不能通过请求注入任意上游地址。
