#!/bin/bash
set -euo pipefail

# Water Device Start Script
# Uses SmartThings REST API to turn on the water device.

# ---- Configuration ----
DEVICE_ID="fb81e329-82e4-4ecb-af2d-fa2ceada7d51"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"
API_URL="https://api.stacceptance.com/v1/devices/${DEVICE_ID}/commands"

# ---- Read Access Token from .env ----
if [[ ! -f "$ENV_FILE" ]]; then
    echo "Error: .env not found at ${ENV_FILE}" >&2
    exit 1
fi

API_TOKEN=$(grep '^SMARTTHINGS_ACCESS_TOKEN=' "$ENV_FILE" | sed 's/^SMARTTHINGS_ACCESS_TOKEN=//' | tr -d '\r')
if [[ -z "$API_TOKEN" ]]; then
    echo "Error: SMARTTHINGS_ACCESS_TOKEN is empty or not set in ${ENV_FILE}" >&2
    exit 1
fi

# ---- Send Command ----
JSON_PAYLOAD='{"commands":[{"component":"main","capability":"switch","command":"on"}]}'

echo "Turning on water device ${DEVICE_ID}..."

RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "${API_URL}" \
    -H "Authorization: Bearer ${API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${JSON_PAYLOAD}" 2>/dev/null)

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" == "200" ]]; then
    echo "Success: Water device turned on"
    echo "$BODY"
    exit 0
else
    echo "Error: HTTP ${HTTP_CODE}" >&2
    echo "$BODY" >&2
    exit 1
fi
