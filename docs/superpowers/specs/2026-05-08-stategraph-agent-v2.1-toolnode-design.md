# Smart Agent (LangGraph + TypeScript) — V2.1 ToolNode 多轮 Agent 设计

Date: 2026-05-08
Project directory: `smart-agent-langchain-ts`

## 1. 背景与动机

V2（2026-05-03 设计）使用自定义 StateGraph，每个领域（smartthings / ros2 / default）对应一个硬编码节点。LLM 只做"动作分类"（输出结构化 JSON），代码手动查找和调用 tool。

问题：
- 领域节点样板代码多（每个节点重复 LLM 调用 → JSON 解析 → tool 查找 → 手动 invoke 流程）
- 多步 tool 顺序依赖（如 resolve_alias → set_switch）需要代码硬编码，不够灵活
- 新增领域需要写新节点 + 注册到图结构

V2.1 用 **LangGraph ToolNode + 多轮 Agent 循环** 替代领域专属节点，LLM 自主决定调用哪些 tool 及调用顺序。

## 2. 图结构

```
ingest → router_intent → prepare_agent → llm_call ⇄ tool_node → respond → END
                                ↑________________________↓
                                   (有 tool_calls 就循环)
```

5 个节点 + 1 个条件循环，固定不变。领域差异仅体现在 prepare_agent 选择的 tool 子集。

## 3. 节点职责

### 3.1 ingest（保持不变）
- 校验 input.text 非空
- 提取 userText（trim 后文本）
- 空文本直接走 default + low confidence
- 发送 node:start/end 事件

### 3.2 router_intent（保持不变）
- 根据 userText 分类意图：smartthings / ros2 / default
- 输出 intent + confidence + reason
- 低置信度 → intent=default，由 LLM 在后续对话中自然追问
- 发送 node:start/end 事件

### 3.3 prepare_agent（新增）
- 根据 intent 选择 tool 子集
- 将 tools bind 到 LLM（`llm.bindTools(tools)`）
- 将 system prompt 注入 messages（首条 SystemMessage）
- 发送 node:start/end 事件

Tool 子集映射：

| intent | tools |
|--------|-------|
| smartthings | smartthings_resolve_alias, smartthings_list_devices, smartthings_set_switch, smartthings_set_level |
| ros2 | ros2_get_param, ros2_set_param |
| default | 全部 tools |

### 3.4 llm_call（新增）
- 使用 bindTools 后的 LLM 处理 messages
- 返回 AIMessage（可能含 tool_calls，也可能是最终文本回复）
- 发送 node:start/end 事件，source="llm"

### 3.5 tool_node（新增）
- 封装 LangGraph ToolNode，执行 AIMessage 中的 tool_calls
- 每个 tool call 前后发送 tool:start / tool:end 事件
- 返回 ToolMessage[] 追加到 messages

### 3.6 respond（简化）
- 从 messages 中找到最后一条 AIMessage，提取其 content 作为 finalText
- 注意：agent 循环结束后，最后一条消息就是 LLM 的最终文本回复（不含 tool_calls）
- 发送 node:start/end 事件

## 4. 条件边

```
llm_call 之后：
  - 最后一条消息是 AIMessage 且有 tool_calls → tool_node
  - 否则 → respond

tool_node 之后：
  - 循环计数 < 5 → llm_call（继续 agent 循环）
  - 循环计数 >= 5 → respond（强制退出，避免无限循环）
```

## 5. 状态模型

V2 的 GraphState 保持不变（sessionId / input / messages / userText / intent / intentConfidence / intentReason / toolResults / finalText / graphEvents）。

新增字段：
- `agentLoopCount: number` — agent 循环计数器（replace reducer），用于限制最大循环次数

保留字段说明：
- `toolResults` — 存储 agent 循环中所有 tool 调用的结果数组（按调用顺序追加），供调试/审计。每轮对话开始时清空。
- `messages` — append reducer，ToolMessage 和 AIMessage 自动累积，LLM 下一轮自然看到历史。

## 6. 事件协议

事件类型不增加，仍为 GraphEvent (node | tool)。变化点：

- `llm_call` 节点的 node 事件标记 `source: "llm"`
- `tool_node` 发出的 tool 事件标记 `source: "tool"`
- tool 事件的 origin 标记产生位置（如 `{ file: "graph.ts", fn: "tool_node" }`）

前端无需改动——SSE 事件形状不变。

## 7. 与 V2 的差异总结

| | V2 | V2.1 |
|---|---|---|
| 领域节点 | 3 个硬编码节点 | 0 个（统一 agent 循环） |
| 图节点总数 | 6 | 6 |
| LLM 调用方式 | 人工 prompt 做动作分类 | bindTools 标准 tool calling |
| Tool 调用 | 代码手动 find + invoke | ToolNode 自动执行 |
| 多步依赖 | 代码硬编码顺序 | LLM 自主多轮决策 |
| 新增领域成本 | 写新节点 + 注册边 | 注册 tools + 更新 router prompt |
| 循环安全 | 无（线性流程） | 最大 5 轮 |

## 8. SmartThings 工具实现方式

- `smartthings_list_devices`：通过 CLI `smartthings devices -j` 获取设备列表，无需 PAT
- `smartthings_set_switch` / `smartthings_set_level`：暂为空实现，后续通过 CLI `smartthings devices:commands` 补充
- CLI 认证由用户事先执行 `smartthings login` 完成，代码不处理 token

## 9. 风险与约束

- **LLM tool calling 可靠性**：依赖模型 tool calling 能力，需选择支持 function calling 的模型
- **循环退出保证**：最大 5 轮硬限制，避免无限循环耗 token
- **Tool 副作用安全**：tool 层面已有参数校验（deviceId 非空、level 范围），保持不变
- **向后兼容**：GraphEvent 协议不变，前端无需改动

## 10. Done Criteria

- 图结构改为 5 节点 + 条件循环，不再有 smartthings_node / ros2_node / default_node
- LLM 使用 bindTools + ToolNode 自主调用 tools
- 多步依赖（resolve_alias → set_switch）能自然完成，无需代码硬编码顺序
- 最大 5 轮循环后强制终止
- SSE 事件（node/tool）正常推送，前端展示不受影响
