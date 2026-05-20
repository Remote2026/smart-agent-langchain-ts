import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { SmartThingsClient } from "./smartthings.js";
import { refreshAndSaveTokens } from "./smartthings-auth.js";
import { createRobotTools } from "./robot.js";
import type { FoxgloveClient } from "../foxglove/client.js";

export function createTools(options: {
  smartThings: SmartThingsClient;
  foxglove: FoxgloveClient;
}) {
  const { smartThings, foxglove } = options;
  const getDeviceStatusInput = z.object({
    deviceId: z.string().min(1).describe("SmartThings device ID")
  });
  const setSwitchInput = z.object({
    deviceId: z.string().min(1),
    on: z.boolean()
  });
  const setLevelInput = z.object({
    deviceId: z.string().min(1),
    level: z.number().int().min(0).max(100)
  });
  return [
    new DynamicStructuredTool({
      name: "smartthings_list_devices",
      description: "List SmartThings devices available via SmartThings CLI. get device id, name, label and type and etc.",
      schema: z.object({}),
      func: async () => JSON.stringify(await smartThings.listDevices())
    }),
    new DynamicStructuredTool({
      name: "smartthings_get_device_status",
      description: "Get detailed status of a specific SmartThings device by its ID.",
      schema: getDeviceStatusInput,
      func: async (input) => {
        const { deviceId } = getDeviceStatusInput.parse(input);
        return JSON.stringify(await smartThings.getDeviceStatus(deviceId));
      }
    }),
    new DynamicStructuredTool({
      name: "smartthings_set_switch",
      description: "Turn a SmartThings switch-capable device on or off.",
      schema: setSwitchInput,
      func: async (input) => {
        const { deviceId, on } = setSwitchInput.parse(input);
        return JSON.stringify(await smartThings.setSwitch(deviceId, on));
      }
    }),
    new DynamicStructuredTool({
      name: "smartthings_set_level",
      description: "Set brightness level for a SmartThings light or dimmer. Level must be 0-100.",
      schema: setLevelInput,
      func: async (input) => {
        const { deviceId, level } = setLevelInput.parse(input);
        return JSON.stringify(await smartThings.setLevel(deviceId, level));
      }
    }),
    new DynamicStructuredTool({
      name: "smartthings_refresh_token",
      description: "Refresh SmartThings OAuth access token using the refresh token. Updates .env and CLI config with new tokens. Only call this when token expiry is suspected.",
      schema: z.object({}),
      func: async () => {
        const refreshToken = process.env.SMARTTHINGS_REFRESH_TOKEN;
        const clientId = process.env.SMARTTHINGS_CLIENT_ID;
        if (!refreshToken) {
          return JSON.stringify({ error: "SMARTTHINGS_REFRESH_TOKEN not configured in .env" });
        }
        if (!clientId) {
          return JSON.stringify({ error: "SMARTTHINGS_CLIENT_ID not configured in .env" });
        }
        try {
          const tokens = await refreshAndSaveTokens(refreshToken, clientId);
          smartThings.setToken(tokens.access_token);
          return JSON.stringify({
            ok: true,
            message: "Token refreshed and saved successfully",
            expires_in: tokens.expires_in,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return JSON.stringify({ error: msg });
        }
      }
    }),
    ...createRobotTools(foxglove),
  ];
}
