#!/bin/bash
# navigate_to.sh - 发送导航目标点到机器人，支持反馈和结果检测
# Usage: ./navigate_to.sh <x> <y> [z] [qx] [qy] [qz] [qw] [frame_id] [--options]
# Options:
#   -f, --feedback       显示实时导航反馈 (current_pose, distance_remaining 等)
#   -t, --timeout N      等待 N 秒后超时 (默认一直等待)
#   --no-wait            发送后不等待结果，立即返回
#   --frame-id NAME      指定坐标系 (等同于第8个位置参数)
#   -h, --help           显示帮助

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- speak stubs (可被外部覆盖) ----
speak_feedback() { true; }
speak_failed()   { true; }
speak_success()  { true; }

# ---- 容器配置 ----
CONTAINER_NAME="${CONTAINER_NAME:-isaac_ros_new-container}"
ISAAC_WS_CONTAINER="${ISAAC_WS_CONTAINER:-/home/admin/workspaces/isaac_ros-dev}"
ACTION_NAME="${ACTION_NAME:-/navigate_to_pose}"
ACTION_TYPE="${ACTION_TYPE:-nav2_msgs/action/NavigateToPose}"
CMD_VEL_NAV_TOPIC="${CMD_VEL_NAV_TOPIC:-/cmd_vel_nav}"

# ---- 默认参数 ----
X=""; Y=""; Z="0.0"; QX="0.0"; QY="0.0"; QZ="0.0"; QW="1.0"; FRAME_ID="map"
SHOW_FEEDBACK="false"
TIMEOUT="${NAV_ACTION_TIMEOUT:-}"
NO_WAIT="false"
RESEND_ON_NO_CMD_VEL="${NAV_RESEND_ON_NO_CMD_VEL:-true}"
CMD_VEL_START_TIMEOUT="${NAV_CMD_VEL_START_TIMEOUT:-18}"
MAX_SEND_ATTEMPTS="${NAV_MAX_SEND_ATTEMPTS:-2}"
MAX_FAILURE_RETRIES="${NAV_MAX_FAILURE_RETRIES:-2}"

is_true() {
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on) return 0 ;;
        *) return 1 ;;
    esac
}

# ---- 解析位置参数和选项 ----
POSITIONAL=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        -f|--feedback) SHOW_FEEDBACK="true"; shift ;;
        -t|--timeout)  TIMEOUT="$2"; shift 2 ;;
        --no-wait)     NO_WAIT="true"; shift ;;
        --frame-id)    FRAME_ID="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 <x> <y> [z] [qx] [qy] [qz] [qw] [frame_id] [options]"
            echo ""
            echo "Positional:"
            echo "  x y             目标位置 (必需)"
            echo "  z               目标高度 (默认: 0.0)"
            echo "  qx qy qz qw     目标朝向四元数 (默认: 0 0 0 1)"
            echo "  frame_id        坐标系 (默认: map)"
            echo ""
            echo "Options:"
            echo "  -f, --feedback  显示实时导航反馈"
            echo "  -t, --timeout N 等待超时秒数 (默认: 无限等待)"
            echo "  --no-wait       发送后不等待结果"
            echo "  --frame-id NAME 指定坐标系"
            echo ""
            echo "Examples:"
            echo "  $0 1.0 2.0                     # 发送目标到 (1, 2)"
            echo "  $0 1.0 2.0 -f                  # 发送并显示反馈"
            echo "  $0 1.0 2.0 -f -t 30            # 发送，显示反馈，30s 超时"
            echo "  $0 1.0 2.0 0.0 0 0 0.707 0.707 # 带朝向"
            exit 0
            ;;
        -[0-9]*)
            # Negative numeric coordinate (e.g. -0.7) is a positional argument.
            POSITIONAL+=("$1")
            shift
            ;;
        -*)
            echo "❌ 未知选项: $1"
            exit 1
            ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done

