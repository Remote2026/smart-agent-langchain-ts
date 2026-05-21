import { execSync } from "child_process";
import { createLogger } from "../utils/logger.js";

const log = createLogger("smartthings.ts");

export type SmartThingsDevice = {
  id: string;
  name: string;
  label?: string;
  type?: string;
};

export class SmartThingsClient {
  private token: string;

  constructor(token?: string) {
    this.token = token ?? process.env.SMARTTHINGS_ACCESS_TOKEN ?? process.env.SMARTTHINGS_PAT ?? "";
  }

  setToken(token: string): void {
    this.token = token;
  }

  private cliArgs(cmd: string): string {
    return this.token ? `${cmd} --token=${this.token}` : cmd;
  }

  listDevices(): { devices: SmartThingsDevice[] } {
    const raw = execSync(this.cliArgs("smartthings devices"), {
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

  setSwitch(deviceId: string, on: boolean): { ok: true } {
    const cmd = `smartthings devices:commands ${deviceId} 'switch:${on ? "on" : "off"}'`;
    execSync(this.cliArgs(cmd), { encoding: "utf-8", timeout: 30000 });
    return { ok: true };
  }

  setLevel(deviceId: string, level: number): { ok: true } {
    const cmd = `smartthings devices:commands ${deviceId} 'switchLevel:setLevel(${level})'`;
    execSync(this.cliArgs(cmd), { encoding: "utf-8", timeout: 30000 });
    return { ok: true };
  }

  getDeviceStatus(deviceId: string): unknown {
    const raw = execSync(this.cliArgs(`smartthings devices:status ${deviceId} -j`), {
      encoding: "utf-8",
      timeout: 60000,
    }).trim();
    return JSON.parse(raw);
  }
}
