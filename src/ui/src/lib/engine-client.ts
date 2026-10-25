import { incomingEnvelopeSchema, type IncomingEnvelope, type OutgoingEnvelope, type OutgoingType } from "./contracts";

export type ConnectionStatus = "mock" | "connecting" | "connected" | "reconnecting" | "disconnected";

interface EngineClientOptions {
  url?: string;
  token?: string;
  sessionId: string;
  onEvent: (event: IncomingEnvelope) => void;
  onStatus: (status: ConnectionStatus) => void;
  onInvalidMessage: (reason: string) => void;
}

export class EngineClient {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private attempts = 0;
  private seenEventIds = new Set<string>();

  constructor(private readonly options: EngineClientOptions) {}

  connect() {
    if (!this.options.url) {
      this.options.onStatus("mock");
      return;
    }
    this.options.onStatus(this.attempts ? "reconnecting" : "connecting");
    const url = new URL(this.options.url);
    if (this.options.token) url.searchParams.set("token", this.options.token);
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => {
      this.attempts = 0;
      this.options.onStatus("connected");
    });
    this.socket.addEventListener("message", (message) => {
      try {
        const parsed = incomingEnvelopeSchema.safeParse(JSON.parse(String(message.data)));
        if (!parsed.success) {
          this.options.onInvalidMessage(parsed.error.issues[0]?.message ?? "Invalid engine event");
          return;
        }
        if (this.seenEventIds.has(parsed.data.eventId)) return;
        this.seenEventIds.add(parsed.data.eventId);
        this.options.onEvent(parsed.data);
      } catch {
        this.options.onInvalidMessage("Engine sent malformed JSON");
      }
    });
    this.socket.addEventListener("close", () => this.scheduleReconnect());
    this.socket.addEventListener("error", () => this.socket?.close());
  }

  send(type: OutgoingType, payload: unknown) {
    const envelope: OutgoingEnvelope = {
      sessionId: this.options.sessionId,
      eventId: crypto.randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      payload
    };
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(envelope));
    }
    return envelope;
  }

  close() {
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private scheduleReconnect() {
    this.options.onStatus("disconnected");
    this.attempts += 1;
    const delay = Math.min(1000 * 2 ** (this.attempts - 1), 10_000);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }
}
