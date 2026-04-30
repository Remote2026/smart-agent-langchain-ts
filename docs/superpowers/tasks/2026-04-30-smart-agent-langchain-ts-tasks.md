# Smart Agent (LangChain + TypeScript) — V1 Tasks

Date: 2026-04-30  
Source plan: `docs/superpowers/plans/2026-04-30-smart-agent-langchain-ts-implementation-plan.md`

## Task 1: Scaffold TypeScript Node Project

Status: completed

Create the baseline project files.

Files:

- `package.json`
- `tsconfig.json`
- `.env.example`
- `config/device-aliases.json`

Details:

- Use ESM TypeScript.
- Add scripts for `dev`, `build`, `start`, and `typecheck`.
- Include dependencies for Express, LangChain OpenAI-compatible chat model, dotenv, and validation.
- Include development dependencies for TypeScript, `tsx`, and Node/Express types.
- Document required environment variables in `.env.example`.

Acceptance:

- `npm install` can install dependencies.
- Project scripts exist.
- No secrets are committed.

## Task 2: Define Shared Contracts And Config Loader

Status: completed

Create shared types and runtime config loading.

Files:

- `src/types.ts`
- `src/config.ts`

Details:

- Define `ChatEvent` for normalized incoming channel events.
- Define `ChatEventOut` for outgoing `status`, `token`, `tool`, `final`, and `error` events.
- Load `.env` server-side.
- Validate environment variables.
- Load and validate `config/device-aliases.json`.

Acceptance:

- Invalid config fails early with a readable error.
- Browser-facing types never include secret fields.
- Channel contract can support future Slack adapter without changing agent core.

## Task 3: Implement SmartThings Connector

Status: completed

Create the SmartThings REST connector.

Files:

- `src/tools/smartthings.ts`

Details:

- Implement `listDevices`.
- Implement `setSwitch`.
- Implement `setLevel`.
- Use `SMARTTHINGS_PAT` only on the server.
- Validate non-empty `deviceId`.
- Validate brightness level as integer `0..100`.

Acceptance:

- Connector returns JSON-serializable results.
- SmartThings HTTP errors become readable exceptions.
- PAT is never included in thrown messages or browser events.

## Task 4: Implement ROS2 rosbridge Connector

Status: completed

Create the ROS2 connector.

Files:

- `src/tools/ros2.ts`

Details:

- Connect to `ROSBRIDGE_URL`.
- Implement `getParam(node, name)`.
- Implement `setParam(node, name, value)`.
- Validate non-empty `node` and `name`.
- Keep the public tool contract stable even if rosbridge payload details need adjustment.

Acceptance:

- Connector has timeout behavior for unreachable rosbridge.
- Errors are readable.
- Returned values are JSON-serializable.

## Task 5: Wrap Connectors As LangChain Tools

Status: completed

Expose stable agent tools.

Files:

- `src/tools/index.ts`

Details:

- Create `smartthings_resolve_alias`.
- Create `smartthings_list_devices`.
- Create `smartthings_set_switch`.
- Create `smartthings_set_level`.
- Create `ros2_get_param`.
- Create `ros2_set_param`.
- Use schema validation for every tool input.

Acceptance:

- Tool names are stable and descriptive.
- Alias resolution returns a clear not-found result.
- Tool input validation happens before connector execution.

## Task 6: Implement Agent Core

Status: completed

Create the LangChain agent runtime.

Files:

- `src/agent/agent.ts`

Details:

- Initialize OpenAI-compatible chat model from config.
- Bind all tools.
- Maintain in-memory per-session message history.
- Add system prompt with safety and behavior rules.
- Execute tool-call loop until final assistant response.
- Emit status and tool events through a callback.
- Add max tool-call iteration guard.

Acceptance:

- Multi-turn conversation works per `sessionId`.
- Tool success and failure are emitted as events.
- Agent returns a final answer after tool execution.
- Tool errors do not crash the process.

## Task 7: Implement Express Server And SSE Chat Endpoint

Status: completed

Create the local server.

Files:

- `src/index.ts`

Details:

- Serve static assets from `public`.
- Add `GET /api/health`.
- Add `POST /api/chat`.
- Validate non-empty message text.
- Return `text/event-stream` from chat endpoint.
- Write SSE events for status, tool, final, and error.

Acceptance:

- `GET /api/health` returns `{ ok: true }`.
- Empty messages return an SSE error event.
- Chat endpoint closes the stream after completion.

## Task 8: Build Browser Chat UI

Status: completed

Implement the working local UI.

Files:

- `public/index.html`
- `public/styles.css`
- `public/app.js`

Details:

- Render chat transcript.
- Render tool event log.
- Submit chat messages with `fetch`.
- Parse SSE response chunks manually from the fetch response body.
- Store a browser `sessionId` in `localStorage`.
- Disable input while a request is running.
- Support Enter to send and Shift+Enter for newline.

Acceptance:

- UI can send a message to `/api/chat`.
- Assistant final responses appear in the transcript.
- Tool calls and errors appear visibly.
- Layout works at desktop and mobile widths.

## Task 9: Verify TypeScript And Runtime

Status: completed with runtime smoke pending

Run local verification.

Commands:

```bash
npm install
npm run typecheck
npm run dev
```

Result:

- `npm install`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run dev`: not run to completion because real `.env` values are required for startup config validation.

Manual checks:

- Open `http://localhost:3000`.
- Send a normal chat message.
- Send a SmartThings alias request.
- Send a ROS2 parameter request.
- Confirm readable errors when SmartThings PAT or rosbridge is unavailable.

Acceptance:

- TypeScript passes.
- Dev server starts.
- Browser can connect to the app.
- Known external-service failures are handled cleanly.

## Task 10: Add Local Skill Support And Restricted Shell Tool

Status: completed

Add support for local `SKILL.md` files and guarded shell execution.

Files:

- `src/skill-runtime/skill-manager.ts`
- `src/tools/index.ts`
- `src/agent/agent.ts`
- `src/index.ts`
- `.env.example`
- `skills/smartthings-device-manager/SKILL.md`

Details:

- Load skills from `SKILLS_DIR`, defaulting to `skills`.
- Discover `SKILL.md` files under one directory per skill.
- Expose `skill_list`, `skill_read`, and `skill_run_shell` LangChain tools.
- Keep shell execution disabled unless `ENABLE_SKILL_SHELL=true`.
- Only allow commands listed under a skill's `Allowed Shell Commands` section.
- Block common destructive shell commands even if they are accidentally allowlisted.

Acceptance:

- Agent can list and read local skill instructions.
- Agent can only run shell commands when both environment config and `SKILL.md` allow it.
- TypeScript passes.

## Execution Order

1. Task 1
2. Task 2
3. Task 3 and Task 4
4. Task 5
5. Task 6
6. Task 7
7. Task 8
8. Task 9

Task 3 and Task 4 are independent and can be implemented in either order.
