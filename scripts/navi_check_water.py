#!/usr/bin/env python3
"""Navigate to the cleaning spot, capture a floor photo, and start the vacuum (demo mode).

This script is triggered by the user asking "地上有垃圾吗？". It first navigates
to a fixed pose, then takes a photo and sends it to a vision model for display/logging.
In demo mode the robot vacuum is always started regardless of the recognition result.
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
import json
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image


# Locate sibling skills under workspace/skills/
_SKILL_ROOT = Path(__file__).resolve().parent.parent
_WORKSPACE_SKILLS = _SKILL_ROOT.parent
_START_SCRIPT = _SKILL_ROOT / "scripts" / "start-clean.sh"
_NAVIGATE_SCRIPT = _WORKSPACE_SKILLS / "navigate_to.sh"

# ROS2 topic that publishes the RealSense color image.
_ROS2_IMAGE_TOPIC = os.environ.get("VACUUM_ROS2_IMAGE_TOPIC", "/camera/camera/color/image_raw")

# Qwen vision API defaults (mirrors realsense-photo/scripts/capture.py)
_DEFAULT_QWEN_MODEL = "qwen3-vl-flash"
_DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
_DEFAULT_QWEN_API_KEY = "sk-f5af5770e2b84ed1bc63afa1db6acb4f"

# Prompt used by the vision model. It asks for a short Chinese conclusion plus
# an ACTION marker so the decision is unambiguous and the vacuum starts directly
# when it is safe to do so.
_VACUUM_CHECK_PROMPT = """你是一台扫地机器人的调度助手。当前为 DEMO 模式，无论照片中地板上有什么，最终都必须启动扫地机。

请分析这张地板照片，描述地上是否有垃圾、是什么垃圾，然后给出结论。

输出格式要求：
1. 先给出一句简短的中文结论，说明地上有什么、当前处于 DEMO 模式。
2. 最后一行必须是：
   ACTION: START_VACUUM

示例 1：
地上有少量灰尘和细小碎屑，DEMO 模式将启动扫地机。
ACTION: START_VACUUM

示例 2：
地上有湿纸巾和纸团，normally 不建议启动，但当前为 DEMO 模式，仍启动扫地机。
ACTION: START_VACUUM

示例 3：
地上没有明显垃圾，DEMO 模式仍启动扫地机。
ACTION: START_VACUUM

