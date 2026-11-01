import { Global, Module } from '@nestjs/common';

import { RbacService } from './rbac.service';
import { PermissionsService } from './permissions.service';
import { RbacController } from './rbac.controller';
import { AccessNoticeService } from './access-notice.service';

@Global()
@Module({
  providers: [RbacService, PermissionsService, AccessNoticeService],
  controllers: [RbacController],
  exports: [PermissionsService, AccessNoticeService],
})
export class RbacModule {}
