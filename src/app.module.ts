import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { MemoryCacheModule } from './common/cache/memory-cache.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { HealthController } from './health/health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { UnitsModule } from './modules/units/units.module';
import { OrganogramModule } from './modules/organogram/organogram.module';
import { ApprovalPathsModule } from './modules/approval-paths/approval-paths.module';
import { MasterDataModule } from './modules/master-data/master-data.module';
import { RequisitionModule } from './modules/requisition/requisition.module';
import { CandidatesModule } from './modules/candidates/candidates.module';
import { AssessmentModule } from './modules/assessment/assessment.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { InsightsModule } from './modules/insights/insights.module';
import { UsersModule } from './modules/users/users.module';
import { ZingHrModule } from './modules/integrations/zinghr/zinghr.module';
import { BdJobsModule } from './modules/integrations/bdjobs/bdjobs.module';
import { GoogleModule } from './modules/integrations/google/google.module';
import { MailModule } from './modules/integrations/mail/mail.module';
import { AiModule } from './modules/integrations/ai/ai.module';
import { SettingsModule } from './modules/settings/settings.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { AutomationModule } from './modules/automation/automation.module';
import { BoardModule } from './modules/board/board.module';
import { SalaryFixationModule } from './modules/salary-fixation/salary-fixation.module';
import { AiProficiencyModule } from './modules/ai-proficiency/ai-proficiency.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    // Global rate limit: 120 requests/min per IP (tighter on sensitive routes).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    MemoryCacheModule,
    AuthModule,
    EmployeesModule,
    DashboardModule,
    UnitsModule,
    OrganogramModule,
    ApprovalPathsModule,
    MasterDataModule,
    RequisitionModule,
    CandidatesModule,
    AssessmentModule,
    OnboardingModule,
    InsightsModule,
    UsersModule,
    ZingHrModule,
    BdJobsModule,
    GoogleModule,
    MailModule,
    AiModule,
    SettingsModule,
    RbacModule,
    RealtimeModule,
    AutomationModule,
    BoardModule,
    SalaryFixationModule,
    AiProficiencyModule,
  ],
  controllers: [HealthController],
  providers: [
    // Rate limiting runs first — throttles abuse before auth even resolves.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // JWT auth applies globally; opt out per-route with @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Role checks apply where @Roles() is present.
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
