#!/usr/bin/env python3
"""
Foxglove Bridge Robot Controller - Resident Server
Maintains persistent WebSocket connection to foxglove_bridge,
exposes HTTP API for fast robot control commands.
"""
import asyncio
import json
import os
import struct
import sys
import time
import traceback

# Add bundled websockets library
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_DIR = os.path.dirname(_SCRIPT_DIR)
sys.path.insert(0, os.path.join(_SKILL_DIR, "lib"))

import websockets
from websockets.protocol import State

# Configuration
BRIDGE_HOST = os.environ.get("FOXGLOVE_HOST", "172.18.0.1")
BRIDGE_PORT = int(os.environ.get("FOXGLOVE_PORT", "8765"))
BRIDGE_URI = f"ws://{BRIDGE_HOST}:{BRIDGE_PORT}"
API_PORT = int(os.environ.get("ROBOT_API_PORT", "9999"))

# Topic configuration (override for real robots)
CMD_VEL_TOPIC = os.environ.get("ROBOT_CMD_TOPIC", "/turtle1/cmd_vel")
SCHEMA_NAME = os.environ.get("ROBOT_SCHEMA", "geometry_msgs/Twist")
SCHEMA = os.environ.get("ROBOT_SCHEMA_DEF", "geometry_msgs/msg/Twist")


