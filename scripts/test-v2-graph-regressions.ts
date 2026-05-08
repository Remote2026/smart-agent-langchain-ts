import assert from "node:assert/strict";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { buildV2Graph } from "../src/agent/v2/graph.js";
import type { BaseMessage } from "@langchain/core/messages";

// ── fake LLM with bindTools ──────────────────────────────────────────

let toolCallRound = 0;

const fakeLlm = {
  bindTools(_tools: unknown[]) {
    return this;
  },
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    const last = messages[messages.length - 1];
    const content = typeof last?.content === "string" ? last.content : "";

    // router_intent classification prompt
    if (content.includes("Classify the user's request")) {
      return new AIMessage(JSON.stringify({
        intent: "smartthings",
        confidence: "high",
        rationale_short: "device control request"
      }));
    }

    // llm_call: first round → return tool_calls, second round → final text
    toolCallRound += 1;
    if (toolCallRound === 1) {
      return new AIMessage({
        content: "",
        tool_calls: [{
          id: "call_1",
          name: "smartthings_list_devices",
          args: {}
        }]
      });
    }
    return new AIMessage("Here are your SmartThings devices:\n1. Lamp (dev-1)");
  }
};

// ── fake LLM: always returns tool_calls (for loop-limit test) ───────

const infiniteToolLlm = {
  bindTools(_tools: unknown[]) {
    return this;
  },
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    const last = messages[messages.length - 1];
    const content = typeof last?.content === "string" ? last.content : "";

    if (content.includes("Classify the user's request")) {
      return new AIMessage(JSON.stringify({
        intent: "smartthings",
        confidence: "high",
        rationale_short: "device request"
      }));
    }

    return new AIMessage({
      content: "",
      tool_calls: [{ id: "loop_call", name: "smartthings_list_devices", args: {} }]
    });
  }
};

// ── fake LLM: default route (no tool calls) ─────────────────────────

const defaultFakeLlm = {
  bindTools(_tools: unknown[]) {
    return this;
  },
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    const last = messages[messages.length - 1];
    const content = typeof last?.content === "string" ? last.content : "";

    if (content.includes("Classify the user's request")) {
      return new AIMessage(JSON.stringify({
        intent: "default",
        confidence: "high",
        rationale_short: "casual chat"
      }));
    }

    return new AIMessage("Hello! How can I help you today?");
  }
};

// ── fake tool ────────────────────────────────────────────────────────

let listDeviceCalls = 0;
const listDevicesTool = {
  name: "smartthings_list_devices",
  description: "List SmartThings devices",
  schema: { parse: (x: unknown) => x },
  async invoke(_input: unknown): Promise<string> {
    listDeviceCalls += 1;
    return JSON.stringify({ devices: [{ id: "dev-1", label: "Lamp" }] });
  }
};

// ── helpers ──────────────────────────────────────────────────────────

async function runTurn(graph: ReturnType<typeof buildV2Graph>, text: string, threadId: string) {
  const chunks: any[] = [];
  const stream = await graph.stream(
    {
      sessionId: threadId,
      input: { kind: "text", text },
      messages: [new HumanMessage(text)],
      graphEvents: []
    },
    {
      streamMode: "values",
      recursionLimit: 15,
      configurable: { thread_id: threadId }
    }
  );

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return { chunks, final: chunks[chunks.length - 1] };
}

function nodeNames(state: any): string[] {
  return (state.graphEvents as any[]).filter((e: any) => e.type === "node").map((e: any) => e.node);
}

// ── Test 1: smartthings route with tool calling ──────────────────────

console.log("[test] 1. smartthings route with tool calling...");
{
  toolCallRound = 0;
  const graph = buildV2Graph({
    llm: fakeLlm as any,
    tools: [listDevicesTool as any],
    systemPrompt: "test system prompt",
    checkpointer: new MemorySaver()
  });

  const { final } = await runTurn(graph, "list my devices", "test-1");

  // Check node sequence
  assert.deepEqual(
    [...new Set(nodeNames(final))],
    ["ingest", "router_intent", "prepare_agent", "llm_call", "tool_node", "respond"],
    "should visit all 6 nodes"
  );

  // Check system prompt was injected
  assert.equal(
    final.finalText,
    "Here are your SmartThings devices:\n1. Lamp (dev-1)",
    "finalText should be LLM's last response"
  );

  console.log("   ok");
}

