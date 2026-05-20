import WebSocket from "ws";
import { createLogger } from "../utils/logger.js";

const log = createLogger("foxglove/client.ts");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FoxgloveClient {
  private ws: WebSocket | null = null;
  private _channelId = 100;
  private _topics = new Map<string, number>();
  private _connected = false;
  private _reconnectDelay = 1000;
  private readonly _maxReconnectDelay = 30000;
  private _publishTimer: NodeJS.Timeout | null = null;
  private _currentTwist = {
    linear: { x: 0, y: 0, z: 0 },
    angular: { x: 0, y: 0, z: 0 },
  };

  constructor(private readonly uri: string) {}

  get connected(): boolean {
    return this._connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    while (true) {
      try {
        log.info("connect", `Connecting to ${this.uri}...`);
        this.ws = new WebSocket(this.uri, ["foxglove.sdk.v1"]);

        await new Promise<void>((resolve, reject) => {
          this.ws!.once("open", resolve);
          this.ws!.once("error", reject);
        });

        this._connected = true;
        this._reconnectDelay = 1000;
        log.info("connect", "WebSocket connected");

        const serverInfo = await this._waitServerInfo();
        log.info("connect", "Server capabilities:", serverInfo.capabilities);

        for (const [topic, cid] of this._topics) {
          await this._doAdvertise(cid, topic, "json", "geometry_msgs/Twist", "geometry_msgs/msg/Twist");
        }

        this.ws.on("close", () => {
          if (this._connected) {
            log.warn("connect", "Connection lost, reconnecting...");
            this._connected = false;
            this._scheduleReconnect();
          }
        });

        this.ws.on("error", (err) => {
          log.error("connect", "WebSocket error:", err.message);
        });

        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("connect", `Connection failed: ${msg}. Retrying in ${this._reconnectDelay}ms...`);
        await sleep(this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
      }
    }
  }

  private async _waitServerInfo(timeout = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("serverInfo not received")), timeout);
      const handler = (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.op === "serverInfo") {
            clearTimeout(timer);
            this.ws!.off("message", handler);
            resolve(msg);
          }
        } catch {}
      };
      this.ws!.on("message", handler);
    });
  }

  async advertiseTopic(topic: string): Promise<number> {
    const cid = this._channelId++;
    this._topics.set(topic, cid);
    await this._doAdvertise(cid, topic, "json", "geometry_msgs/Twist", "geometry_msgs/msg/Twist");
    log.info("advertiseTopic", `Advertised '${topic}' on channel ${cid}`);
    return cid;
  }

  private async _doAdvertise(cid: number, topic: string, encoding: string, schemaName: string, schema: string): Promise<void> {
    this._sendJson({
      op: "advertise",
      channels: [{ id: cid, topic, encoding, schemaName, schema }],
    });
  }

  publishJson(channelId: number, obj: Record<string, unknown>): void {
    const payload = Buffer.from(JSON.stringify(obj), "utf-8");
    const header = Buffer.alloc(5);
    header.writeUInt8(0x01, 0);
    header.writeUInt32LE(channelId, 1);
    this._sendBinary(Buffer.concat([header, payload]));
  }

  startPublishing(channelId: number, twist: typeof this._currentTwist, hz = 10): void {
    this._currentTwist = twist;
    this.stopPublishing();
    this._publishTimer = setInterval(() => {
      this.publishJson(channelId, this._currentTwist);
    }, 1000 / hz);
    log.info("startPublishing", `Publishing at ${hz}Hz`);
  }

  stopPublishing(): void {
    if (this._publishTimer) {
      clearInterval(this._publishTimer);
      this._publishTimer = null;
    }
  }

  setTwist(lx: number, ly: number, lz: number, ax: number, ay: number, az: number): void {
    this._currentTwist = {
      linear: { x: lx, y: ly, z: lz },
      angular: { x: ax, y: ay, z: az },
    };
  }

  disconnect(): void {
    this.stopPublishing();
    this._connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    log.info("disconnect", "Disconnected");
  }

  private _sendJson(obj: Record<string, unknown>): void {
    if (!this.connected) throw new Error("Not connected");
    this.ws!.send(JSON.stringify(obj));
  }

  private _sendBinary(data: Buffer): void {
    if (!this.connected) throw new Error("Not connected");
    this.ws!.send(data);
  }

  private _scheduleReconnect(): void {
    setTimeout(() => this.connect(), this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
  }
}
