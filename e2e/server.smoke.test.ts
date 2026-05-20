import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import net from "net";

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        srv.close(() => resolve(addr.port));
      } else {
        srv.close(() => reject(new Error("Unable to get free port")));
      }
    });
  });
}

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Server did not start in time: ${url}`));
      }
      setTimeout(check, 200);
    };
    check();
  });
}

describe("Server E2E", () => {
  let server: ChildProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://localhost:${port}`;

    server = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        SLACK_ENABLED: "false",
        SLACK_MIRROR_WEB_MESSAGES: "false",
      },
      stdio: "pipe",
    });

    // Suppress server output in test logs
    server.stdout?.on("data", () => {});
    server.stderr?.on("data", () => {});

    await waitForServer(`${baseUrl}/api/health`);
  }, 20000);

  afterAll(() => {
    if (server && !server.killed) {
      server.kill("SIGTERM");
    }
  });

  it("/api/health returns ok", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it("/api/session/clear returns ok", async () => {
    const res = await fetch(`${baseUrl}/api/session/clear`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it("/api/events establishes SSE connection", async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    res.body?.cancel();
  });

  it("/api/chat rejects invalid request body with SSE error", async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(200); // SSE endpoint returns 200 even for errors
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("Invalid request body");
  });

  it("/api/device-event rejects invalid body with 400", async () => {
    const res = await fetch(`${baseUrl}/api/device-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it("serves static files from public/", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("html");
  });
});
