type RosbridgeCallServiceMessage = {
  op: "call_service";
  service: string;
  id: string;
  args: Record<string, unknown>;
};

type RosbridgeServiceResponseMessage = {
  op: "service_response";
  service: string;
  id: string;
  result: boolean;
  values?: Record<string, unknown>;
};

type RosbridgeMessage = RosbridgeCallServiceMessage | RosbridgeServiceResponseMessage;

export class RosbridgeClient {
  private requestCounter = 0;

  constructor(private readonly url: string) {}

  async getParam(node: string, name: string): Promise<{ value: unknown }> {
    this.assertParamRequest(node, name);
    const response = await this.callService("/rosapi/get_param", {
      node,
      name,
      default: null
    });

    return { value: response.values?.value };
  }

  async setParam(node: string, name: string, value: unknown): Promise<{ ok: true }> {
    this.assertParamRequest(node, name);
    await this.callService("/rosapi/set_param", {
      node,
      name,
      value: JSON.stringify(value)
    });

    return { ok: true };
  }

  async driveRobotCloseFridgeDoor(): Promise<{ ok: true }> {
    console.log("ros2_drive_robot_close_fridge_door triggered (TODO: implement ROS2 action)");
    return { ok: true };
  }

  private callService(service: string, args: Record<string, unknown>): Promise<RosbridgeServiceResponseMessage> {
    const id = `call:${Date.now()}:${this.requestCounter++}`;

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`rosbridge service call timed out: ${service}`));
      }, 10000);

      socket.addEventListener("open", () => {
        const message: RosbridgeMessage = {
          op: "call_service",
          service,
          id,
          args
        };
        socket.send(JSON.stringify(message));
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as RosbridgeMessage;
        if (message.op !== "service_response" || message.id !== id) {
          return;
        }

        clearTimeout(timeout);
        socket.close();

        if (!message.result) {
          reject(new Error(`rosbridge service call failed: ${service}`));
          return;
        }

        resolve(message);
      });

      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error(`Unable to connect to rosbridge at ${this.url}`));
      });
    });
  }

  private assertParamRequest(node: string, name: string): void {
    if (!node.trim()) {
      throw new Error("ROS2 node is required.");
    }

    if (!name.trim()) {
      throw new Error("ROS2 parameter name is required.");
    }
  }
}
