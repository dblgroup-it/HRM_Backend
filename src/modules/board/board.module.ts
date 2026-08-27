import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MailModule } from '../integrations/mail/mail.module';
import { CandidatesModule } from '../candidates/candidates.module';
import { BoardService } from './board.service';
import { BoardController } from './board.controller';
import { BoardPublicController } from './board-public.controller';

@Module({
  // CandidatesModule exports RecruitmentService (Drive workspace builder,
  // used to upload the HR-approval attachment).
  imports: [RbacModule, RealtimeModule, MailModule, CandidatesModule],
  providers: [BoardService],
  controllers: [BoardController, BoardPublicController],
})
export class BoardModule {}
