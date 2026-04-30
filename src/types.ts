export type Channel = "web" | "slack";

export type ChatEvent = {
  sessionId: string;
  channel: Channel;
  userId?: string;
  text: string;
  timestamp: string;
};

export type ChatEventOut =
  | {
      sessionId: string;
      channel: Channel;
      type: "status";
      payload: { status: "thinking" | "done" };
    }
  | {
      sessionId: string;
      channel: Channel;
      type: "token";
      payload: { text: string };
    }
  | {
      sessionId: string;
      channel: Channel;
      type: "tool";
      payload: {
        name: string;
        status: "executing" | "ok" | "error";
        input?: unknown;
        output?: unknown;
        error?: string;
      };
    }
  | {
      sessionId: string;
      channel: Channel;
      type: "final";
      payload: { text: string };
    }
  | {
      sessionId: string;
      channel: Channel;
      type: "error";
      payload: { message: string };
    };
