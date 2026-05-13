# Smart Agent (LangGraph + TypeScript) — V2.2 简化图结构

Date: 2026-05-14 (supersedes V2.1 2026-05-08)
Project directory: `smart-agent-langchain-ts`

## 1. 背景与动机

V2.1（2026-05-08）使用 7 节点 StateGraph：`START → ingest/device_ingest → router_intent → prepare → llm_call ⇄ tool_node → respond`。其中 `router_intent` 通过额外一次 LLM 调用分类意图，`prepare` 按意图筛选 tool 子集。

问题：
- `router_intent` 是一次额外的 LLM 调用，增加延迟和 token 消耗
- 当前 tool 仅 8 个（5 smartthings + 2 ros2 + 1 通用），LLM bindTools 自带 function schema，模型能自行区分
- `ingest` / `device_ingest` / `prepare` 三个轻量节点职责分散，可合并

V2.2 移除 `router_intent`、合并入口节点，简化为 **4 节点** 固定图。

## 2. 图结构

```
START → prepare → llm_call ⇄ tool_node → respond → END
                                ↑________________________↓
                                   (有 tool_calls 就循环)
```

4 个节点 + 1 个条件循环。`prepare` 是统一入口（代替原来的 ingest/device_ingest/router_intent/prepare）。

## 3. 节点职责

### 3.1 prepare（入口节点）

- 注入 SystemMessage（跨轮去重：checkpoint 恢复的 messages 可能已含 SystemMessage）
- 重置 `agentLoopCount` 为 0
- 发送 node:start/end 事件

不再按 intent 筛选 tool 子集 — 始终使用全部 tools。

### 3.2 llm_call（不变）

- 使用 `bindTools(deps.tools)` 的 LLM 处理 messages（全部 tools，不筛选）
- 返回 AIMessage（可能含 tool_calls，也可能是最终文本回复）
- 发送 node:start/end 事件，source="llm"

### 3.3 tool_node（不变）

- 封装 LangGraph ToolNode，执行 AIMessage 中的 tool_calls
- 每个 tool call 前后发送 tool:start / tool:end 事件
- 返回 ToolMessage[] 追加到 messages，追加到 toolResults

### 3.4 respond（不变）

- 从 messages 中逆序找最后一条不含 tool_calls 的 AIMessage 作为 finalText
- 发送 node:start/end 事件

## 4. 条件边

```
prepare → llm_call (固定)

llm_call 之后：
  - 最后一条消息是 AIMessage 且有 tool_calls → tool_node
  - 否则 → respond

tool_node 之后：
  - agentLoopCount < 5 → llm_call（继续 agent 循环）
  - agentLoopCount >= 5 → respond（强制退出，避免无限循环）

respond → END
```

## 5. 状态模型

```
sessionId       string          — 会话 ID (replace)
input           InputMessage    — 本轮输入 (replace)
messages        BaseMessage[]   — 会话历史 (append, max 50)
toolResults     unknown          — tool 调用结果数组 (replace)
finalText       string           — 最终回复文本 (replace)
graphEvents     GraphEvent[]     — 本轮事件 (replace)
agentLoopCount  number           — agent 循环计数器 (replace)
```

已移除的字段（V2.1 → V2.2）：
- `eventType` — 不再需要 chat/device_event 分流
- `userText` — 仅 router_intent 消费，已移除
- `intent` — 仅 tool 筛选消费，已移除

## 6. 事件协议

不变。GraphEvent 仍为 node | tool，SSE 事件形状不变，前端无需改动。

## 7. 与 V2.1 的差异总结

| | V2.1 | V2.2 |
|---|---|---|
| 图节点数 | 7 | 4 |
| START 分支 | 条件边 (eventType) | 固定边 |
| 意图分类 | LLM router_intent 节点 | 无（LLM 自主根据 tool schema 选择） |
| Tool 选择 | selectTools(intent) 筛选子集 | 始终全部 tools |
| 入口节点 | ingest + device_ingest + prepare | prepare（统一入口） |
| LLM 调用次数 | 1 (router) + N (agent loop) | N (agent loop) |
| State 字段 | 11 | 8 |

## 8. 风险与约束

- Tool 数量增长到 20+ 时，可能需要重新评估 intent 筛选（减少 bindTools schema token 消耗）
- 当前 8 个 tool，全部 bind 的 schema token 在可接受范围内
- 循环安全：最大 5 轮硬限制不变
- 向后兼容：GraphEvent 协议不变，SSE 事件形状不变，agent.ts API 不变

## 9. Done Criteria

- 图结构 4 节点 + 条件循环，无 router_intent / ingest / device_ingest
- prepare 作为统一入口
- LLM 使用全部 tools（不按 intent 筛选）
- 最大 5 轮循环后强制终止
- 现有测试通过，SSE 事件正常推送
