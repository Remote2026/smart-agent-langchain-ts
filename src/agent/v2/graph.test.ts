import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { buildV2Graph } from "./graph.js";

const mockToolFunc = vi.fn().mockResolvedValue("tool result");
const mockTool2Func = vi.fn().mockResolvedValue("tool2 result");

const mockTool = {
  name: "test_tool",
  description: "A test tool",
  schema: { parse: (v: unknown) => v },
  func: mockToolFunc,
  invoke: async (input: unknown) => mockToolFunc(input),
} as any;

const mockTool2 = {
  name: "test_tool_2",
  description: "Another test tool",
  schema: { parse: (v: unknown) => v },
  func: mockTool2Func,
  invoke: async (input: unknown) => mockTool2Func(input),
} as any;

function makeGraph(llmInvokeMock: any) {
  return makeGraphWithTools(llmInvokeMock, [mockTool]);
}

function makeGraphWithTools(llmInvokeMock: any, tools: any[]) {
  const mockLlm = {
    bindTools: vi.fn().mockReturnValue({ invoke: llmInvokeMock }),
  } as any;

  return buildV2Graph({
    llm: mockLlm,
    tools,
    systemPrompt: "You are a test assistant.",
    checkpointer: SqliteSaver.fromConnString(":memory:"),
  });
}

