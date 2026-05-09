/**
 * 测试程序：发送设备状态变化到 POST /api/device-event 并打印响应。
 *
 * 用法：
 *   1) 先启动服务：npm run dev
 *   2) 运行：npm run test:device-event
 *      或指定参数：tsx scripts/test-device-event.ts --deviceId xxx --name "门磁" --capability contact --prev open --curr closed
 */

const baseUrl = process.env.SMART_AGENT_BASE_URL ?? "http://localhost:3000";

function parseArgs(): {
  deviceId: string;
  deviceName: string;
  capability: string;
  previousValue: string;
  currentValue: string;
} {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
  };

  return {
    deviceId: get("--deviceId", "test-device-001"),
    deviceName: get("--name", "测试门磁传感器"),
    capability: get("--capability", "contact"),
    previousValue: get("--prev", "open"),
    currentValue: get("--curr", "closed"),
  };
}

async function main() {
  const payload = {
    ...parseArgs(),
    timestamp: new Date().toISOString(),
  };

  console.log(`[test-device-event] POST ${baseUrl}/api/device-event`);
  console.log(`  payload:`, JSON.stringify(payload, null, 2));

  const res = await fetch(`${baseUrl}/api/device-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await res.json();
  console.log(`  status: ${res.status}`);
  console.log(`  response:`, body);
}

main().catch((err) => {
  console.error("[test-device-event] failed:", err);
  process.exitCode = 1;
});
