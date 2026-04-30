# Smart Agent 架构与使用指南

本文档说明当前项目的整体方案、运行架构、数据流、Skill 机制、Shell 执行安全模型，以及主要文件职责。

## 1. 项目目标

本项目是一个本地运行的智能家居与 ROS2 助手：

- 前端提供浏览器聊天界面。
- 后端使用 Node.js、TypeScript、Express 提供 API。
- Agent 使用 LangChain 调用 OpenAI-compatible 模型接口。
- 当前默认适配 Qwen DashScope OpenAI-compatible endpoint。
- Agent 可以调用 SmartThings 工具控制设备。
- Agent 可以通过 rosbridge 调用 ROS2 参数读写能力。
- Agent 支持本地 `SKILL.md` 文件，用来扩展推理规则和受限 Shell 命令。

核心原则：

- API key 和 token 只在服务端读取，不发送到浏览器。
- 工具调用必须经过结构化参数校验。
- Shell 执行默认关闭，开启后也必须受 `SKILL.md` allowlist 限制。
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
  | LangChain tool calling
  v
Tools
  |-- SmartThings REST API
  |-- ROS2 rosbridge
  |-- Local Skill Manager
        |-- skills/*/SKILL.md
        |-- restricted shell execution
```

主要分层：

- `public/`：浏览器界面。
- `src/index.ts`：HTTP 服务入口。
- `src/agent/agent.ts`：Agent 对话循环和工具调用循环。
- `src/tools/`：LangChain 工具和外部系统连接器。
- `src/skill-runtime/`：本地 Skill 读取和受限 Shell 执行的运行时代码。
- `config/`：设备别名等本地配置。
- `.env`：本地私密运行配置，不进入 git。

## 3. 请求数据流

一次普通聊天请求的数据流如下：

1. 用户在浏览器输入消息。
2. `public/app.js` 向 `POST /api/chat` 发送 JSON：

   ```json
   {
     "sessionId": "...",
     "text": "打开客厅灯"
   }
   ```

3. `src/index.ts` 创建 SSE 响应流。
4. `src/index.ts` 调用 `agent.handleUserMessage(...)`。
5. `SmartAgent` 把用户消息加入当前 session 的消息历史。
6. Agent 调用 Qwen 模型。
7. 如果模型返回普通回答，服务端发送 `final` 和 `done` 事件。
8. 如果模型返回 tool call，Agent 查找对应 LangChain tool 并执行。
9. 工具结果以 `ToolMessage` 形式加入消息历史。
10. Agent 再次调用模型，让模型基于工具结果生成最终回答。
11. 浏览器解析 SSE chunk，并把状态、工具日志、最终回答渲染到页面。

SSE 事件类型：

- `status`：例如 `thinking`、`done`。
- `tool`：工具开始、成功、失败。
- `final`：最终助手回答。
- `error`：请求级错误。

## 4. Agent 工具调用流程

Agent 的核心逻辑在 `src/agent/agent.ts`。

工作方式：

1. 每个 `sessionId` 对应一份内存消息历史。
2. 系统提示词定义 Agent 行为规则。
3. LangChain 的 `bindTools(...)` 把工具暴露给模型。
4. 模型可以返回一个或多个 tool calls。
5. 服务端根据 tool name 找到实际工具并执行。
6. 工具执行结果写回模型上下文。
7. 最多循环 8 步，避免无限工具调用。

这个项目没有把工具结果直接当最终回答。工具结果会先回到模型，让模型把结果整理成适合用户阅读的语言。

## 5. Skill 机制

Skill 文件位置：

```text
skills/<skill-name>/SKILL.md
```

示例：

```text
skills/smartthings-device-manager/SKILL.md
```

`SKILL.md` 的作用：

- 给 Agent 提供特定任务的推理规则。
- 说明什么时候应该使用这个 skill。
- 说明相关脚本或本地流程。
- 明确列出允许执行的 Shell 命令。

当前暴露给 Agent 的 Skill 工具：

- `skill_list`：列出已安装的本地 skill。
- `skill_read`：读取某个 skill 的完整 `SKILL.md`。
- `skill_run_shell`：按 skill allowlist 执行本地 Shell 命令。

Agent 使用 skill 的推荐流程：

1. 先调用 `skill_list` 查看可用 skill。
2. 再调用 `skill_read` 阅读目标 skill 的规则。
3. 如果任务需要 Shell，并且命令被允许，再调用 `skill_run_shell`。

## 6. Shell 执行安全模型

Shell 执行默认关闭。需要在 `.env` 中显式开启：

```env
ENABLE_SKILL_SHELL=true
```

同时，命令必须在对应 `SKILL.md` 的 `Allowed Shell Commands` 章节中出现。

例如：

```markdown
## Allowed Shell Commands

- `npm run typecheck`
- `npm run build`
```

这表示该 skill 只允许执行：

```powershell
npm run typecheck
npm run build
```

安全限制：

- `.env` 没有开启时，任何 Shell 命令都会被拒绝。
- `SKILL.md` 没有 allowlist 时，Shell 命令会被拒绝。
- 命令不在 allowlist 中时，会被拒绝。
- 常见破坏性命令会被额外阻止，例如 `rm`、`del`、`Remove-Item`、`git reset`。
- Shell 执行目录固定为项目根目录。
- Shell 执行有超时限制。
- 输出会被截断，避免过大的结果进入对话上下文。

这套设计的目的不是给模型完整电脑权限，而是让模型在明确授权的 skill 范围内执行可审计的本地动作。

## 7. 配置说明

本地 `.env` 示例：

```env
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_API_KEY=your-qwen-api-key
OPENAI_MODEL=qwen-turbo

SMARTTHINGS_PAT=your-smartthings-token
ROSBRIDGE_URL=ws://localhost:9090

SKILLS_DIR=skills
ENABLE_SKILL_SHELL=false

PORT=3000
```

说明：

- `OPENAI_BASE_URL`：OpenAI-compatible 模型接口地址。
- `OPENAI_API_KEY`：模型 API key，必须只放在 `.env`。
- `OPENAI_MODEL`：模型名，例如 `qwen-turbo`。
- `SMARTTHINGS_PAT`：SmartThings personal access token，可选；为空时 SmartThings 工具会报可读错误。
- `ROSBRIDGE_URL`：ROS bridge WebSocket 地址。
- `SKILLS_DIR`：本地 skill 根目录。
- `ENABLE_SKILL_SHELL`：是否允许 skill shell tool 执行命令。
- `PORT`：本地 Web 服务端口。

`.env.example` 是模板，可以提交到 git；`.env` 是本地私密文件，不应提交。

## 8. 主要文件职责

### 根目录

- `package.json`：项目依赖、脚本命令和模块类型。
- `package-lock.json`：锁定 npm 依赖版本。
- `tsconfig.json`：TypeScript 编译配置。
- `.env.example`：环境变量模板，不包含真实密钥。
- `.gitignore`：忽略 `.env`、`node_modules/`、构建产物等。

### `src/`

- `src/index.ts`：应用入口。加载配置，创建 SkillManager、工具、Agent，启动 Express 服务，提供 `/api/health` 和 `/api/chat`。
- `src/config.ts`：读取 `.env`，校验环境变量，读取 `config/device-aliases.json`。
- `src/types.ts`：定义聊天输入输出事件类型。

### `src/agent/`

- `src/agent/agent.ts`：Agent 核心。维护 session 消息历史，绑定工具，处理模型 tool calls，发送 SSE 事件。

### `src/tools/`

- `src/tools/index.ts`：把 SmartThings、ROS2、Skill 能力包装成 LangChain tools。
- `src/tools/smartthings.ts`：SmartThings REST API 客户端，负责列设备、开关、亮度控制。
- `src/tools/ros2.ts`：rosbridge 客户端，负责 ROS2 参数 get/set。

### `src/skill-runtime/`

- `src/skill-runtime/skill-manager.ts`：扫描 `skills/*/SKILL.md`，解析 skill 描述和 allowlist，并执行受限 Shell 命令。

### `public/`

- `public/index.html`：浏览器页面结构。
- `public/styles.css`：聊天界面样式。
- `public/app.js`：前端聊天逻辑，负责发送请求、解析 SSE、渲染消息和工具日志。

### `config/`

- `config/device-aliases.json`：自然语言设备别名到 SmartThings `deviceId` 的映射。

### `skills/`

- `skills/smartthings-device-manager/SKILL.md`：SmartThings 相关 skill 示例，包含推理规则和允许的本地命令。

### `docs/superpowers/`

- `docs/superpowers/specs/`：设计规格。
- `docs/superpowers/plans/`：实现计划。
- `docs/superpowers/tasks/`：任务拆分和完成状态。

## 9. 手动运行

安装依赖：

```powershell
npm install
```

检查类型：

```powershell
npm run typecheck
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
Loaded 1 local skill(s) from skills
```

## 10. 常见问题

### 为什么 VSCode Debug Console 没有日志？

如果你在终端运行 `npm run dev`，日志会输出到运行命令的终端，不会自动进入 VSCode Debug Console。只有通过 VSCode debugger 启动进程时，日志才会进入 Debug Console。

### Agent 能直接使用 Shell 吗？

不能直接使用无限制 Shell。当前实现只支持通过 `skill_run_shell` 执行受限命令，并且必须同时满足：

- `.env` 中 `ENABLE_SKILL_SHELL=true`。
- 对应 `SKILL.md` 中明确 allowlist 了该命令。
- 命令没有被安全规则阻止。

### API key 为什么不写在 `src/config.ts`？

`src/config.ts` 是代码，会被版本控制追踪。API key 属于密钥，只应该放在本地 `.env`。这样可以避免误提交、泄露或被前端打包暴露。

### 如何添加新的 skill？

创建目录：

```text
skills/my-skill/SKILL.md
```

建议结构：

```markdown
# My Skill

Description: 简短说明这个 skill 的用途。

## When To Use

说明什么时候使用。

## Inference Rules

- 规则 1
- 规则 2

## Scripts

说明可用脚本。

## Allowed Shell Commands

- `npm run typecheck`
```

重启 `npm run dev` 后，Agent 可以通过 `skill_list` 看到新的 skill。

## 11. 后续可改进项

- 增加 VSCode `launch.json`，让用户可以从 Debug Console 启动服务。
- 给 Skill 增加更严格的 schema，例如 frontmatter 元数据。
- 增加工具调用审计日志。
- 增加测试模式，在没有真实 SmartThings 和 ROS2 环境时使用 mock connector。
- 把 session 记忆从内存迁移到本地数据库或文件。
