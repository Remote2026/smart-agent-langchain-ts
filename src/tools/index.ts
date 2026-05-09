import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { RosbridgeClient } from "./ros2.js";
import { SmartThingsClient } from "./smartthings.js";

export function createTools(options: {
  smartThings: SmartThingsClient;
  rosbridge: RosbridgeClient;
}) {
  const { smartThings, rosbridge } = options;
  const setSwitchInput = z.object({
    deviceId: z.string().min(1),
    on: z.boolean()
  });
  const setLevelInput = z.object({
    deviceId: z.string().min(1),
    level: z.number().int().min(0).max(100)
  });
  const getParamInput = z.object({
    node: z.string().min(1).describe("ROS2 node name"),
    name: z.string().min(1).describe("ROS2 parameter name")
  });
  const setParamInput = getParamInput.extend({
    value: z.unknown().describe("JSON-serializable parameter value")
  });
  return [
    new DynamicStructuredTool({
      name: "smartthings_list_devices",
      description: "List SmartThings devices available to the configured personal access token.",
      schema: z.object({}),
      func: async () => JSON.stringify(await smartThings.listDevices())
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
      name: "ros2_get_param",
      description: "Get a ROS2 parameter through rosbridge rosapi.",
      schema: getParamInput,
      func: async (input) => {
        const { node, name } = getParamInput.parse(input);
        return JSON.stringify(await rosbridge.getParam(node, name));
      }
    }),
    new DynamicStructuredTool({
      name: "ros2_set_param",
      description: "Set a ROS2 parameter through rosbridge rosapi.",
      schema: setParamInput,
      func: async (input) => {
        const { node, name, value } = setParamInput.parse(input);
        return JSON.stringify(await rosbridge.setParam(node, name, value));
      }
    })
  ];
}
