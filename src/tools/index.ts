import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { DeviceAliases } from "../config.js";
import type { SkillManager } from "../skill-runtime/skill-manager.js";
import { RosbridgeClient } from "./ros2.js";
import { SmartThingsClient } from "./smartthings.js";

export function createTools(options: {
  smartThings: SmartThingsClient;
  rosbridge: RosbridgeClient;
  aliases: DeviceAliases;
  skills?: SkillManager;
}) {
  const { smartThings, rosbridge, aliases, skills } = options;
  const aliasInput = z.object({
    alias: z.string().min(1).describe("Natural-language device name or alias")
  });
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
  const skillNameInput = z.object({
    skillName: z.string().min(1).describe("Skill directory name under the configured skills directory")
  });
  const skillShellInput = skillNameInput.extend({
    command: z.string().min(1).describe("Shell command allowed by the skill's SKILL.md"),
    timeoutMs: z.number().int().min(1000).max(30000).optional()
  });

  const tools = [
    new DynamicStructuredTool({
      name: "smartthings_resolve_alias",
      description:
        "Resolve a natural-language device alias such as 客厅灯 to a SmartThings deviceId. Use before controlling a named device.",
      schema: aliasInput,
      func: async (input) => {
        const { alias } = aliasInput.parse(input);
        const match = aliases.aliases[alias];
        if (!match) {
          return JSON.stringify({
            found: false,
            message: "Alias not found. Use smartthings_list_devices or ask the user to choose a device."
          });
        }

        return JSON.stringify({ found: true, ...match });
      }
    }),
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

  if (!skills) {
    return tools;
  }

  return [
    ...tools,
    new DynamicStructuredTool({
      name: "skill_list",
      description: "List installed local skills loaded from SKILL.md files.",
      schema: z.object({}),
      func: async () => JSON.stringify(skills.listSkills())
    }),
    new DynamicStructuredTool({
      name: "skill_read",
      description: "Read the full SKILL.md instructions for a local skill before using it.",
      schema: skillNameInput,
      func: async (input) => {
        const { skillName } = skillNameInput.parse(input);
        const skill = skills.getSkill(skillName);
        return JSON.stringify({
          name: skill.name,
          path: skill.path,
          description: skill.description,
          shellEnabled: skill.shellEnabled,
          allowedShellCommands: skill.allowedShellCommands,
          content: skill.content
        });
      }
    }),
    new DynamicStructuredTool({
      name: "skill_run_shell",
      description:
        "Run a local shell command only when it is explicitly allowed by the named skill's SKILL.md. Use after reading the relevant skill.",
      schema: skillShellInput,
      func: async (input) => {
        const parsed = skillShellInput.parse(input);
        return JSON.stringify(await skills.runShell(parsed));
      }
    })
  ];
}
