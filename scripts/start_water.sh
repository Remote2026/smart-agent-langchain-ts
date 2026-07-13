#!/bin/bash
set -euo pipefail

# Water Device Start Script
# Uses SmartThings CLI to turn on the water device.

# ---- Configuration ----
DEVICE_ID="fb81e329-82e4-4ecb-af2d-fa2ceada7d51"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"

# ---- Verify CLI is available ----
if ! command -v smartthings &> /dev/null; then
    echo "Error: smartthings CLI not found in PATH" >&2
    exit 1
fi

# ---- Verify .env exists (tokens are maintained there) ----
if [[ ! -f "$ENV_FILE" ]]; then
    echo "Error: .env not found at ${ENV_FILE}" >&2
    exit 1
fi

# ---- Send Command ----
echo "Turning on water device ${DEVICE_ID}..."
smartthings devices:commands "${DEVICE_ID}" switch:on

echo "Success: Water device turned on"
exit 0
