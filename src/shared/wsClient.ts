// Typed browser/Node WebSocket client for the engine. Used by the UI (P1).
// Validates every incoming frame with Zod, dedupes by eventId, reconnects with backoff.
import { ClientMessageSchema, ServerEnvelopeSchema, makeEnvelope, newId } from "./events.js";
import type { ClientMessage, ServerEnvelope, ServerMessage, ServerMessageType } from "./events.js";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface EngineConnection {
  port: number;
  token: string;
  host?: string;
}

type Handler<T extends ServerMessageType> = (payload: Extract<ServerMessage, { type: T }>["payload"], envelope: ServerEnvelope) => void;

export interface EngineClientOptions {
  /** Injected for Node tests; defaults to globalThis.WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  maxBackoffMs?: number;
  onInvalidMessage?: (raw: unknown, error: unknown) => void;
}

export class EngineClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler<any>>>();
  private anyHandlers = new Set<(e: ServerEnvelope) => void>();
  private stateHandlers = new Set<(s: ConnectionState) => void>();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private attempt = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _state: ConnectionState = "closed";
  readonly sessionId = newId("ui");

  constructor(
    private conn: EngineConnection,
    private opts: EngineClientOptions = {},
  ) {}

  get state(): ConnectionState {
    return this._state;
  }

  connect(): void {
    this.closedByUser = false;
    const WS = this.opts.WebSocketImpl ?? globalThis.WebSocket;
    const host = this.conn.host ?? "127.0.0.1";
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WS(`ws://${host}:${this.conn.port}/?token=${encodeURIComponent(this.conn.token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setState("open");
    };
    ws.onmessage = (ev: MessageEvent) => this.handleRaw(ev.data);
    ws.onclose = () => {
      this.ws = null;
      if (this.closedByUser) return this.setState("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.setState("closed");
  }

  /** Validates and sends a message. Returns the envelope eventId (match against envelope.replyTo). */
  send(message: ClientMessage): string {
    const parsed = ClientMessageSchema.parse(message);
    const env = makeEnvelope(this.sessionId, parsed);
    if (!this.ws || this.ws.readyState !== 1) throw new Error("engine not connected");
    this.ws.send(JSON.stringify(env));
    return env.eventId;
  }

  on<T extends ServerMessageType>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  onAny(handler: (e: ServerEnvelope) => void): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  onState(handler: (s: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    handler(this._state);
    return () => this.stateHandlers.delete(handler);
  }

  private handleRaw(data: unknown): void {
    let json: unknown;
    try {
      json = JSON.parse(typeof data === "string" ? data : String(data));
    } catch (e) {
      return this.opts.onInvalidMessage?.(data, e);
    }
    const result = ServerEnvelopeSchema.safeParse(json);
    if (!result.success) return this.opts.onInvalidMessage?.(json, result.error);
    const env = result.data;
    if (this.seen.has(env.eventId)) return;
    this.seen.add(env.eventId);
    this.seenOrder.push(env.eventId);
    if (this.seenOrder.length > 2000) this.seen.delete(this.seenOrder.shift()!);
    this.handlers.get(env.type)?.forEach((h) => h(env.payload, env));
    this.anyHandlers.forEach((h) => h(env));
  }

  private scheduleReconnect(): void {
    this.attempt++;
    this.setState("reconnecting");
    const delay = Math.min(this.opts.maxBackoffMs ?? 5000, 250 * 2 ** Math.min(this.attempt, 5));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private setState(s: ConnectionState): void {
    this._state = s;
    this.stateHandlers.forEach((h) => h(s));
  }
}