// ── Test 2: default route (no tool calls) ────────────────────────────

console.log("[test] 2. default route without tool calls...");
{
  toolCallRound = 0;
  const graph = buildV2Graph({
    llm: defaultFakeLlm as any,
    tools: [listDevicesTool as any],
    systemPrompt: "test system prompt",
    checkpointer: new MemorySaver()
  });

  const { final } = await runTurn(graph, "hello", "test-2");

  const names = nodeNames(final);
  assert.equal(
    names.includes("tool_node"),
    false,
    "default route should not trigger tool_node"
  );
  assert.equal(
    names.includes("respond"),
    true,
    "should reach respond node"
  );
  assert.equal(
    final.finalText,
    "Hello! How can I help you today?",
    "finalText should be LLM response"
  );

  console.log("   ok");
}

// ── Test 3: loop limit (max 5 iterations) ────────────────────────────

console.log("[test] 3. loop limit (max 5 iterations)...");
{
  toolCallRound = 0;
  const graph = buildV2Graph({
    llm: infiniteToolLlm as any,
    tools: [listDevicesTool as any],
    systemPrompt: "test system prompt",
    checkpointer: new MemorySaver()
  });

  const { final } = await runTurn(graph, "do something", "test-3");

  // Count llm_call events — should be 5 (max iterations)
  const llmCallCount = nodeNames(final).filter((n: string) => n === "llm_call").length;
  assert.equal(llmCallCount, 10, "llm_call should emit 10 events (5 calls × start+end)");

  // Should still reach respond after loop limit
  assert.equal(
    nodeNames(final).includes("respond"),
    true,
    "should reach respond after loop limit"
  );

  console.log("   ok");
}

// ── Test 4: second turn should have clean graphEvents ────────────────

console.log("[test] 4. second turn graphEvents are isolated...");
{
  toolCallRound = 0;
  const graph = buildV2Graph({
    llm: fakeLlm as any,
    tools: [listDevicesTool as any],
    systemPrompt: "test system prompt",
    checkpointer: new MemorySaver()
  });

  const first = await runTurn(graph, "list devices", "test-4");
  const firstEventCount = (first.final.graphEvents as any[]).length;

  toolCallRound = 0;
  const second = await runTurn(graph, "list devices again", "test-4");
  const secondEventCount = (second.final.graphEvents as any[]).length;

  // Both turns should have similar event counts (not accumulated)
  assert.equal(
    secondEventCount >= firstEventCount - 2 && secondEventCount <= firstEventCount + 2,
    true,
    `second turn events (${secondEventCount}) should be similar to first (${firstEventCount})`
  );
  assert.equal(
    second.final.graphEvents[0]?.node,
    "ingest",
    "second turn should start with ingest"
  );

  console.log("   ok");
}

// ── Test 5: system prompt only injected once per session ─────────────

console.log("[test] 5. system prompt injected only once...");
{
  toolCallRound = 0;
  const graph = buildV2Graph({
    llm: fakeLlm as any,
    tools: [listDevicesTool as any],
    systemPrompt: "test system prompt",
    checkpointer: new MemorySaver()
  });

  // First turn
  toolCallRound = 0;
  await runTurn(graph, "list devices", "test-5");

  // Second turn — check messages don't have duplicate system prompts
  toolCallRound = 0;
  const { final } = await runTurn(graph, "list devices again", "test-5");

  const systemCount = (final.messages as BaseMessage[]).filter(m => m instanceof SystemMessage).length;
  assert.equal(systemCount, 1, "should only have one SystemMessage after two turns");

  console.log("   ok");
}

// ── Test 6: toolResults accumulates across rounds ────────────────────

console.log("[test] 6. toolResults accumulates...");
{
  toolCallRound = 0;
  const graph = buildV2Graph({
    llm: fakeLlm as any,
    tools: [listDevicesTool as any],
    systemPrompt: "test system prompt",
    checkpointer: new MemorySaver()
  });

  const { final } = await runTurn(graph, "list devices", "test-6");

  assert.equal(
    Array.isArray(final.toolResults),
    true,
    "toolResults should be an array"
  );
  assert.equal(
    final.toolResults.length,
    1,
    "should have 1 tool result"
  );
  assert.equal(
    final.toolResults[0].name,
    "smartthings_list_devices",
    "tool result should track tool name"
  );

  console.log("   ok");
}

console.log("[test-v2-graph-regressions] all passed");
