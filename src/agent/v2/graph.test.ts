import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { buildV2Graph } from "./graph.js";

const mockToolFunc = vi.fn().mockResolvedValue("tool result");

const mockTool = {
  name: "test_tool",
  description: "A test tool",
  schema: { parse: (v: unknown) => v },
  func: mockToolFunc,
  invoke: async (input: unknown) => mockToolFunc(input),
} as any;

function makeGraph(llmInvokeMock: any) {
  const mockLlm = {
    bindTools: vi.fn().mockReturnValue({ invoke: llmInvokeMock }),
  } as any;

  return buildV2Graph({
    llm: mockLlm,
    tools: [mockTool],
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

  it("enforces 5-round loop limit", async () => {
    // LLM always returns tool_calls, but loop should cap at 5
    const graph = makeGraph(
      vi.fn().mockResolvedValue(
        new AIMessage({
          content: "",
          tool_calls: [{ name: "test_tool", args: {}, id: "call-1" }],
        })
      )
    );

    const result = await graph.invoke(
      {
        sessionId: "test",
        input: { kind: "text", text: "infinite loop" },
        messages: [new HumanMessage("infinite loop")],
        graphEvents: [],
        agentLoopCount: 0,
      },
      { configurable: { thread_id: "test-limit" } }
    );

    expect(result.agentLoopCount).toBe(5);
    // All AIMessages have tool_calls, so respondNode finds no pure AIMessage
    expect(result.finalText).toBe("");
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
