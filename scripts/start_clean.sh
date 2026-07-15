#!/bin/bash
set -euo pipefail

# Robot Cleaner Start Script
# Uses SmartThings API to start cleaning immediately

# ---- Configuration ----
DEVICE_ID="65f750d9-b6b9-44b9-886b-4a67598cc352"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"
API_URL="https://api.stacceptance.com/v1/devices/${DEVICE_ID}/commands"

MAP_ID="1"

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

# ---- Send Request ----
JSON_PAYLOAD=$(cat <<EOF
{
    "commands": [
         {
            "component": "main",
            "arguments": [],
            "capability": "samsungce.robotCleanerOperatingState",
            "command": "start"
        },
        {
            "component": "main",
            "arguments": [
                "spot",
                {
                    "mapId": "1",
                    "spots": [
                        {
                            "id": "0",
                            "topLeftX": 60,
                            "topLeftY": -5,
                            "bottomRightX": 80,
                            "bottomRightY": 10
                        }
                    ]
                }
            ],
            "capability": "samsungce.robotCleanerCleaningMode",
            "command": "setCleaningMode"
        }
    ]
}
EOF
)

echo "Starting robot clean for area 1..."

RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "${API_URL}" \
    -H "Authorization: Bearer ${API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${JSON_PAYLOAD}" 2>/dev/null)

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" == "200" ]]; then
    echo "Success: Robot started"
    echo "$BODY"
    exit 0
else
    echo "Error: HTTP ${HTTP_CODE}" >&2
    echo "$BODY" >&2
    exit 1
fi