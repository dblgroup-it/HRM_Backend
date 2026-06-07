import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [RbacModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
