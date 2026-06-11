import { Global, Module } from '@nestjs/common';

import { GoogleAuthService } from './google-auth.service';
import { DriveService } from './drive.service';
import { CalendarService } from './calendar.service';
import { GmailService } from './gmail.service';
import { GoogleController } from './google.controller';

/** Global so any module (e.g. requisition, candidates) can inject DriveService. */
@Global()
@Module({
  providers: [GoogleAuthService, DriveService, CalendarService, GmailService],
  controllers: [GoogleController],
  exports: [GoogleAuthService, DriveService, CalendarService, GmailService],
})
export class GoogleModule {}
