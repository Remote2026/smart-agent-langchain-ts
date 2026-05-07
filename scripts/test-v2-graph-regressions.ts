import assert from "node:assert/strict";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { buildV2Graph } from "../src/agent/v2/graph.js";

type PromptResponse = {
  content: string;
};

const fakeLlm = {
  async invoke(messages: unknown[]): Promise<PromptResponse> {
    const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
    const content = typeof (last as any)?.content === "string" ? (last as any).content : "";

    if (content.includes("Classify the user's request")) {
      return { content: JSON.stringify({ intent: "smartthings", confidence: "high", rationale_short: "device request" }) };
    }

    if (content.includes("You extract a SmartThings action")) {
      return { content: JSON.stringify({ action: "list_devices" }) };
    }

    return { content: "fallback response" };
  }
};

let listDeviceCalls = 0;
const listDevicesTool = {
  name: "smartthings_list_devices",
  async invoke(): Promise<unknown> {
    listDeviceCalls += 1;
    if (listDeviceCalls === 1) {
      return { devices: [{ id: "dev-1", label: "Lamp" }] };
    }
    throw new Error("simulated SmartThings outage");
  }
};

async function runTurn(graph: ReturnType<typeof buildV2Graph>, text: string) {
  const chunks: any[] = [];
  const stream = await graph.stream(
    {
      sessionId: "regression-session",
      input: { kind: "text", text },
      messages: [new HumanMessage(text)],
      graphEvents: []
    },
    {
      streamMode: "values",
      recursionLimit: 12,
      configurable: { thread_id: "regression-session" }
    }
  );

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks[chunks.length - 1];
}

const graph = buildV2Graph({
  llm: fakeLlm as any,
  tools: [listDevicesTool as any],
  systemPrompt: "test system prompt",
  checkpointer: new MemorySaver()
});

const first = await runTurn(graph, "list smartthings devices");
assert.deepEqual(
  first.graphEvents.map((event: any) => event.node ?? event.name),
  [
    "ingest",
    "ingest",
    "router_intent",
    "router_intent",
    "smartthings_node",
    "smartthings_list_devices",
    "smartthings_list_devices",
    "smartthings_node",
    "respond",
    "respond",
    "finalize",
    "finalize"
  ],
  "graphEvents should accumulate events from every node in the current turn"
);

const second = await runTurn(graph, "list smartthings devices again");
assert.equal(second.graphEvents[0]?.node, "ingest", "second turn graphEvents should start from the current turn");
assert.equal(
  second.graphEvents.filter((event: any) => event.node === "ingest").length,
  2,
  "second turn graphEvents should not include checkpointed events from prior turns"
);
assert.equal(second.toolResults?.ok, false, "tool failure should replace previous successful toolResults");
assert.equal(second.toolResults?.error, "simulated SmartThings outage");
assert.equal(second.finalText.includes("Lamp"), false, "failed second turn should not reuse first turn device list");

console.log("[test-v2-graph-regressions] ok");
