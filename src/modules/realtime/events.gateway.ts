import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

interface JwtPayload {
  sub: string;
}

@WebSocketGateway({ cors: { origin: '*' } })
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(EventsGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  handleConnection(client: Socket): void {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      client.handshake.headers.authorization?.replace('Bearer ', '');
    try {
      const payload = this.jwt.verify<JwtPayload>(token ?? '', {
        secret: this.config.get<string>('jwt.secret'),
      });
      client.data.userId = payload.sub;
      void client.join(`user:${payload.sub}`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(_client: Socket): void {
    // no-op
  }

  /** Send an event to one user's room (all their open tabs). */
  emitToUser(userId: string, event: string, data: unknown): void {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  emitToUsers(userIds: string[], event: string, data: unknown): void {
    for (const id of new Set(userIds)) this.emitToUser(id, event, data);
  }

  /** Send an event to every connected client (live cache invalidation). */
  broadcast(event: string, data: unknown): void {
    this.server.emit(event, data);
  }
}
