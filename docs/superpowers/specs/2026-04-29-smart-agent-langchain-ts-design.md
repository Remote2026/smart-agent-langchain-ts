# Smart Agent (LangChain + TypeScript) — V1 Design

Date: 2026-04-29  
Project directory: `smart-agent-langchain-ts`  

## 1. Summary

Build a local web-based chat application (browser UI + Node/TypeScript server) that runs a LangChain agent for daily conversation and tool-driven control over:

- SmartThings IoT devices (V1: list devices, switch on/off, set light level)
- ROS2 via `rosbridge_suite` (V1: parameter get/set only)

The design deliberately separates **Agent Core** from **Channel adapters** so that Slack integration can be added later without rewriting the agent.

## 2. Goals (V1)

- Local web chat UI with multi-turn conversation
- Streaming or incremental UI updates (at minimum: show “thinking / executing tool / done” states)
- Agent can call tools automatically (OpenAI-compatible Qwen endpoint supports tool calling)
- SmartThings control:
  - Query devices
  - Switch on/off
  - Set brightness level (0–100)
- ROS2 control:
  - Get parameter
  - Set parameter
- Config-driven device aliases (e.g., “客厅灯” -> deviceId) to make chat natural
- Clean boundaries for future Slack support (same Agent Core, new channel adapter)

## 3. Non-Goals (V1)

- Multi-user auth / permissions system
- Production-grade deployment
- Complex long-term memory / knowledge base ingestion
- SmartThings advanced features (modes, routine generation, hue/saturation, etc.)
- ROS2 topic publish/service call

## 4. Key Decisions

- **Frontend thin, backend thick**:
  - UI focuses on chat UX and status display
  - All agent logic and tool execution happens on the Node server
- **ROS2 via rosbridge**:
  - Node server connects to `rosbridge_suite` over WebSocket
  - V1 supports only parameter get/set to keep scope tight
- **SmartThings via PAT**:
  - Server uses `SMARTTHINGS_PAT` to call SmartThings REST API
  - V1 only: list devices, set switch, set level
- **LLM**:
  - OpenAI-compatible Qwen endpoint, configured via `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`
  - Tool calling supported and used (function calling / tools / tool_calls)

## 5. Architecture

### 5.1 Components

1) **Web UI (Local Chat Page)**
- Renders chat transcript
- Shows tool execution events (e.g., “calling smartthings.setLevel”)
- Sends user messages to server

2) **Agent Server (Node.js + TypeScript)**
- Exposes chat endpoint(s) to UI
- Maintains per-session conversation state
- Runs LangChain agent and routes tool calls
- Enforces basic validation and safety rules (e.g., brightness range)

3) **Tool Connectors**
- SmartThings REST connector
- rosbridge WebSocket connector

4) **Config**
- `.env` for secrets/endpoints
- JSON/YAML (or TS module) for device aliases and safety rules

### 5.2 Channel Adapter Boundary (for Slack later)

Define a simple internal contract such as:

- `ChatEvent` (incoming): `{ sessionId, channel, userId?, text, timestamp }`
- `ChatEventOut` (outgoing): `{ sessionId, channel, type, payload }`

Local web UI is the first adapter. Slack will become another adapter that translates Slack events/messages into the same internal contract.

## 6. Public Interfaces (V1)

### 6.1 Server APIs (Local Web)

Minimal V1 options:

- Option A: `POST /api/chat` returns full response (simplest)
- Option B: `POST /api/chat` + streaming via SSE (`text/event-stream`) or WebSocket (better UX)

Recommendation: implement **SSE** for streaming tokens + tool events if feasible; otherwise start with non-streaming and add SSE next.

### 6.2 Tool APIs (Internal, called by agent)

#### SmartThings tools

1) `smartthings.listDevices() -> { devices: Array<{ id: string; name: string; label?: string }> }`

2) `smartthings.setSwitch(deviceId: string, on: boolean) -> { ok: true }`

3) `smartthings.setLevel(deviceId: string, level: number) -> { ok: true }`
- Validate `level` in `[0, 100]` (reject otherwise)

#### ROS2 tools (via rosbridge)

1) `ros2.getParam(node: string, name: string) -> { value: unknown }`

2) `ros2.setParam(node: string, name: string, value: unknown) -> { ok: true }`

Notes:
- V1 supports only a single `ROSBRIDGE_URL` connection.
- If rosbridge API limitations are encountered, we will adapt the exact message types while keeping the tool signature stable.

## 7. Configuration (V1)

### 7.1 Environment variables

- `OPENAI_BASE_URL` (Qwen OpenAI-compatible endpoint)
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `SMARTTHINGS_PAT`
- `ROSBRIDGE_URL` (e.g., `ws://localhost:9090`)

### 7.2 Device aliases

Maintain a config file such as `config/device-aliases.json`:

- `aliases`: map from natural-language name to `deviceId`
- optional: hints (room, device type) to improve disambiguation

If alias is missing/ambiguous:
- Agent asks user to choose from the `listDevices` results.

## 8. Safety & Validation (V1)

- Always validate tool inputs server-side:
  - Brightness range 0–100
  - Non-empty `deviceId`, parameter `name`
- Optional (toggleable) confirmation policy:
  - For certain high-risk actions (future V2/V3), require explicit user confirmation before tool call
- Never expose `SMARTTHINGS_PAT` or model keys to browser; all secrets live on server.

## 9. UX Requirements (V1)

- Chat transcript with clear separation of user/assistant
- Display tool activity:
  - show tool name + status (“executing…”, “ok”, “error”)
- Basic error handling:
  - show readable message if SmartThings/rosbridge is unreachable

## 10. Future Extensions (Out of Scope for V1)

- Slack adapter:
  - receive Slack messages, map to `ChatEvent`, send responses back
- SmartThings:
  - mode management
  - routine creation/execution
  - hue/saturation, color temperature
- ROS2:
  - topic publish/subscribe
  - service calls
- Persistence:
  - store conversations and tool logs locally (SQLite) with a migration path

## 11. Open Questions (to resolve before implementation)

1) Do we require streaming in V1 (SSE/WebSocket), or can we ship non-streaming first?
2) SmartThings device selection UX: should UI include a “device picker” panel, or keep it chat-only?
3) ROS2 parameter API shape: confirm the exact rosbridge message types we’ll use for param get/set in your ROS2 distro setup.

