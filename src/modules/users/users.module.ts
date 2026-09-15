import { Module } from '@nestjs/common';

import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  // Signature uploads on someone else's profile are gated by the same roles
  // that gate editing an employee record.
  imports: [RbacModule],
  providers: [UsersService],
  controllers: [UsersController],
})
export class UsersModule {}
