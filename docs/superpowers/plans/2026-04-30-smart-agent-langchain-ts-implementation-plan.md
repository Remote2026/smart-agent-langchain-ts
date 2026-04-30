# Smart Agent (LangChain + TypeScript) — V1 Implementation Plan

Date: 2026-04-30  
Source design: `docs/superpowers/specs/2026-04-29-smart-agent-langchain-ts-design.md`

## 1. Objective

Implement the V1 local web chat application described in the design:

- Browser chat UI
- Node.js + TypeScript agent server
- LangChain agent using OpenAI-compatible Qwen endpoint
- SmartThings tools for list devices, switch on/off, and brightness level
- ROS2 parameter get/set through `rosbridge_suite`
- SSE-based status and tool-event updates
- Config boundary that keeps secrets server-side

## 2. Decisions For V1

The design left three open questions. For implementation planning, use these defaults:

1. Use `POST /api/chat` with `text/event-stream` response.
   - This gives the UI thinking/tool/done updates without introducing WebSocket session complexity.

2. Keep SmartThings selection chat-only in V1.
   - Use `config/device-aliases.json` for natural names such as `客厅灯`.
   - If no alias matches, the agent lists devices or asks the user to choose.

3. Wrap ROS2 parameter operations behind stable internal tool signatures.
   - Start with rosbridge `rosapi` service calls.
   - If the exact ROS distro or rosbridge payload shape differs, only the ROS connector changes; the agent tool contract remains stable.

## 3. Target File Structure

```text
smart-agent-langchain-ts/
  package.json
  tsconfig.json
  .env.example
  config/
    device-aliases.json
  public/
    index.html
    styles.css
    app.js
  src/
    index.ts
    config.ts
    types.ts
    agent/
      agent.ts
    tools/
      index.ts
      smartthings.ts
      ros2.ts
```

## 4. Implementation Phases

### Phase 1: Project Scaffold

Create a minimal TypeScript Node project.

Deliverables:

- `package.json`
- `tsconfig.json`
- `.env.example`
- `config/device-aliases.json`

Acceptance checks:

- `npm install` succeeds.
- `npm run typecheck` can run after source files exist.
- `.env.example` documents all required variables:
  - `OPENAI_BASE_URL`
  - `OPENAI_API_KEY`
  - `OPENAI_MODEL`
  - `SMARTTHINGS_PAT`
  - `ROSBRIDGE_URL`
  - `PORT`

### Phase 2: Shared Types And Config

Define channel-neutral message contracts and load runtime configuration.

Deliverables:

- `src/types.ts`
- `src/config.ts`

Contracts:

- `ChatEvent`: incoming normalized message
- `ChatEventOut`: outgoing status, token, tool, final, and error events

Acceptance checks:

- Secrets are read only on the server.
- Device alias config validates at startup.
- Missing optional SmartThings PAT should produce tool-level errors, not browser-exposed secrets.

### Phase 3: Tool Connectors

Implement server-side connectors.

Deliverables:

- `src/tools/smartthings.ts`
- `src/tools/ros2.ts`
- `src/tools/index.ts`

SmartThings tools:

- `smartthings.listDevices()`
- `smartthings.setSwitch(deviceId, on)`
- `smartthings.setLevel(deviceId, level)`

ROS2 tools:

- `ros2.getParam(node, name)`
- `ros2.setParam(node, name, value)`

Validation:

- `deviceId` must be non-empty.
- Brightness `level` must be an integer in `[0, 100]`.
- ROS2 `node` and `name` must be non-empty.

Acceptance checks:

- Tool functions return stable JSON-serializable results.
- Connector errors are readable and safe to show to the user.
- Tool names stay stable even if connector internals change.

### Phase 4: Agent Core

Implement the LangChain agent loop.

Deliverables:

- `src/agent/agent.ts`

Responsibilities:

- Maintain per-session message history in memory.
- Bind LangChain tools to the OpenAI-compatible chat model.
- Route tool calls and append tool results back into the conversation.
- Emit events for:
  - thinking
  - tool executing
  - tool ok
  - tool error
  - final answer
  - done

Acceptance checks:

- Multi-turn context works per `sessionId`.
- Tool failures do not crash the server.
- The tool-call loop has a maximum iteration guard.

### Phase 5: HTTP And SSE Server

Expose local web APIs.

Deliverables:

- `src/index.ts`

Endpoints:

- `GET /api/health`
- `POST /api/chat`

SSE event types:

- `status`
- `tool`
- `final`
- `error`

Acceptance checks:

- `POST /api/chat` validates non-empty text.
- Browser receives incremental tool/status events.
- Server serves static frontend from `public/`.

### Phase 6: Browser UI

Turn the mockup into a working local chat UI.

Deliverables:

- `public/index.html`
- `public/styles.css`
- `public/app.js`

UI behavior:

- Render user and assistant messages.
- Submit messages to `POST /api/chat`.
- Parse SSE response from `fetch`.
- Display tool execution events.
- Show busy/done status.
- Disable input while a request is in flight.

Acceptance checks:

- Enter submits; Shift+Enter inserts a newline.
- Tool errors are visible but concise.
- Layout works on desktop and mobile widths.

### Phase 7: Verification

Run local checks.

Commands:

```bash
npm install
npm run typecheck
npm run dev
```

Manual smoke tests:

- Open `http://localhost:3000`.
- Send a normal chat message.
- Send a device-control request using a configured alias.
- Send a ROS2 parameter read request.
- Confirm missing `SMARTTHINGS_PAT` or unavailable rosbridge produces readable tool errors.

## 5. Risks And Follow-Ups

- ROS2 rosbridge parameter payloads may vary by environment.
  - Keep the public `ros2.getParam` and `ros2.setParam` tool signatures stable.

- Qwen OpenAI-compatible tool-calling behavior should be verified with the exact configured model.
  - If model responses differ, adjust only the LangChain binding or prompt, not the tool contracts.

- V1 session state is in memory.
  - Server restart clears conversation history; persistence is explicitly out of scope for V1.

## 6. Done Criteria

V1 is complete when:

- The app runs locally with `npm run dev`.
- The browser chat can send messages to the server.
- The server streams status and tool events back to the UI.
- SmartThings and ROS2 tools are callable through the agent.
- Tool input validation is enforced server-side.
- Secrets are never sent to the browser.
