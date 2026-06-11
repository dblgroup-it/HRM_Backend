import { Global, Module } from '@nestjs/common';

import { GoogleAuthService } from './google-auth.service';
import { DriveService } from './drive.service';
import { CalendarService } from './calendar.service';
import { GoogleController } from './google.controller';

/** Global so any module (e.g. requisition, candidates) can inject DriveService. */
@Global()
@Module({
  providers: [GoogleAuthService, DriveService, CalendarService],
  controllers: [GoogleController],
  exports: [GoogleAuthService, DriveService, CalendarService],
})
export class GoogleModule {}
