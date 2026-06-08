import { Global, Module } from '@nestjs/common';

import { MailService } from './mail.service';

/** Global so any module can inject MailService (e.g. candidate emails). */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
