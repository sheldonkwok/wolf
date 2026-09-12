import { expect, test } from "bun:test";
import { channel } from "node:diagnostics_channel";
import { EventEmitter } from "eventemitter3";
import { SlackWebSocket } from "@slack/socket-mode/dist/src/SlackWebSocket.js";

test("Slack's transport exchanges heartbeats and messages under Bun", async () => {
  let clientPings = 0;
  let serverPings = 0;
  let serverPongs = 0;
  const pingChannel = channel("undici:websocket:ping");
  const pongChannel = channel("undici:websocket:pong");
  const onPing = () => { serverPings++; };
  const onPong = () => { serverPongs++; };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (!server.upgrade(request)) return new Response("WebSocket required", { status: 400 });
    },
    websocket: {
      open(ws) { ws.ping("server heartbeat"); },
      ping(ws) {
        clientPings++;
        if (clientPings >= 5) ws.send("healthy");
      },
      message(ws, message) { ws.send(message); },
    },
  });
  const client = new EventEmitter();
  const socket = new SlackWebSocket({
    url: `ws://127.0.0.1:${server.port}`,
    client,
    pingInterval: 50,
    clientPingTimeoutMS: 1_000,
    serverPingTimeoutMS: 2_000,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const healthy = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Slack heartbeat exchange timed out")), 3_000);
    client.on("error", reject);
    client.on("close", () => reject(new Error("Slack transport closed during heartbeat exchange")));
    client.on("ws_message", (message: string) => {
      if (message === "healthy") socket.send("echo", error => { if (error) reject(error); });
      if (message === "echo") resolve();
    });
  });
  pingChannel.subscribe(onPing);
  pongChannel.subscribe(onPong);
  try {
    socket.connect();
    await healthy;
    expect(socket.isActive()).toBe(true);
    expect(clientPings).toBeGreaterThanOrEqual(5);
    expect(serverPings).toBeGreaterThanOrEqual(1);
    expect(serverPongs).toBeGreaterThanOrEqual(4);
  } finally {
    clearTimeout(timeout);
    pingChannel.unsubscribe(onPing);
    pongChannel.unsubscribe(onPong);
    socket.disconnect();
    // A second disconnect forces cleanup while the close handshake is pending.
    socket.disconnect();
    await server.stop(true);
  }
});
