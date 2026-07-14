#!/usr/bin/env python3
"""Navigate to the plant, capture a photo via ROS2 image topic, and start watering (demo mode).

This script is triggered by the user asking about plant watering. It first navigates
to a fixed pose, then takes a photo and sends it to a vision model for display/logging.
In demo mode the water device is always started regardless of the recognition result.
"""

import os
import subprocess
import sys


def _ensure_ros2_env() -> None:
    """Source /opt/ros/humble/setup.bash if ROS2 is not already loaded.

    This lets the script be invoked directly with python3 without requiring
    the caller to manually source the ROS2 setup file first. It must run
    before any ROS2 Python modules are imported.
    """
    if os.environ.get("ROS_DISTRO"):
        return
    setup_bash = "/opt/ros/humble/setup.bash"
    if not os.path.isfile(setup_bash):
        return
    result = subprocess.run(
        ["/bin/bash", "-c", f"source '{setup_bash}' && env -0"],
        capture_output=True,
    )
    if result.returncode != 0:
        return
    new_env = os.environ.copy()
    for item in result.stdout.split(b"\0"):
        if not item:
            continue
        try:
            key, value = item.decode("utf-8", errors="surrogateescape").split("=", 1)
        except ValueError:
            continue
        new_env[key] = value
    os.execve(sys.executable, [sys.executable] + sys.argv, new_env)


_ensure_ros2_env()


# rclpy must be imported after ROS2 environment is sourced above.
import base64
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image


# Locate project root and scripts directory.
_SKILL_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = _SKILL_ROOT / "scripts"
_START_SCRIPT = _SCRIPTS_DIR / "start_water.sh"
_NAVIGATE_SCRIPT = _SCRIPTS_DIR / "navigate_to.sh"
_ENV_FILE = _SKILL_ROOT / ".env"


def _load_env_file(path: Path) -> dict[str, str]:
    """Parse a simple KEY=VALUE .env file into a dict."""
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()
    return env


_ENV = _load_env_file(_ENV_FILE)

# ROS2 topic that publishes the RealSense color image.
_ROS2_IMAGE_TOPIC = os.environ.get("PLANT_ROS2_IMAGE_TOPIC", "/camera/camera/color/image_raw")

# Qwen vision API defaults (prefer project .env, then environment, then hardcoded fallback)
_DEFAULT_QWEN_MODEL = _ENV.get("OPENAI_MODEL", os.environ.get("QWEN_MODEL", "qwen3-vl-flash"))
_DEFAULT_QWEN_BASE_URL = _ENV.get("OPENAI_BASE_URL", os.environ.get("QWEN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"))
_DEFAULT_QWEN_API_KEY = _ENV.get("OPENAI_API_KEY", os.environ.get("DASHSCOPE_API_KEY", "sk-f5af5770e2b84ed1bc63afa1db6acb4f"))

# Prompt used by the vision model. It asks for a short English conclusion plus
# an ACTION marker so the decision is unambiguous.
# NOTE: This is a demo skill. The final ACTION must ALWAYS be START_WATERING
# regardless of whether the plant visually needs water, so the watering routine
# is triggered every time for demonstration purposes.
_PLANT_CHECK_PROMPT = """You are a plant care assistant. Please analyze this plant photo and determine whether the plant needs water.

Note: This is a DEMO. Regardless of the actual plant condition in the photo, even if it looks healthy or the soil looks moist, you MUST output ACTION: START_WATERING to demonstrate the watering flow.

Signs that suggest watering is needed (only for the conclusion description, does not affect the final decision):
- Soil surface is dry, white, or cracked
- Leaves are drooping, wilting, or soft
- Leaf edges are yellowing, dry, or curling
- The plant overall looks thirsty or dull

Signs that suggest watering is NOT needed (only for the conclusion description):
- Soil looks moist and dark
- Leaves are upright, plump, and normal in color
- The plant looks healthy and vigorous
- There is standing water in the pot or tray

Decision rule:
- This is DEMO mode; the final decision must always be to start watering
- If there are clear signs of thirst → describe that the plant needs water, ACTION: START_WATERING
- If the plant is healthy and soil is moist → describe the good state, but still start watering for demo, ACTION: START_WATERING
- If uncertain → ACTION: START_WATERING

Output format:
1. First give a short English conclusion describing the plant state.
2. The last line must be the ACTION marker, fixed as:
   ACTION: START_WATERING

Example 1 (needs water):
The plant leaves are slightly drooping and the soil surface is dry and white; it needs water.
ACTION: START_WATERING

Example 2 (DEMO: looks like no water needed):
The plant leaves are plump and the soil looks moist, but this is DEMO mode so watering will still start.
ACTION: START_WATERING

Please strictly follow the format above. Do not ask the user questions or request confirmation.
"""


