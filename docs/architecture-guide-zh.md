# Smart Agent 架构与使用指南

本文档说明当前项目的整体方案、运行架构、数据流，以及主要文件职责。

## 1. 项目目标

本项目是一个本地运行的智能家居与 ROS2 助手：

- 前端提供浏览器聊天界面。
- 后端使用 Node.js、TypeScript、Express 提供 API。
- Agent 使用 LangGraph.js、LangChain 模型与结构化 tools 调用 OpenAI-compatible 模型接口。
- 当前默认适配 Qwen DashScope OpenAI-compatible endpoint。
- Agent 可以调用 SmartThings 工具控制设备。
- Agent 可以通过 rosbridge 调用 ROS2 参数读写能力。

核心原则：

- API key 和 token 只在服务端读取，不发送到浏览器。
- 工具调用必须经过结构化参数校验。
- SmartThings 和 ROS2 是唯一外部能力入口。
- Agent 不应该猜测设备 ID、ROS 参数值或工具结果。

## 2. 总体架构

```text
Browser UI
  |
  | POST /api/chat
  | text/event-stream response
  v
Express Server
  |
  v
SmartAgent
  |
  | LangGraph StateGraph
  v
Tools
  |-- SmartThings REST API
  |-- ROS2 rosbridge
```

主要分层：

- `public/`：浏览器界面。
- `src/index.ts`：HTTP 服务入口。
- `src/agent/agent.ts`：Agent 入口，负责模型、checkpoint、SSE 事件转发。
- `src/agent/v2/graph.ts`：LangGraph StateGraph，负责 ingest、intent routing、tool node、respond。
- `src/tools/`：LangChain tools 和外部系统连接器。
- `config/`：设备别名等本地配置。
- `.env`：本地私密运行配置，不进入 git。

## 3. 请求数据流

一次聊天请求的数据流如下：

1. 用户在浏览器输入消息。
2. `public/app.js` 向 `POST /api/chat` 发送 JSON：

   ```json
   {
     "sessionId": "...",
     "message": { "kind": "text", "text": "打开客厅灯" }
   }
   ```

3. `src/index.ts` 创建 SSE 响应流。
4. `src/index.ts` 调用 `agent.handleUserMessage(...)`。
5. `SmartAgent` 使用 `sessionId` 作为 LangGraph `thread_id`，通过 SQLite checkpoint 恢复/保存消息历史。
6. `src/agent/v2/graph.ts` 执行：
   - `ingest`：校验并归一化用户输入。
   - `router_intent`：判断请求属于 SmartThings、ROS2 或 default。
   - `smartthings_node` / `ros2_node` / `default_node`：执行对应分支。
   - `respond`：把最终回复写入消息历史并结束本轮图执行。
7. 各节点产生 `graphEvents`，`agent.ts` 按增量映射成 SSE 推给前端。
8. 图结束后发送 `final` 和 `status: done`。

SSE 事件类型：

- `status`：例如 `thinking`、`done`。
- `node`：图节点开始、结束或错误。
- `tool`：工具开始、成功、失败。
- `final`：最终助手回答。
- `error`：请求级错误。

## 4. 工具能力

工具定义在 `src/tools/index.ts`，外部连接器在同目录下拆分：

- `smartthings_resolve_alias`：根据自然语言别名查找设备配置。
- `smartthings_list_devices`：列出 SmartThings 设备。
- `smartthings_set_switch`：开关设备。
- `smartthings_set_level`：设置亮度。
- `ros2_get_param`：读取 ROS2 参数。
- `ros2_set_param`：设置 ROS2 参数。

SmartThings 设备别名来自 `config/device-aliases.json`。Agent 在控制具体设备前应先解析别名，避免猜测 device ID。

## 5. 配置说明

本地 `.env` 示例：

```env
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_API_KEY=your-qwen-api-key
OPENAI_MODEL=qwen-turbo

SMARTTHINGS_PAT=your-smartthings-token
ROSBRIDGE_URL=ws://localhost:9090

PORT=3000
```

说明：

