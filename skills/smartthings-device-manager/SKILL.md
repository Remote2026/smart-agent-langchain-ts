# SmartThings Device Manager

Description: Manage SmartThings device discovery and local project checks.

## When To Use

Use this skill when the user asks about SmartThings device aliases, available devices, or project verification for SmartThings-related changes.

## Inference Rules

- Prefer the configured alias map before listing every device.
- If an alias is missing, ask the user to choose from `smartthings_list_devices`.
- Do not guess device IDs.
- Do not expose SmartThings tokens or `.env` contents.

## Scripts

This skill does not require extra scripts yet. If scripts are added later, place them under this skill directory and add their exact invocation to `Allowed shell commands`.

## Allowed Shell Commands

- `npm run typecheck`
- `npm run build`