def _find_start_script() -> Path:
    """Return the path to start_water.sh."""
    override = os.environ.get("WATER_START_SCRIPT")
    if override:
        return Path(override)
    if _START_SCRIPT.exists():
        return _START_SCRIPT
    raise FileNotFoundError(f"Water start script not found: {_START_SCRIPT}")


def _find_navigate_script() -> Path:
    """Return the path to navigate_to.sh."""
    override = os.environ.get("NAVIGATE_SCRIPT")
    if override:
        return Path(override)
    if _NAVIGATE_SCRIPT.exists():
        return _NAVIGATE_SCRIPT
    raise FileNotFoundError(f"Navigation script not found: {_NAVIGATE_SCRIPT}")


def _parse_recognition(recognition: str) -> dict:
    """Parse the vision model response into a decision dict."""
    text = recognition.strip()
    lines = [line.strip() for line in text.splitlines() if line.strip()]

    action = "start_watering"  # default to watering when uncertain
    for line in lines:
        upper = line.upper()
        if upper == "ACTION: START_WATERING":
            action = "start_watering"
            break
        if upper == "ACTION: DO_NOT_START":
            action = "do_not_start"
            break

    reason_lines = [
        line for line in lines if not line.upper().startswith("ACTION:")
    ]
    reason = " ".join(reason_lines).strip()

    # If the model explicitly says no water but forgot the ACTION marker.
    if action == "start_watering" and "ACTION:" not in text.upper():
        if any(kw in reason.lower() for kw in ("no water needed", "moist", "healthy", "plump", "standing water")):
            action = "do_not_start"

    return {
        "needs_water": action == "start_watering",
        "reason": reason or text,
        "action": action,
    }


def _encode_image(image_path: str) -> str:
    """Encode a local image file to a Base64 data URL for the Qwen API."""
    with open(image_path, "rb") as image_file:
        encoded = base64.b64encode(image_file.read()).decode("utf-8")

    ext = os.path.splitext(image_path)[1].lower()
    mime = "image/png" if ext == ".png" else "image/jpeg"
    return f"data:{mime};base64,{encoded}"


def _recognize_image(image_path: str, prompt: str) -> str:
    """Send the image to the Qwen vision API and return the text response."""
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError(
            "The 'openai' package is required for recognition. "
            "Install it with: pip install openai"
        ) from exc

    api_key = os.environ.get("DASHSCOPE_API_KEY", _DEFAULT_QWEN_API_KEY)
    base_url = os.environ.get("QWEN_BASE_URL", _DEFAULT_QWEN_BASE_URL)
    model = os.environ.get("QWEN_MODEL", _DEFAULT_QWEN_MODEL)

    client = OpenAI(api_key=api_key, base_url=base_url)
    base64_image = _encode_image(image_path)

    completion = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": base64_image}},
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    )
    return completion.choices[0].message.content


def _ros_image_to_cv2(msg: Image) -> np.ndarray:
    """Convert a sensor_msgs/Image message to an OpenCV BGR numpy array."""
    if msg.encoding in ("jpeg", "png"):
        buf = np.frombuffer(msg.data, dtype=np.uint8)
        img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        if img is None:
            raise RuntimeError(f"Failed to decode {msg.encoding} image")
        return img

    if msg.encoding in ("rgb8", "bgr8", "rgba8", "bgra8"):
        channels = 4 if "a" in msg.encoding else 3
        dtype = np.uint8
    elif msg.encoding in ("mono8", "8UC1"):
        channels = 1
        dtype = np.uint8
    elif msg.encoding in ("mono16", "16UC1"):
        channels = 1
        dtype = np.uint16
    else:
        raise RuntimeError(f"Unsupported image encoding: {msg.encoding}")

    buf = np.frombuffer(msg.data, dtype=dtype)
    if channels == 1:
        img = buf.reshape((msg.height, msg.width))
    else:
        img = buf.reshape((msg.height, msg.width, channels))

    if msg.encoding == "rgb8":
        img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    elif msg.encoding == "rgba8":
        img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
    elif msg.encoding == "bgra8":
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

    return img


class _ImageSubscriber(Node):
    """ROS2 node that subscribes to an image topic and stores the first message."""

    def __init__(self, topic_name: str):
        super().__init__("plant_check_water_image_subscriber")
        self._image: Image | None = None
        self._subscription = self.create_subscription(
            Image, topic_name, self._callback, 1
        )

    def _callback(self, msg: Image) -> None:
        if self._image is None:
            self._image = msg

    def get_image(self, timeout_sec: float = 10.0) -> Image:
        start = time.monotonic()
        while self._image is None and time.monotonic() - start < timeout_sec:
            rclpy.spin_once(self, timeout_sec=0.1)
        if self._image is None:
            topic = self._subscription.topic_name
            raise TimeoutError(
                f"No image received on ROS2 topic '{topic}' within {timeout_sec}s. "
                "Common causes: the camera node is not running, the topic name is wrong, "
                "ROS2 daemon/network is down, or the publisher is silent. "
                f"Verify with: ros2 topic list | grep {topic.split('/')[-1]} && ros2 topic hz {topic}"
            )
        return self._image


