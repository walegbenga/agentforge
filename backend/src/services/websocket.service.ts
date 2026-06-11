import { WebSocketServer, WebSocket } from "ws";
import type { WSEvent } from "../types/index.js";

class WebSocketService {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();

  initialize(wss: WebSocketServer): void {
    this.wss = wss;

    wss.on("connection", (ws) => {
      this.clients.add(ws);
      console.log(`WS client connected. Total: ${this.clients.size}`);

      ws.on("close", () => {
        this.clients.delete(ws);
        console.log(`WS client disconnected. Total: ${this.clients.size}`);
      });

      ws.on("error", (err) => {
        console.error("WS error:", err.message);
        this.clients.delete(ws);
      });

      // Send ping to keep alive
      ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
    });
  }

  broadcast(event: WSEvent): void {
    const message = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  broadcastToTask(taskId: string, event: WSEvent): void {
    // For now same as broadcast; extend with rooms if needed
    this.broadcast(event);
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

export const wsService = new WebSocketService();
