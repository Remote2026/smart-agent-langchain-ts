/**
 * 测试程序：发送设备最新状态到 POST /api/device-event 并打印响应。
 *
 * 用法：
 *   1) 先启动服务：npm run dev
 *   2) 运行：npm run test:device-event
 *      或指定参数：tsx scripts/test-device-event.ts --deviceId xxx --name "灯" --label "厨房灯" --type "switch" --from Off --status On
 */
import { fileURLToPath } from "node:url";

const baseUrl = process.env.SMART_AGENT_BASE_URL ?? "http://localhost:3000";

export type DeviceEventPayload = {
  deviceId: string;
  name: string;
  label?: string;
  type?: string;
  previousStatus?: string;
  status: string;
};

export function parseDeviceEventArgs(args: string[]): DeviceEventPayload {
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  return {
    deviceId: get("--deviceId") || "test-device-001",
    name: get("--name") || "测试门磁传感器",
    label: get("--label"),
    type: get("--type"),
    previousStatus: get("--previousStatus") || get("--from"),
    status: get("--status") || "On",
  };
}

async function main() {
  const payload = parseDeviceEventArgs(process.argv.slice(2));

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[test-device-event] failed:", err);
    process.exitCode = 1;
  });
}
