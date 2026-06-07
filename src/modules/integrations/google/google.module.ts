import { Global, Module } from '@nestjs/common';

import { GoogleAuthService } from './google-auth.service';
import { DriveService } from './drive.service';
import { GoogleController } from './google.controller';

/** Global so any module (e.g. requisition, candidates) can inject DriveService. */
@Global()
@Module({
  providers: [GoogleAuthService, DriveService],
  controllers: [GoogleController],
  exports: [GoogleAuthService, DriveService],
})
export class GoogleModule {}
