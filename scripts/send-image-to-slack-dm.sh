#!/bin/bash
set -euo pipefail

# Send Image to Slack DM using the new files.upload external flow
# Usage: ./scripts/send-image-to-slack-dm.sh <image-path> <message>

USER_ID="U0APGNX5NV9"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "Error: .env not found at ${ENV_FILE}" >&2
    exit 1
fi

# shellcheck source=/dev/null
set -a
source "$ENV_FILE"
set +a

SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <image-path> <message>" >&2
    exit 1
fi

IMAGE_PATH="$1"
MESSAGE="$2"

if [[ ! -f "$IMAGE_PATH" ]]; then
    echo "Error: image file not found: ${IMAGE_PATH}" >&2
    exit 1
fi

if [[ -z "$SLACK_BOT_TOKEN" ]]; then
    echo "Error: SLACK_BOT_TOKEN is not set in ${ENV_FILE}" >&2
    exit 1
fi

FILE_SIZE=$(stat -c%s "$IMAGE_PATH")
FILE_NAME=$(basename "$IMAGE_PATH")

echo "Sending ${FILE_NAME} to ${USER_ID}..."

# Step 0: Open DM conversation to get channel ID
STEP0=$(curl -s -X POST https://slack.com/api/conversations.open \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "users=${USER_ID}" \
    --data-urlencode "return_im=false")

OK0=$(echo "$STEP0" | python3 -c "import sys, json; print(json.load(sys.stdin).get('ok', False))")
if [[ "$OK0" != "True" ]]; then
    echo "Error: conversations.open failed" >&2
    echo "$STEP0" | python3 -m json.tool >&2
    exit 1
fi

DM_CHANNEL_ID=$(echo "$STEP0" | python3 -c "import sys, json; print(json.load(sys.stdin)['channel']['id'])")

# Step 1: Get upload URL
STEP1=$(curl -s -X POST https://slack.com/api/files.getUploadURLExternal \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "filename=${FILE_NAME}" \
    --data-urlencode "length=${FILE_SIZE}")

OK1=$(echo "$STEP1" | python3 -c "import sys, json; print(json.load(sys.stdin).get('ok', False))")
if [[ "$OK1" != "True" ]]; then
    echo "Error: files.getUploadURLExternal failed" >&2
    echo "$STEP1" | python3 -m json.tool >&2
    exit 1
fi

UPLOAD_URL=$(echo "$STEP1" | python3 -c "import sys, json; print(json.load(sys.stdin)['upload_url'])")
FILE_ID=$(echo "$STEP1" | python3 -c "import sys, json; print(json.load(sys.stdin)['file_id'])")

# Step 2: Upload file bytes
STEP2=$(curl -s -w "\n%{http_code}" -X POST "$UPLOAD_URL" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@${IMAGE_PATH}")

HTTP_CODE=$(echo "$STEP2" | tail -n1)
if [[ "$HTTP_CODE" != "200" ]]; then
    echo "Error: file upload to Slack failed with HTTP ${HTTP_CODE}" >&2
    echo "$STEP2" | sed '$d' >&2
    exit 1
fi

# Step 3: Complete upload and share to DM
export FILE_ID FILE_NAME DM_CHANNEL_ID MESSAGE
STEP3=$(curl -s -X POST https://slack.com/api/files.completeUploadExternal \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c '
import json, os
print(json.dumps({
    "files": [{"id": os.environ["FILE_ID"], "title": os.environ["FILE_NAME"]}],
    "channel_id": os.environ["DM_CHANNEL_ID"],
    "initial_comment": os.environ["MESSAGE"]
}))
')")

OK3=$(echo "$STEP3" | python3 -c "import sys, json; print(json.load(sys.stdin).get('ok', False))")
if [[ "$OK3" == "True" ]]; then
    echo "Success: image sent to ${USER_ID}"
    echo "$STEP3" | python3 -m json.tool
    exit 0
else
    echo "Error: files.completeUploadExternal failed" >&2
    echo "$STEP3" | python3 -m json.tool >&2
    exit 1
fi
