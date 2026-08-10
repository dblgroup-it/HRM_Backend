import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MailModule } from '../integrations/mail/mail.module';
import { BoardService } from './board.service';
import { BoardController } from './board.controller';
import { BoardPublicController } from './board-public.controller';

@Module({
  imports: [RbacModule, RealtimeModule, MailModule],
  providers: [BoardService],
  controllers: [BoardController, BoardPublicController],
})
export class BoardModule {}
