import { Global, Module } from '@nestjs/common';

import { RbacService } from './rbac.service';
import { PermissionsService } from './permissions.service';
import { RbacController } from './rbac.controller';

@Global()
@Module({
  providers: [RbacService, PermissionsService],
  controllers: [RbacController],
  exports: [PermissionsService],
})
export class RbacModule {}