# ---- 应用位置参数 ----
X="${POSITIONAL[0]:-}"
Y="${POSITIONAL[1]:-}"
if [ ${#POSITIONAL[@]} -ge 3 ]; then Z="${POSITIONAL[2]}"; fi
if [ ${#POSITIONAL[@]} -ge 4 ]; then QX="${POSITIONAL[3]}"; fi
if [ ${#POSITIONAL[@]} -ge 5 ]; then QY="${POSITIONAL[4]}"; fi
if [ ${#POSITIONAL[@]} -ge 6 ]; then QZ="${POSITIONAL[5]}"; fi
if [ ${#POSITIONAL[@]} -ge 7 ]; then QW="${POSITIONAL[6]}"; fi
if [ ${#POSITIONAL[@]} -ge 8 ]; then FRAME_ID="${POSITIONAL[7]}"; fi

if [ -z "$X" ] || [ -z "$Y" ]; then
    echo "Usage: $0 <x> <y> [z] [qx] [qy] [qz] [qw] [frame_id] [options]"
    echo "Try '$0 --help' for details."
    exit 1
fi

# ---- 显示目标 ----
echo "🧭 发送导航目标..."
echo "   位置: x=$X, y=$Y, z=$Z"
echo "   方向: qx=$QX, qy=$QY, qz=$QZ, qw=$QW"
echo "   坐标系: $FRAME_ID"
echo "   反馈: $SHOW_FEEDBACK"
if [ -n "$TIMEOUT" ]; then
    echo "   超时: ${TIMEOUT}s"
else
    echo "   超时: 不限制"
fi
if is_true "$RESEND_ON_NO_CMD_VEL" && [ "$NO_WAIT" != "true" ]; then
    echo "   首次速度等待: ${CMD_VEL_START_TIMEOUT}s (${CMD_VEL_NAV_TOPIC})"
    echo "   最大发送次数: ${MAX_SEND_ATTEMPTS}"
fi

# ---- 检查容器 ----
if ! docker ps --format "{{.Names}}" | grep -q "^${CONTAINER_NAME}$"; then
    echo "❌ 容器 $CONTAINER_NAME 未运行"
    speak_failed
    exit 1
fi

# ---- 检查 action server 是否在线 ----
echo "🔍 检查导航服务..."
SERVER_COUNT=$(docker exec "$CONTAINER_NAME" /bin/bash -lc "
    cd '$ISAAC_WS_CONTAINER'
    source install/setup.sh
    ros2 action list 2>/dev/null | grep -c '${ACTION_NAME}' || true
" 2>/dev/null)

if [ "$SERVER_COUNT" -eq 0 ]; then
    echo "❌ 导航 action server ($ACTION_NAME) 未就绪"
    echo "   请确认导航栈正在运行 (bumi_navigation.sh)"
    speak_failed
    exit 2
fi
echo "✅ 导航服务就绪"

speak_feedback "开始导航"

# ---- 构建命令 ----
GOAL_YAML="{
    pose: {
        header: {frame_id: \"$FRAME_ID\"},
        pose: {
            position: {x: $X, y: $Y, z: $Z},
            orientation: {x: $QX, y: $QY, z: $QZ, w: $QW}
        }
    }
}"

CMD_ARGS=""
if [ "$SHOW_FEEDBACK" = "true" ]; then CMD_ARGS="$CMD_ARGS -f"; fi

cleanup_stale_action_clients() {
    docker exec "$CONTAINER_NAME" /bin/bash -lc "
        pkill -f \"ros2 action send_goal ${ACTION_NAME} ${ACTION_TYPE}\" 2>/dev/null || true
    " >/dev/null 2>&1 || true
}

wait_for_pid_with_timeout() {
    local pid="$1"
    local wait_timeout="$2"
    local start_time
    local now

    if [ -z "$wait_timeout" ]; then
        wait "$pid"
        return $?
    fi

    start_time=$(date +%s)
    while kill -0 "$pid" 2>/dev/null; do
        now=$(date +%s)
        if [ $((now - start_time)) -ge "$wait_timeout" ]; then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
            return 124
        fi
        sleep 0.2
    done

    wait "$pid"
    return $?
}

start_action_send() {
    local output_file="$1"

    docker exec "$CONTAINER_NAME" /bin/bash -lc "
        cd '$ISAAC_WS_CONTAINER'
        source install/setup.sh
        ros2 action send_goal '$ACTION_NAME' '$ACTION_TYPE' '$GOAL_YAML' $CMD_ARGS
    " >>"$output_file" 2>&1 &
    ACTION_PID=$!
}

wait_for_first_cmd_vel_nav() {
    docker exec "$CONTAINER_NAME" /bin/bash -lc "
        cd '$ISAAC_WS_CONTAINER'
        source install/setup.sh
        timeout '$CMD_VEL_START_TIMEOUT' ros2 topic echo '$CMD_VEL_NAV_TOPIC' --once >/dev/null
    " >/dev/null 2>&1
}

run_navigate_attempt() {
    local attempt=1
    local exit_code=1
    local timeout_reason=""

    while [ "$attempt" -le "$MAX_SEND_ATTEMPTS" ]; do
        if [ "$attempt" -gt 1 ]; then
            echo "" >>"$RESULT_FILE"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >>"$RESULT_FILE"
            echo "🔁 第 ${attempt}/${MAX_SEND_ATTEMPTS} 次重新发送导航目标" >>"$RESULT_FILE"
        fi

        set +e
        start_action_send "$RESULT_FILE"

        if is_true "$RESEND_ON_NO_CMD_VEL"; then
            wait_for_first_cmd_vel_nav &
            CMD_MONITOR_PID=$!

            while kill -0 "$ACTION_PID" 2>/dev/null && kill -0 "$CMD_MONITOR_PID" 2>/dev/null; do
                sleep 0.2
            done

            if ! kill -0 "$ACTION_PID" 2>/dev/null; then
                kill "$CMD_MONITOR_PID" 2>/dev/null || true
                wait "$CMD_MONITOR_PID" 2>/dev/null || true
                wait "$ACTION_PID"
                exit_code=$?
                set -e
                break
            fi

            wait "$CMD_MONITOR_PID"
            CMD_MONITOR_CODE=$?
            if [ "$CMD_MONITOR_CODE" -ne 0 ]; then
                kill "$ACTION_PID" 2>/dev/null || true
                cleanup_stale_action_clients
                wait "$ACTION_PID" 2>/dev/null || true
                echo "" >>"$RESULT_FILE"
                echo "⏱️  ${CMD_VEL_START_TIMEOUT}s 内没有收到 ${CMD_VEL_NAV_TOPIC}，已停止本次 action client" >>"$RESULT_FILE"
                if [ "$attempt" -ge "$MAX_SEND_ATTEMPTS" ]; then
                    exit_code=124
                    timeout_reason="cmd_vel_nav"
                    set -e
                    break
                fi
                attempt=$((attempt + 1))
                set -e
                continue
            fi
        fi

        wait_for_pid_with_timeout "$ACTION_PID" "$TIMEOUT"
        exit_code=$?
        if [ "$exit_code" -eq 124 ]; then
            timeout_reason="action_result"
        fi
        set -e
        break
    done

    if [ "$exit_code" -eq 124 ]; then
        cleanup_stale_action_clients
        cat "$RESULT_FILE"
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        if [ "$timeout_reason" = "cmd_vel_nav" ]; then
            echo "⏱️  连续 ${MAX_SEND_ATTEMPTS} 次发送后，${CMD_VEL_START_TIMEOUT}s 内仍没有收到 ${CMD_VEL_NAV_TOPIC}"
            echo "   已清理残留 action client，未继续等待导航结果。"
        else
            echo "⏱️  等待导航结果超时 (${TIMEOUT}s)，已清理残留 action client"
            echo "   注意: 目标可能已经被 Nav2 接收，但脚本已停止等待结果。"
        fi
        speak_failed
        exit 5
    fi

    cat "$RESULT_FILE" >&2

    local result_text
    local status=""
    local text_status=""

    result_text=$(cat "$RESULT_FILE")

    status=$(echo "$result_text" | grep -oP 'status:\s*\K\d+' | tail -1 || echo "")
    text_status=$(echo "$result_text" | grep -oP 'status:\s*\K[A-Z_]+' | tail -1 || echo "")

    if [ -z "$status" ]; then
        if echo "$result_text" | grep -qi "Goal was rejected"; then
            status="REJECTED"
        elif echo "$result_text" | grep -qi "Goal finished with status: SUCCEEDED"; then
            status="4"
        elif echo "$result_text" | grep -qi "Goal finished with status: CANCELED"; then
            status="5"
        elif echo "$result_text" | grep -qi "Goal finished with status: ABORTED"; then
            status="6"
        fi
    fi

    if [ -z "$status" ] && [ -n "$text_status" ]; then
        case "$text_status" in
            UNKNOWN) status="0" ;;
            ACCEPTED) status="1" ;;
            EXECUTING) status="2" ;;
            CANCELING) status="3" ;;
            SUCCEEDED) status="4" ;;
            CANCELED) status="5" ;;
            ABORTED) status="6" ;;
            REJECTED) status="REJECTED" ;;
        esac
    fi

    echo "$status"
}

if [ "$NO_WAIT" = "true" ]; then
    # 不等待: 发送目标后立即返回
    echo "📤 发送目标 (不等待结果)..."
    set +e
    if [ -n "$TIMEOUT" ]; then
        timeout "$TIMEOUT" docker exec "$CONTAINER_NAME" /bin/bash -lc "
            cd '$ISAAC_WS_CONTAINER'
            source install/setup.sh
            ros2 action send_goal '$ACTION_NAME' '$ACTION_TYPE' '$GOAL_YAML' $CMD_ARGS
        "
    else
        docker exec "$CONTAINER_NAME" /bin/bash -lc "
            cd '$ISAAC_WS_CONTAINER'
            source install/setup.sh
            ros2 action send_goal '$ACTION_NAME' '$ACTION_TYPE' '$GOAL_YAML' $CMD_ARGS
        "
    fi
    EXIT_CODE=$?
    set -e
    if [ "$EXIT_CODE" -eq 124 ]; then
        cleanup_stale_action_clients
        echo "⏱️  发送目标超时 (${TIMEOUT}s)，已清理残留 action client"
        exit 5
    elif [ "$EXIT_CODE" -ne 0 ]; then
        echo "❌ 发送目标失败 (退出码: $EXIT_CODE)"
        exit "$EXIT_CODE"
    fi
    echo "✅ 目标已发送 (未等待完成)"
    echo "   目标位置: ($X, $Y, $Z)"
    exit 0
fi

# ---- 发送并等待结果 ----
echo "📤 发送导航目标，等待完成..."

RESULT_FILE=$(mktemp)
trap "rm -f $RESULT_FILE" EXIT

FAILURE_RETRY_COUNT=0
while [ "$FAILURE_RETRY_COUNT" -le "$MAX_FAILURE_RETRIES" ]; do
    if [ "$FAILURE_RETRY_COUNT" -gt 0 ]; then
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🔁 导航被中止 (ABORTED)，第 ${FAILURE_RETRY_COUNT}/${MAX_FAILURE_RETRIES} 次重试..."
        cleanup_stale_action_clients
    fi

    STATUS=$(run_navigate_attempt)

    if [ "$STATUS" != "6" ]; then
        break
    fi

    FAILURE_RETRY_COUNT=$((FAILURE_RETRY_COUNT + 1))
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
case "$STATUS" in
    4)
        echo "✅ 导航成功到达目标"
        echo "   目标位置: ($X, $Y, $Z)"
        speak_success
        exit 0
        ;;
    5)
        echo "⚠️  导航被取消"
        speak_failed
        exit 3
        ;;
    6)
        echo "❌ 导航失败 (被中止)，已重试 ${MAX_FAILURE_RETRIES} 次"
        speak_failed
        exit 4
        ;;
    "REJECTED")
        echo "❌ 导航目标被拒绝"
        speak_failed
        exit 8
        ;;
    "")
        if grep -qi "goal accepted\|goal.*queued" "$RESULT_FILE"; then
            # 目标已被接受但未等到完成
            echo "📨 目标已接受 (仍在执行中)"
            exit 0
        else
            echo "⚠️  无法解析导航结果"
            exit 6
        fi
        ;;
    *)
        echo "⚠️  未知状态码: $STATUS"
        exit 7
        ;;
esac
