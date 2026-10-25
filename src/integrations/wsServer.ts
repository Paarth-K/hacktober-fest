// Loopback-only WebSocket bridge between the engine and the UI.
// Binds 127.0.0.1 on a random port; every connection must present the per-launch token.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { ClientEnvelopeSchema, makeEnvelope } from "../shared/events.js";
import type { ClientEnvelope, ServerMessage } from "../shared/events.js";

export interface BridgeOptions {
  sessionId: string;
  /** 0 = random free port. */
  port?: number;
  token?: string;
  onMessage: (env: ClientEnvelope, reply: (m: ServerMessage) => void) => void | Promise<void>;
  onConnect?: (send: (m: ServerMessage) => void) => void;
  log?: (msg: string) => void;
}

export interface Bridge {
  port: number;
  token: string;
  broadcast(m: ServerMessage, replyTo?: string): void;
  close(): Promise<void>;
  clientCount(): number;
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const token = opts.token ?? randomBytes(24).toString("hex");
  const log = opts.log ?? (() => {});
  const seen = new Set<string>();
  const seenOrder: string[] = [];

  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: opts.port ?? 0,
    maxPayload: 1024 * 1024,
    verifyClient: (info, cb) => {
      const url = new URL(info.req.url ?? "/", "http://127.0.0.1");
      const remote = info.req.socket.remoteAddress ?? "";
      const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!loopback || !tokenMatches(url.searchParams.get("token"), token)) {
        log(`rejected connection from ${remote}`);
        return cb(false, 401, "Unauthorized");
      }
      cb(true);
    },
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const port = (wss.address() as AddressInfo).port;

  const sendTo = (ws: WebSocket, m: ServerMessage, replyTo?: string) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(makeEnvelope(opts.sessionId, m, replyTo)));
  };

  wss.on("connection", (ws) => {
    log("ui connected");
    opts.onConnect?.((m) => sendTo(ws, m));
    ws.on("message", async (data) => {
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        return sendTo(ws, { type: "error", payload: { code: "bad_json", message: "frame is not valid JSON" } });
      }
      const parsed = ClientEnvelopeSchema.safeParse(json);
      if (!parsed.success) {
        const replyTo = typeof (json as { eventId?: unknown })?.eventId === "string" ? (json as { eventId: string }).eventId : undefined;
        return sendTo(ws, { type: "error", payload: { code: "invalid_message", message: parsed.error.message.slice(0, 2000) } }, replyTo);
      }
      const env = parsed.data;
      if (seen.has(env.eventId)) return; // dedupe retransmits
      seen.add(env.eventId);
      seenOrder.push(env.eventId);
      if (seenOrder.length > 5000) seen.delete(seenOrder.shift()!);
      try {
        await opts.onMessage(env, (m) => sendTo(ws, m, env.eventId));
      } catch (e) {
        sendTo(ws, { type: "error", payload: { code: "handler_failed", message: e instanceof Error ? e.message : String(e) } }, env.eventId);
      }
    });
  });

  return {
    port,
    token,
    broadcast(m, replyTo) {
      for (const ws of wss.clients) sendTo(ws, m, replyTo);
    },
    clientCount: () => wss.clients.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}
