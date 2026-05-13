# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

```bash
npm run dev              # Start dev server (tsx watch, auto-restart)
npm run build            # Compile TypeScript to dist/
npm run typecheck        # Type check only, no emit
npm run test:chat        # Send a test chat message to localhost:3000
npm run test:device-event # Post a test device event to localhost:3000
```

## Architecture

A local smart-home assistant using **LangGraph StateGraph** (v0.4) with an Express/SSE server.

### Data flow

```
Web UI (SSE) → POST /api/chat → SmartAgent → LangGraph StateGraph → tools → SSE response
Poll script → POST /api/device-event → (same graph) → SSE broadcast
```

### StateGraph nodes (src/agent/v2/graph.ts)

```
START → prepare → llm_call ⇄ tool_node → respond → END
```

- **prepare**: unified entry node. Injects SystemMessage (cross-round dedup), resets loop counter.
- **llm_call**: LLM with `bindTools(deps.tools)` (all tools, no intent filtering). Either returns `tool_calls` (→ tool_node) or final text (→ respond).
- **tool_node**: wraps LangGraph `ToolNode`, executes tool_calls, appends to `toolResults`.
- **respond**: extracts last non-tool-call `AIMessage.content` as `finalText`.

Agent loop: max 5 rounds (`llm_call ⇄ tool_node`), enforced by `agentLoopCount`.

### State (Annotation channels)

Key fields in `GraphState`: `sessionId`, `input`, `messages` (append reducer, max 50), `toolResults` (replace), `finalText`, `graphEvents` (per-round replace), `agentLoopCount`.

### SSE event protocol

Nodes append to `state.graphEvents[]`. SSE layer in `src/agent/v2/events.ts` maps `GraphEvent → ChatEventOut`. Event types: `status`, `node`, `tool`, `final`, `error`. Device events broadcast to all connected SSE clients (`sseClients` Set in `src/index.ts`).

### Tools (src/tools/index.ts)

- **SmartThings**: `smartthings_list_devices` (CLI via `execSync`), `smartthings_get_device_status` (CLI), `smartthings_set_switch` (stub), `smartthings_set_level` (stub). Auth via CLI login, no PAT.
- **ROS2**: `ros2_get_param` / `ros2_set_param` (rosbridge WebSocket), `ros2_drive_robot_close_fridge_door` (stub).

### Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Express server, SSE routes, SSE client broadcast |
| `src/agent/agent.ts` | SmartAgent class, `handleUserMessage` + `handleDeviceEvent` |
| `src/agent/v2/graph.ts` | StateGraph definition, all node functions, `buildV2Graph` |
| `src/agent/v2/state.ts` | Type schemas (`InputMessage`, `ChatRequest`, `DeviceEventRequest`) |
| `src/agent/v2/events.ts` | `nodeEvent`/`toolEvent` helpers, `graphEventToSse` mapper |
| `src/tools/index.ts` | Tool registration (`DynamicStructuredTool` → `createTools`) |
| `src/tools/smartthings.ts` | `SmartThingsClient` (CLI-backed) |
| `src/tools/ros2.ts` | `RosbridgeClient` (WebSocket to rosbridge) |
| `src/config.ts` | Env config (`.env`), zod-validated |

### Environment (.env)

- `OPENAI_BASE_URL` — default: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- `OPENAI_API_KEY` — required
- `OPENAI_MODEL` — default: `qwen-turbo`
- `ROSBRIDGE_URL` — default: `ws://localhost:9090`
- `PORT` — default: `3000`

### Checkpoints

LangGraph uses `SqliteSaver` (`checkpoints.db`) for conversation persistence. `thread_id = sessionId`.