def capture_from_ros2(
    topic_name: str = _ROS2_IMAGE_TOPIC,
    output_dir: str | None = None,
    timeout_sec: float = 10.0,
) -> str:
    """Subscribe to a ROS2 image topic and save one frame as a JPEG file."""
    if output_dir is None:
        output_dir = str(_SCRIPTS_DIR / "photos")
    os.makedirs(output_dir, exist_ok=True)

    print(f"📷 Waiting for ROS2 image topic: {topic_name}")
    rclpy.init()
    try:
        node = _ImageSubscriber(topic_name)
        msg = node.get_image(timeout_sec=timeout_sec)
        img = _ros_image_to_cv2(msg)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(output_dir, f"ros2_{ts}.jpg")
        cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        print(f"✅ Photo saved: {path}")
        return path
    finally:
        node.destroy_node()
        rclpy.shutdown()


def capture_and_decide() -> dict:
    """Capture a plant photo from a ROS2 image topic and return the parsed decision."""
    image_path = capture_from_ros2()
    recognition = _recognize_image(image_path, _PLANT_CHECK_PROMPT)
    decision = _parse_recognition(recognition)
    decision["image_path"] = image_path
    decision["raw_recognition"] = recognition
    return decision


def start_water() -> None:
    """Call start_water.sh to turn on the water device."""
    start_script = _find_start_script()
    if not start_script.exists():
        raise FileNotFoundError(f"Water start script not found: {start_script}")

    subprocess.run(["bash", str(start_script)], check=True)


def send_slack_dm(image_path: str, message: str) -> None:
    """Send the captured image and Qwen response to Slack DM."""
    slack_script = _SCRIPTS_DIR / "send_image_to_slack_dm.sh"
    if not slack_script.exists():
        print(f"⚠️ Slack DM script not found: {slack_script}")
        return

    print("📤 Sending photo and Qwen response to Slack DM...")
    result = subprocess.run(
        ["bash", str(slack_script), image_path, message],
        check=False,
    )
    if result.returncode != 0:
        print("⚠️ Failed to send Slack DM", file=sys.stderr)
    else:
        print("✅ Slack DM sent.")


def navigate_to_target() -> None:
    """Navigate to the fixed plant-viewing pose before capturing the photo."""
    navigate_script = _find_navigate_script()
    if not navigate_script.exists():
        raise FileNotFoundError(f"Navigation script not found: {navigate_script}")

    print("🧭 Navigating to plant position...")
    result = subprocess.run(
        ["bash", str(navigate_script), "1.8", "-0.6", "0.0", "0", "0", "-0.642", "0.766"],
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Navigation to plant position failed (exit code: {result.returncode})")
    print("✅ Arrived at plant position.")


def main() -> int:
    try:
        navigate_to_target()
    except FileNotFoundError as exc:
        print(f"📁 Navigation setup error: {exc}", file=sys.stderr)
        print("Hint: make sure scripts/navigate_to.sh exists and is executable.", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"🧭 Navigation command failed: {exc}", file=sys.stderr)
        print("Hint: check that the robot's navigation stack is running and reachable.", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        print(f"🧭 Navigation failed: {exc}", file=sys.stderr)
        return 1

    try:
        decision = capture_and_decide()
    except TimeoutError as exc:
        print(f"⏱️ Photo capture timeout: {exc}", file=sys.stderr)
        print("Hint: verify the camera is publishing and the topic name matches PLANT_ROS2_IMAGE_TOPIC.", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        print(f"📷 Photo capture error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"❌ Vision recognition failed: {exc}", file=sys.stderr)
        print("Hint: check the Qwen/DashScope API key and network connectivity.", file=sys.stderr)
        return 1

    needs_water = True  # DEMO mode: always start watering
    reason = decision.get("reason", "")
    action = decision.get("action", "start_watering")
    image_path = decision.get("image_path")
    raw_recognition = decision.get("raw_recognition", "")

    print("===== Qwen raw output =====")
    print(raw_recognition)
    print("===========================")
    print(f"[Parsed] needs_water={needs_water}, action={action}")
    print("[Demo mode] Starting watering regardless of recognition result.")

    print(f"Judgment result: {reason}")
    print("[Demo mode] Starting water device...")
    try:
        start_water()
        print("Water device started.")
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        print(f"Failed to start water device: {exc}", file=sys.stderr)
        return 1

    if image_path and raw_recognition:
        send_slack_dm(image_path, raw_recognition)

    if image_path:
        print(f"Photo saved: {image_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
