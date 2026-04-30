export type SmartThingsDevice = {
  id: string;
  name: string;
  label?: string;
};

type SmartThingsDeviceResponse = {
  items?: Array<{
    deviceId: string;
    name: string;
    label?: string;
  }>;
};

export class SmartThingsClient {
  constructor(private readonly personalAccessToken?: string) {}

  async listDevices(): Promise<{ devices: SmartThingsDevice[] }> {
    const data = await this.request<SmartThingsDeviceResponse>("/devices");
    return {
      devices: (data.items ?? []).map((device) => ({
        id: device.deviceId,
        name: device.name,
        label: device.label
      }))
    };
  }

  async setSwitch(deviceId: string, on: boolean): Promise<{ ok: true }> {
    this.assertDeviceId(deviceId);
    await this.command(deviceId, {
      capability: "switch",
      command: on ? "on" : "off"
    });
    return { ok: true };
  }

  async setLevel(deviceId: string, level: number): Promise<{ ok: true }> {
    this.assertDeviceId(deviceId);
    if (!Number.isInteger(level) || level < 0 || level > 100) {
      throw new Error("Brightness level must be an integer between 0 and 100.");
    }

    await this.command(deviceId, {
      capability: "switchLevel",
      command: "setLevel",
      arguments: [level]
    });
    return { ok: true };
  }

  private async command(
    deviceId: string,
    command: { capability: string; command: string; arguments?: unknown[] }
  ): Promise<void> {
    await this.request(`/devices/${encodeURIComponent(deviceId)}/commands`, {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            component: "main",
            capability: command.capability,
            command: command.command,
            arguments: command.arguments ?? []
          }
        ]
      })
    });
  }

  private async request<T = unknown>(route: string, init: RequestInit = {}): Promise<T> {
    if (!this.personalAccessToken) {
      throw new Error("SMARTTHINGS_PAT is not configured.");
    }

    const response = await fetch(`https://api.smartthings.com/v1${route}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.personalAccessToken}`,
        "Content-Type": "application/json",
        ...init.headers
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`SmartThings request failed (${response.status}): ${body}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private assertDeviceId(deviceId: string): void {
    if (!deviceId.trim()) {
      throw new Error("deviceId is required.");
    }
  }
}
