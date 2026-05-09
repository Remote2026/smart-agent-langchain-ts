import { execSync } from "child_process";

export type SmartThingsDevice = {
  id: string;
  name: string;
  label?: string;
  type?: string;
};

export class SmartThingsClient {
  listDevices(): { devices: SmartThingsDevice[] } {
    const raw = execSync("smartthings devices -j", {
      encoding: "utf-8",
      timeout: 60000,
    }).trim();
    const items = JSON.parse(raw) as Array<{
      deviceId: string;
      name: string;
      label?: string;
      type?: string;
    }>;
    return {
      devices: items.map((d) => ({
        id: d.deviceId,
        name: d.name,
        label: d.label,
        type: d.type,
      })),
    };
  }

  async setSwitch(_deviceId: string, _on: boolean): Promise<{ ok: true }> {
    console.warn("setSwitch not yet implemented (pending CLI integration)");
    return { ok: true };
  }

  async setLevel(_deviceId: string, _level: number): Promise<{ ok: true }> {
    console.warn("setLevel not yet implemented (pending CLI integration)");
    return { ok: true };
  }

  getDeviceStatus(deviceId: string): unknown {
    const raw = execSync(`smartthings devices:status ${deviceId} -j`, {
      encoding: "utf-8",
      timeout: 60000,
    }).trim();
    return JSON.parse(raw);
  }
}