- `OPENAI_BASE_URL`：OpenAI-compatible 模型接口地址。
- `OPENAI_API_KEY`：模型 API key，必须只放在 `.env`。
- `OPENAI_MODEL`：模型名，例如 `qwen-turbo`。
- `SMARTTHINGS_PAT`：SmartThings personal access token，可选；为空时 SmartThings 工具会报可读错误。
- `ROSBRIDGE_URL`：ROS bridge WebSocket 地址。
- `PORT`：本地 Web 服务端口。

`.env.example` 是模板，可以提交到 git；`.env` 是本地私密文件，不应提交。

## 6. 主要文件职责

### 根目录

- `package.json`：项目依赖、脚本命令和模块类型。
- `package-lock.json`：锁定 npm 依赖版本。
- `tsconfig.json`：TypeScript 编译配置。
- `.env.example`：环境变量模板，不包含真实密钥。
- `.gitignore`：忽略 `.env`、`node_modules/`、构建产物等。

### `src/`

- `src/index.ts`：应用入口。加载配置，创建工具、Agent，启动 Express 服务，提供 `/api/health` 和 `/api/chat`。
- `src/config.ts`：读取 `.env`，校验环境变量，读取 `config/device-aliases.json`。
- `src/types.ts`：定义聊天输入输出事件类型。

### `src/agent/`

- `src/agent/agent.ts`：Agent 入口。创建模型和 checkpoint，调用 V2 图，转发 SSE 事件。
- `src/agent/v2/graph.ts`：V2 StateGraph 的节点、路由、工具执行与回复生成。
- `src/agent/v2/state.ts`：请求和图状态类型。
- `src/agent/v2/events.ts`：图事件到 SSE 事件的转换。

### `src/tools/`

- `src/tools/index.ts`：把 SmartThings、ROS2 能力包装成 LangChain tools。
- `src/tools/smartthings.ts`：SmartThings REST API 客户端，负责列设备、开关、亮度控制。
- `src/tools/ros2.ts`：rosbridge 客户端，负责 ROS2 参数 get/set。

### `public/`

- `public/index.html`：浏览器页面结构。
- `public/styles.css`：聊天界面样式。
- `public/app.js`：前端聊天逻辑，负责发送请求、解析 SSE、渲染消息和工具日志。

### `config/`

- `config/device-aliases.json`：自然语言设备别名到 SmartThings `deviceId` 的映射。

### `docs/superpowers/`

- `docs/superpowers/specs/`：设计规格。
- `docs/superpowers/plans/`：实现计划。
- `docs/superpowers/tasks/`：任务拆分和完成状态。

## 7. 手动运行

安装依赖：

```powershell
npm install
```

检查类型：

```powershell
npm run typecheck
```

运行 V2 图回归测试：

```powershell
npm run test:v2-graph
```

启动开发服务：

```powershell
npm run dev
```

打开浏览器：

```text
http://localhost:3000
```

启动后终端应该看到类似日志：

```text
Smart Agent web chat is running at http://localhost:3000
```

## 8. 常见问题

### 为什么 VSCode Debug Console 没有日志？

如果你在终端运行 `npm run dev`，日志会输出到运行命令的终端，不会自动进入 VSCode Debug Console。只有通过 VSCode debugger 启动进程时，日志才会进入 Debug Console。

### Agent 能直接使用 Shell 吗？

不能。当前架构已移除本地 skill/shell runtime，Agent 只能通过 SmartThings 和 ROS2 结构化 tools 访问外部系统。

### API key 为什么不写在 `src/config.ts`？

`src/config.ts` 是代码，会被版本控制追踪。API key 属于密钥，只应该放在本地 `.env`。这样可以避免误提交、泄露或被前端打包暴露。

## 9. 后续可改进项

- 增加 VSCode `launch.json`，让用户可以从 Debug Console 启动服务。
- 增加工具调用审计日志。
- 增加测试模式，在没有真实 SmartThings 和 ROS2 环境时使用 mock connector。
- 继续完善 LangGraph V2 回归测试。