describe("buildV2Graph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("compiles successfully", () => {
    const graph = makeGraph(vi.fn());
    expect(graph).toBeDefined();
    expect(typeof graph.invoke).toBe("function");
  });

  it("prepare → llm_call → respond for text-only response", async () => {
    const graph = makeGraph(
      vi.fn().mockResolvedValue(new AIMessage("Hello from LLM"))
    );

    const result = await graph.invoke(
      {
        sessionId: "test",
        input: { kind: "text", text: "hi" },
        messages: [new HumanMessage("hi")],
        graphEvents: [],
        agentLoopCount: 0,
      },
      { configurable: { thread_id: "test-text" } }
    );

    expect(result.finalText).toBe("Hello from LLM");
    expect(result.agentLoopCount).toBe(1);
    expect(result.messages.length).toBeGreaterThanOrEqual(2); // HumanMessage + SystemMessage + AIMessage
  });

  it("runs tool loop when LLM returns tool_calls", async () => {
    mockTool.func.mockResolvedValueOnce("device list");

    const graph = makeGraph(
      vi
        .fn()
        .mockResolvedValueOnce(
          new AIMessage({
            content: "",
            tool_calls: [{ name: "test_tool", args: {}, id: "call-1" }],
          })
        )
        .mockResolvedValueOnce(new AIMessage("Done"))
    );

    const result = await graph.invoke(
      {
        sessionId: "test",
        input: { kind: "text", text: "list devices" },
        messages: [new HumanMessage("list devices")],
        graphEvents: [],
        agentLoopCount: 0,
      },
      { configurable: { thread_id: "test-loop" } }
    );

    expect(mockTool.func).toHaveBeenCalledTimes(1);
    expect(result.finalText).toBe("Done");
    expect(result.agentLoopCount).toBe(2);
  });

  it("enforces per-tool streak limit of 3", async () => {
    // LLM always returns tool_calls for the same tool.
    // Tool executes 3 times; the 4th invocation is blocked before tool_node.
    let callIdx = 0;
    const graph = makeGraph(
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new AIMessage({
            content: "",
            tool_calls: [{ name: "test_tool", args: {}, id: `call-${++callIdx}` }],
          })
        )
      )
    );

    const result = await graph.invoke(
      {
        sessionId: "test",
        input: { kind: "text", text: "infinite loop" },
        messages: [new HumanMessage("infinite loop")],
        graphEvents: [],
        agentLoopCount: 0,
        currentStreakTool: "",
        toolStreak: 0,
        totalToolCalls: 0,
      },
      { configurable: { thread_id: "test-limit" }, recursionLimit: 35 }
    );

    // 3 executions + 1 blocked llm_call = 4 rounds
    expect(result.agentLoopCount).toBe(4);
    expect(result.toolStreak).toBe(3);
    expect(result.totalToolCalls).toBe(3);
    expect(result.finalText).toBe("");
  });

  it("enforces total tool call limit of 10", async () => {
    // LLM alternates between two tools. Total calls cap at 10.
    let callIdx = 0;
    const graph = makeGraphWithTools(
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new AIMessage({
            content: "",
            tool_calls: [{
              name: callIdx % 2 === 0 ? "test_tool" : "test_tool_2",
              args: {},
              id: `call-${++callIdx}`,
            }],
          })
        )
      ),
      [mockTool, mockTool2]
    );

    const result = await graph.invoke(
      {
        sessionId: "test",
        input: { kind: "text", text: "loop" },
        messages: [new HumanMessage("loop")],
        graphEvents: [],
        agentLoopCount: 0,
        currentStreakTool: "",
        toolStreak: 0,
        totalToolCalls: 0,
      },
      { configurable: { thread_id: "test-total" }, recursionLimit: 35 }
    );

    // 10 executions + 1 blocked llm_call = 11 rounds
    expect(result.agentLoopCount).toBe(11);
    expect(result.totalToolCalls).toBe(10);
    expect(result.finalText).toBe("");
  });

  it("resets streak when tool changes", async () => {
    // Sequence: A -> A -> B -> A -> A -> A.
    // A's streak resets to 1 after B, so A can do 3 more before blocked.
    let round = 0;
    const graph = makeGraphWithTools(
      vi.fn().mockImplementation(() => {
        round++;
        const toolName = round === 3 ? "test_tool_2" : "test_tool";
        return Promise.resolve(
          new AIMessage({
            content: "",
            tool_calls: [{ name: toolName, args: {}, id: `call-${round}` }],
          })
        );
      }),
      [mockTool, mockTool2]
    );

    const result = await graph.invoke(
      {
        sessionId: "test",
        input: { kind: "text", text: "mixed" },
        messages: [new HumanMessage("mixed")],
        graphEvents: [],
        agentLoopCount: 0,
        currentStreakTool: "",
        toolStreak: 0,
        totalToolCalls: 0,
      },
      { configurable: { thread_id: "test-mixed" }, recursionLimit: 35 }
    );

    // A(2) + B(1) + A(3) = 6 executions, then 7th llm_call blocked
    expect(result.totalToolCalls).toBe(6);
    expect(result.toolStreak).toBe(3);
    expect(result.currentStreakTool).toBe("test_tool");
    expect(result.agentLoopCount).toBe(7);
  });

  it("records graph events during execution", async () => {
    const graph = makeGraph(
      vi.fn().mockResolvedValue(new AIMessage("ok"))
    );

    const result = await graph.invoke(
      {
        sessionId: "test",
        input: { kind: "text", text: "hi" },
        messages: [new HumanMessage("hi")],
        graphEvents: [],
        agentLoopCount: 0,
      },
      { configurable: { thread_id: "test-events" } }
    );

    expect(result.graphEvents.length).toBeGreaterThan(0);
    const nodeNames = result.graphEvents.map((e: any) =>
      e.type === "node" ? e.node : e.type === "tool" ? e.name : null
    );
    expect(nodeNames).toContain("prepare");
    expect(nodeNames).toContain("llm_call");
    expect(nodeNames).toContain("respond");
  });

  it("deduplicates SystemMessage across rounds", async () => {
    const graph = makeGraph(
      vi.fn().mockResolvedValue(new AIMessage("ok"))
    );

    // First invocation
    await graph.invoke(
      {
        sessionId: "test",
        input: { kind: "text", text: "first" },
        messages: [new HumanMessage("first")],
        graphEvents: [],
        agentLoopCount: 0,
      },
      { configurable: { thread_id: "test-dedup" } }
    );

    // Second invocation (checkpoint restored)
    const result = await graph.invoke(
      {
        sessionId: "test",
        input: { kind: "text", text: "second" },
        messages: [new HumanMessage("second")],
        graphEvents: [],
        agentLoopCount: 0,
      },
      { configurable: { thread_id: "test-dedup" } }
    );

    const systemCount = result.messages.filter(
      (m: any) => m._getType?.() === "system"
    ).length;
    expect(systemCount).toBeLessThanOrEqual(1);
  });
});
