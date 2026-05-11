import assert from "node:assert/strict";
import { DEFAULT_SESSION_ID } from "../src/session.js";

assert.equal(DEFAULT_SESSION_ID, "web-default-session");

console.log("[test-fixed-session-id] ok");