请严格按以上格式输出，不要反问用户，不要请求确认。
"""


def _find_start_script() -> Path:
    """Return the path to start-clean.sh."""
    override = os.environ.get("VACUUM_START_SCRIPT")
    if override:
        return Path(override)
    if _START_SCRIPT.exists():
        return _START_SCRIPT
    return Path.home() / ".openclaw" / "workspace" / "skills" / "vacuum-ground-clean" / "scripts" / "start-clean.sh"


def _find_navigate_script() -> Path:
    """Return the path to navigate_to.sh."""
    override = os.environ.get("NAVIGATE_SCRIPT")
    if override:
        return Path(override)
    if _NAVIGATE_SCRIPT.exists():
        return _NAVIGATE_SCRIPT
    return Path.home() / ".openclaw" / "workspace" / "skills" / "navigate_to.sh"


def _parse_recognition(recognition: str) -> dict:
    """Parse the vision model response into a decision dict.

    Expected format: a short Chinese conclusion followed by an ACTION line:
        ACTION: START_VACUUM
        ACTION: DO_NOT_START
    """
    text = recognition.strip()
    lines = [line.strip() for line in text.splitlines() if line.strip()]

    action = "manual_cleanup"
    for line in lines:
        upper = line.upper()
        if upper == "ACTION: START_VACUUM":
            action = "start_vacuum"
            break
        if upper == "ACTION: DO_NOT_START":
            action = "manual_cleanup"
            break

    # Remove the ACTION line(s) for the human-readable reason.
    reason_lines = [
        line for line in lines if not line.upper().startswith("ACTION:")
    ]
    reason = " ".join(reason_lines).strip()

    # Heuristic: did the model see garbage?
    # Be careful not to mistake phrases like "无明显湿痕" for "no garbage".
    no_garbage_phrases = [
        "没有明显垃圾",
        "没有垃圾",
        "无明显垃圾",
        "无垃圾",
        "没有可见垃圾",
        "无可见垃圾",
        "地上没有",
        "未发现垃圾",
        "未发现明显垃圾",
    ]
    explicitly_no_garbage = any(phrase in reason for phrase in no_garbage_phrases)

    if action == "start_vacuum":
        # The vacuum is only started when garbage was detected and deemed safe.
        has_garbage = True
    elif explicitly_no_garbage:
        has_garbage = False
    else:
        # ACTION: DO_NOT_START but no explicit "no garbage" phrase
        # usually means there is garbage that is unsafe for the vacuum.
        has_garbage = True

    # If no explicit ACTION was found, fall back to keyword matching.
    if action == "manual_cleanup" and "ACTION:" not in text.upper():
        if "适合" in reason and "不适合" not in reason:
            action = "start_vacuum"
            has_garbage = True

    return {
        "has_garbage": has_garbage,
        "garbage_items": [],
        "vacuumable": action == "start_vacuum",
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
        super().__init__("navi_check_clean_image_subscriber")
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
            raise TimeoutError(
                f"Timeout waiting for image on topic {self._subscription.topic_name}"
            )
        return self._image


def capture_from_ros2(
    topic_name: str = _ROS2_IMAGE_TOPIC,
    output_dir: str | None = None,
    timeout_sec: float = 10.0,
) -> str:
    """Subscribe to a ROS2 image topic and save one frame as a JPEG file."""
    if output_dir is None:
        output_dir = str(_SKILL_ROOT / "scripts" / "photos")
    os.makedirs(output_dir, exist_ok=True)

    print(f"📷 等待 ROS2 图像话题: {topic_name}")
    rclpy.init()
    try:
        node = _ImageSubscriber(topic_name)
        msg = node.get_image(timeout_sec=timeout_sec)
        img = _ros_image_to_cv2(msg)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(output_dir, f"ros2_{ts}.jpg")
        cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        print(f"✅ 已保存照片: {path}")
        return path
    finally:
        node.destroy_node()
        rclpy.shutdown()


def capture_and_decide() -> dict:
    """Capture a floor photo from a ROS2 image topic and return the parsed decision."""
    image_path = capture_from_ros2()
    recognition = _recognize_image(image_path, _VACUUM_CHECK_PROMPT)
    decision = _parse_recognition(recognition)
    decision["image_path"] = image_path
    decision["raw_recognition"] = recognition
    return decision


def start_vacuum() -> None:
    """Call the start-clean.sh script to dispatch the robot vacuum."""
    start_script = _find_start_script()
    if not start_script.exists():
        raise FileNotFoundError(f"Vacuum start script not found: {start_script}")

    subprocess.run(["bash", str(start_script)], check=True)


def navigate_to_target() -> None:
    """Navigate to the fixed cleaning pose before capturing the photo."""
    navigate_script = _find_navigate_script()
    if not navigate_script.exists():
        raise FileNotFoundError(f"Navigation script not found: {navigate_script}")

    print("🧭 正在导航到清扫位置...")
    result = subprocess.run(
        ["bash", str(navigate_script), "1.0", "2.0", "0.0", "0", "0", "0.707", "0.707"],
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"导航到清扫位置失败 (退出码: {result.returncode})")
    print("✅ 已到达清扫位置。")


def main() -> int:
    try:
        navigate_to_target()
        decision = capture_and_decide()
    except Exception as exc:
        print(f"导航、拍照或识别失败：{exc}", file=sys.stderr)
        return 1

    reason = decision.get("reason", "")
    image_path = decision.get("image_path")
    raw_recognition = decision.get("raw_recognition", "")

    # Always print the raw model response first so the prompt can be tuned.
    print("===== Qwen 原始输出 =====")
    print(raw_recognition)
    print("=========================")
    print(f"[解析结果] 识别结论：{reason}")

    print("【Demo 模式】无论识别结果如何，都启动扫地机。")
    print(f"识别结果：{reason}")
    print("正在启动扫地机...")
    try:
        start_vacuum()
        print("扫地机已启动。")
    except subprocess.CalledProcessError as exc:
        print(f"扫地机启动失败：{exc}", file=sys.stderr)
        return 1

    if image_path:
        print(f"照片已保存：{image_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())