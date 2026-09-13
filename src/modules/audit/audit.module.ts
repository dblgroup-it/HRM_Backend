import { Global, Module, OnModuleInit } from '@nestjs/common';

import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { RbacModule } from '../rbac/rbac.module';

/**
 * Global so the interceptor can reach the service from anywhere.
 *
 * On startup it hands the service to PrismaService, which cannot inject it the
 * usual way: AuditService depends on Prisma, so constructor injection in both
 * directions would be circular.
 */
@Global()
@Module({
  imports: [RbacModule],
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.prisma.setAuditService(this.audit);
  }
}
