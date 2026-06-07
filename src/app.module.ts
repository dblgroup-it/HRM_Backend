import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';

import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { HealthController } from './health/health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { UnitsModule } from './modules/units/units.module';
import { OrganogramModule } from './modules/organogram/organogram.module';
import { RequisitionModule } from './modules/requisition/requisition.module';
import { ZingHrModule } from './modules/integrations/zinghr/zinghr.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { RealtimeModule } from './modules/realtime/realtime.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    EmployeesModule,
    DashboardModule,
    UnitsModule,
    OrganogramModule,
    RequisitionModule,
    ZingHrModule,
    RbacModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
  providers: [
    // JWT auth applies globally; opt out per-route with @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Role checks apply where @Roles() is present.
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