class FoxgloveClient:
    """Robust Foxglove WebSocket client with auto-reconnect."""

    def __init__(self, uri: str):
        self.uri = uri
        self.ws = None
        self.channel_id = 100
        self.server_info = None
        self._connected = False
        self._reconnect_delay = 1.0
        self._max_reconnect_delay = 30.0
        self._topics = {}  # topic -> channel_id

    @property
    def connected(self) -> bool:
        if not self._connected or self.ws is None:
            return False
        return self.ws.state == State.OPEN

    async def connect(self) -> bool:
        """Connect with exponential backoff retry."""
        while True:
            try:
                print(f"🔌 Connecting to {self.uri} ...")
                self.ws = await websockets.connect(
                    self.uri,
                    subprotocols=["foxglove.sdk.v1"],
                    ping_interval=20,
                    ping_timeout=10,
                    close_timeout=5,
                )
                self._connected = True
                self._reconnect_delay = 1.0
                print("✅ WebSocket connected")

                self.server_info = await self._wait_server_info()
                caps = self.server_info.get("capabilities", [])
                print(f"✅ Server capabilities: {caps}")

                # Re-advertise topics after reconnect
                for topic, (cid, enc, sname, sdef) in list(self._topics.items()):
                    await self._do_advertise(cid, topic, enc, sname, sdef)

                return True

            except Exception as e:
                print(f"❌ Connection failed: {e}. Retrying in {self._reconnect_delay}s...")
                await asyncio.sleep(self._reconnect_delay)
                self._reconnect_delay = min(self._reconnect_delay * 2, self._max_reconnect_delay)

    async def _wait_server_info(self, timeout: float = 5.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                msg = await asyncio.wait_for(self.ws.recv(), timeout=0.5)
                data = json.loads(msg)
                if data.get("op") == "serverInfo":
                    return data
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                print(f"⚠️ Error waiting serverInfo: {e}")
                break
        raise RuntimeError("serverInfo not received")

    async def send_json(self, obj: dict):
        if not self.connected:
            raise RuntimeError("Not connected")
        await self.ws.send(json.dumps(obj))

    async def send_binary(self, data: bytes):
        if not self.connected:
            raise RuntimeError("Not connected")
        await self.ws.send(data)

    async def _do_advertise(self, cid: int, topic: str, encoding: str, schema_name: str, schema: str):
        await self.send_json({
            "op": "advertise",
            "channels": [{
                "id": cid,
                "topic": topic,
                "encoding": encoding,
                "schemaName": schema_name,
                "schema": schema,
            }]
        })

    async def advertise_topic(self, topic: str, encoding: str,
                              schema_name: str, schema: str) -> int:
        cid = self.channel_id
        self.channel_id += 1
        self._topics[topic] = (cid, encoding, schema_name, schema)
        await self._do_advertise(cid, topic, encoding, schema_name, schema)
        print(f"📡 Advertised '{topic}' on channel {cid}")
        return cid

    async def publish_json(self, channel_id: int, obj: dict):
        """Publish a JSON-encoded message via Foxglove binary protocol."""
        payload = json.dumps(obj).encode("utf-8")
        data = struct.pack("<BI", 0x01, channel_id) + payload
        await self.send_binary(data)

    async def disconnect(self):
        if self.ws and self.ws.state == State.OPEN:
            await self.ws.close()
        self._connected = False
        print("🔌 Disconnected")


class RobotController:
    """High-level robot control API."""

    def __init__(self, client: FoxgloveClient):
        self.client = client
        self.cmd_vel_channel = None
        self._current_twist = {"linear": {"x": 0, "y": 0, "z": 0}, "angular": {"x": 0, "y": 0, "z": 0}}
        self._pub_task = None
        self._pub_hz = 10  # publish at 10Hz during motion

    async def init(self):
        await self.client.connect()
        self.cmd_vel_channel = await self.client.advertise_topic(
            topic=CMD_VEL_TOPIC,
            encoding="json",
            schema_name=SCHEMA_NAME,
            schema=SCHEMA,
        )
        await asyncio.sleep(0.3)

    async def _publish_loop(self):
        """Continuously publish current twist at _pub_hz."""
        interval = 1.0 / self._pub_hz
        while True:
            await self.client.publish_json(self.cmd_vel_channel, self._current_twist)
            await asyncio.sleep(interval)

    def _start_publishing(self, lx, ly, lz, ax, ay, az):
        """Start continuous publishing of a twist."""
        self._current_twist = {
            "linear": {"x": lx, "y": ly, "z": lz},
            "angular": {"x": ax, "y": ay, "z": az},
        }
        # cancel old loop if any
        if self._pub_task and not self._pub_task.done():
            self._pub_task.cancel()
        self._pub_task = asyncio.create_task(self._publish_loop())
        print(f"🚀 cmd_vel: linear=({lx:.2f},{ly:.2f},{lz:.2f}) angular=({ax:.2f},{ay:.2f},{az:.2f}) [10Hz]")

    async def move(self, lx=0.0, ly=0.0, lz=0.0, ax=0.0, ay=0.0, az=0.0):
        self._start_publishing(lx, ly, lz, ax, ay, az)

    async def stop(self):
        if self._pub_task and not self._pub_task.done():
            self._pub_task.cancel()
            try:
                await self._pub_task
            except asyncio.CancelledError:
                pass
        self._current_twist = {"linear": {"x": 0, "y": 0, "z": 0}, "angular": {"x": 0, "y": 0, "z": 0}}
        await self.client.publish_json(self.cmd_vel_channel, self._current_twist)
        print("🛑 Stop")

    async def forward(self, speed: float = 0.2):
        await self.move(speed, 0, 0, 0, 0, 0)

    async def backward(self, speed: float = 0.2):
        await self.move(-speed, 0, 0, 0, 0, 0)

    async def turn_left(self, speed: float = 0.5):
        await self.move(0, 0, 0, 0, 0, speed)

    async def turn_right(self, speed: float = 0.5):
        await self.move(0, 0, 0, 0, 0, -speed)

    async def forward_for(self, seconds: float, speed: float = 0.2):
        await self.forward(speed)
        await asyncio.sleep(seconds)
        await self.stop()

    async def turn_for(self, seconds: float, speed: float = 0.5):
        await self.turn_left(speed)
        await asyncio.sleep(seconds)
        await self.stop()


# ==================== HTTP API ====================

class HTTPServer:
    """Asyncio-based HTTP API server."""

    def __init__(self, robot: RobotController, port: int = 9999):
        self.robot = robot
        self.port = port
        self._server = None
        self._stop_tasks = set()

    async def start(self):
        self._server = await asyncio.start_server(
            self._handle_request, host="127.0.0.1", port=self.port
        )
        print(f"🤖 Robot API ready at http://127.0.0.1:{self.port}")

    async def stop(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        for task in list(self._stop_tasks):
            task.cancel()

    def _cancel_pending_stops(self):
        """Cancel all scheduled stop tasks before sending a new command."""
        for task in list(self._stop_tasks):
            task.cancel()
        self._stop_tasks.clear()

    def _schedule_stop(self, delay: float):
        start_time = time.time()
        async def do_stop():
            await asyncio.sleep(delay)
            elapsed = time.time() - start_time
            print(f"[DEBUG] stop task fired after {elapsed:.2f}s (expected {delay}s)")
            await self.robot.stop()
        task = asyncio.create_task(do_stop())
        self._stop_tasks.add(task)
        task.add_done_callback(self._stop_tasks.discard)

    async def _handle_request(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        addr = writer.get_extra_info("peername")
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            if not request_line:
                return
            method, path, _ = request_line.decode().strip().split(" ", 2)

            # Read headers
            headers = {}
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=5.0)
                if line == b"\r\n":
                    break
                key, val = line.decode().strip().split(":", 1)
                headers[key.lower()] = val.strip()

            # Parse path and query
            from urllib.parse import urlparse, parse_qs
            parsed = urlparse(path)
            action = parsed.path.strip("/")
            params = {k: v[0] for k, v in parse_qs(parsed.query).items()}

            result = await self._dispatch(action, params)
            status = 200 if result.get("ok") else (503 if "not initialized" in str(result.get("error", "")) else 400)

        except Exception as e:
            traceback.print_exc()
            result = {"error": str(e)}
            status = 500

        body = json.dumps(result).encode("utf-8")
        response = (
            f"HTTP/1.1 {status} {'OK' if status == 200 else 'Error'}\r\n"
            f"Content-Type: application/json\r\n"
            f"Access-Control-Allow-Origin: *\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Connection: close\r\n"
            f"\r\n"
        ).encode("utf-8") + body

        try:
            writer.write(response)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    async def _dispatch(self, action: str, params: dict) -> dict:
        if action == "status":
            connected = self.robot.client.connected
            return {"ok": True, "ready": connected, "connected": connected}

        if not self.robot.client.connected:
            return {"error": "Robot not connected"}

        # Cancel any pending auto-stop from previous commands
        self._cancel_pending_stops()

        print(f"[DEBUG] _dispatch action={action} params={params}")
        t = float(params.get("time", 1))
        speed = float(params.get("speed", 1.0))
        print(f"[DEBUG] parsed time={t} speed={speed}")

        if action == "forward":
            await self.robot.forward(speed)
            self._schedule_stop(t)
            return {"ok": True, "action": "forward", "time": t, "speed": speed}

        if action == "backward":
            await self.robot.backward(speed)
            self._schedule_stop(t)
            return {"ok": True, "action": "backward", "time": t, "speed": -speed}

        if action == "left":
            await self.robot.turn_left(speed)
            self._schedule_stop(t)
            return {"ok": True, "action": "left", "time": t, "speed": speed}

        if action == "right":
            await self.robot.turn_right(speed)
            self._schedule_stop(t)
            return {"ok": True, "action": "right", "time": t, "speed": -speed}

        if action == "stop":
            await self.robot.stop()
            return {"ok": True, "action": "stop"}

        if action == "move":
            lx = float(params.get("lx", 0))
            ly = float(params.get("ly", 0))
            lz = float(params.get("lz", 0))
            ax = float(params.get("ax", 0))
            ay = float(params.get("ay", 0))
            az = float(params.get("az", 0))
            await self.robot.move(lx, ly, lz, ax, ay, az)
            if t > 0:
                self._schedule_stop(t)
            return {"ok": True, "action": "move", "lx": lx, "ly": ly, "lz": lz,
                    "ax": ax, "ay": ay, "az": az, "time": t}

        return {"error": f"Unknown action: {action}"}


# ==================== Main ====================

async def main():
    client = FoxgloveClient(BRIDGE_URI)
    robot = RobotController(client)
    http = HTTPServer(robot, API_PORT)

    # Initialize robot connection
    await robot.init()

    # Start HTTP API
    await http.start()

    # Keep alive with reconnection monitoring
    try:
        while True:
            if not client.connected:
                print("🔌 Connection lost, reconnecting...")
                await client.connect()
            await asyncio.sleep(5)
    except KeyboardInterrupt:
        print("\n🛑 Shutting down...")
    finally:
        await http.stop()
        await robot.client.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
