import type { Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { userFromToken, type AuthUser } from "./auth.js";

interface RealtimeEvent {
  type: string;
  payload: unknown;
}

export class RealtimeHub {
  // 同一账号可能同时打开多个标签页；只有最后一个连接关闭时才广播离线。
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly wss = new WebSocketServer({ noServer: true });

  attach(server: Server): void {
    server.on("upgrade", async (request, socket: Socket, head) => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== "/ws") {
          socket.destroy();
          return;
        }

        const token = url.searchParams.get("token");
        const user = token ? await userFromToken(token) : null;
        if (!user) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        this.wss.handleUpgrade(request, socket, head, (webSocket) => {
          this.register(webSocket, user);
        });
      } catch {
        socket.destroy();
      }
    });
  }

  isOnline(userId: string): boolean {
    return (this.sockets.get(userId)?.size ?? 0) > 0;
  }

  onlineUserIds(): string[] {
    return [...this.sockets.entries()]
      .filter(([, connections]) => connections.size > 0)
      .map(([userId]) => userId);
  }

  sendToUsers(userIds: string[], event: RealtimeEvent): void {
    const data = JSON.stringify(event);
    for (const userId of new Set(userIds)) {
      for (const socket of this.sockets.get(userId) ?? []) {
        if (socket.readyState === WebSocket.OPEN) socket.send(data);
      }
    }
  }

  disconnectUser(userId: string): void {
    for (const socket of this.sockets.get(userId) ?? []) {
      socket.close(4003, "Account disabled or session invalidated");
    }
  }

  close(): void {
    const sockets = [...this.sockets.values()].flatMap((connections) => [...connections]);
    this.sockets.clear();
    for (const socket of sockets) {
      socket.close(1001, "Server shutting down");
    }
    this.wss.close();
  }

  private register(socket: WebSocket, user: AuthUser): void {
    const wasOnline = this.isOnline(user.id);
    const userSockets = this.sockets.get(user.id) ?? new Set<WebSocket>();
    userSockets.add(socket);
    this.sockets.set(user.id, userSockets);

    socket.send(
      JSON.stringify({
        type: "presence.snapshot",
        payload: { onlineUserIds: this.onlineUserIds() },
      }),
    );

    if (!wasOnline) {
      this.broadcast({
        type: "presence.changed",
        payload: { userId: user.id, online: true },
      });
    }

    socket.on("close", () => {
      const connections = this.sockets.get(user.id);
      connections?.delete(socket);
      if (connections?.size === 0) {
        this.sockets.delete(user.id);
        this.broadcast({
          type: "presence.changed",
          payload: { userId: user.id, online: false },
        });
      }
    });
  }

  private broadcast(event: RealtimeEvent): void {
    this.sendToUsers([...this.sockets.keys()], event);
  }
}
