import assert from "node:assert/strict";
import { DeviceEventRequestSchema } from "../src/agent/v2/state.js";
import { parseDeviceEventArgs } from "./test-device-event.js";

const payload = parseDeviceEventArgs([
  "--deviceId",
  "switch-001",
  "--name",
  "Kitchen Light",
  "--label",
  "厨房灯",
  "--type",
  "switch",
  "--from",
  "Off",
  "--status",
  "On"
]);

assert.deepEqual(payload, {
  deviceId: "switch-001",
  name: "Kitchen Light",
  label: "厨房灯",
  type: "switch",
  previousStatus: "Off",
  status: "On"
});

assert.equal(DeviceEventRequestSchema.safeParse(payload).success, true);

const defaultPayload = parseDeviceEventArgs([]);
assert.equal(defaultPayload.status, "On");

console.log("[test-device-event-args] ok");
