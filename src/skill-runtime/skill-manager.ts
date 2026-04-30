import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type SkillSummary = {
  name: string;
  description: string;
  path: string;
  shellEnabled: boolean;
  allowedShellCommands: string[];
};

type Skill = SkillSummary & {
  content: string;
};

export class SkillManager {
  private readonly rootDir: string;
  private readonly workspaceDir: string;
  private readonly shellEnabled: boolean;

  constructor(options: {
    skillsDir: string;
    workspaceDir: string;
    shellEnabled: boolean;
  }) {
    this.workspaceDir = path.resolve(options.workspaceDir);
    this.rootDir = path.resolve(this.workspaceDir, options.skillsDir);
    this.shellEnabled = options.shellEnabled;
  }

  listSkills(): SkillSummary[] {
    return this.loadSkills().map(({ content: _content, ...summary }) => summary);
  }

  getSkill(name: string): Skill {
    const skill = this.loadSkills().find((candidate) => candidate.name === name);
    if (!skill) {
      throw new Error(`Skill not found: ${name}`);
    }

    return skill;
  }

  describeForPrompt(): string {
    const skills = this.listSkills();
    if (!skills.length) {
      return "No local skills are installed.";
    }

    return skills
      .map((skill) => {
        const shellState = skill.shellEnabled ? "shell allowed by policy" : "shell disabled";
        return `- ${skill.name}: ${skill.description} (${shellState})`;
      })
      .join("\n");
  }

  async runShell(input: {
    skillName: string;
    command: string;
    timeoutMs?: number;
  }): Promise<{
    command: string;
    cwd: string;
    stdout: string;
    stderr: string;
  }> {
    if (!this.shellEnabled) {
      throw new Error("Skill shell execution is disabled. Set ENABLE_SKILL_SHELL=true to enable it.");
    }

    const skill = this.getSkill(input.skillName);
    const command = input.command.trim();
    if (!command) {
      throw new Error("Command is required.");
    }

    if (!isAllowedCommand(command, skill.allowedShellCommands)) {
      throw new Error(
        `Command is not allowed by ${skill.name}/SKILL.md. Add it under "Allowed shell commands" first.`
      );
    }

    assertSafeCommand(command);

    const timeout = Math.min(Math.max(input.timeoutMs ?? 10000, 1000), 30000);
    const { stdout, stderr } = await execAsync(command, {
      cwd: this.workspaceDir,
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 256
    });

    return {
      command,
      cwd: this.workspaceDir,
      stdout: truncate(stdout),
      stderr: truncate(stderr)
    };
  }

  private loadSkills(): Skill[] {
    if (!fs.existsSync(this.rootDir)) {
      return [];
    }

    return fs
      .readdirSync(this.rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.loadSkill(entry.name))
      .filter((skill): skill is Skill => skill !== null);
  }

  private loadSkill(dirname: string): Skill | null {
    const skillPath = path.join(this.rootDir, dirname, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      return null;
    }

    const content = fs.readFileSync(skillPath, "utf8");
    const description = extractDescription(content);
    const allowedShellCommands = extractAllowedShellCommands(content);

    return {
      name: dirname,
      description,
      path: path.relative(this.workspaceDir, skillPath),
      shellEnabled: this.shellEnabled && allowedShellCommands.length > 0,
      allowedShellCommands,
      content
    };
  }
}

function extractDescription(content: string): string {
  const descriptionLine = content
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().startsWith("description:"));

  if (descriptionLine) {
    return descriptionLine.slice("description:".length).trim();
  }

  const heading = content.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() ?? "Local skill";
}

function extractAllowedShellCommands(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const commands: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (/^#{1,6}\s+allowed shell commands\s*$/i.test(line.trim())) {
      inSection = true;
      continue;
    }

    if (inSection && /^#{1,6}\s+/.test(line.trim())) {
      break;
    }

    if (!inSection) {
      continue;
    }

    const match = line.match(/^\s*[-*]\s+`?(.+?)`?\s*$/);
    if (match?.[1]) {
      commands.push(match[1].trim());
    }
  }

  return commands;
}

function isAllowedCommand(command: string, allowed: string[]): boolean {
  return allowed.some((entry) => {
    const normalized = entry.trim();
    if (!normalized) {
      return false;
    }

    if (normalized.endsWith("*")) {
      return command.startsWith(normalized.slice(0, -1).trimEnd());
    }

    return command === normalized;
  });
}

function assertSafeCommand(command: string): void {
  const blocked = [
    /\brm\b/i,
    /\bdel\b/i,
    /\brmdir\b/i,
    /\bremove-item\b/i,
    /\bgit\s+reset\b/i,
    /\bgit\s+checkout\b/i,
    /\bformat\b/i
  ];

  if (blocked.some((pattern) => pattern.test(command))) {
    throw new Error("Blocked potentially destructive shell command.");
  }
}

function truncate(value: string): string {
  const limit = 12000;
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}\n...[truncated]`;
}
