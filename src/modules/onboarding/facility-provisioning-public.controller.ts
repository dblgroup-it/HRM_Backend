import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { FacilityProvisioningService } from './facility-provisioning.service';
import { ConfirmFacilityDto } from './dto/facility-provisioning.dto';

/** Public — the Admin/IT recipient's one-time confirmation link, no login required. */
@Controller('facility-provisioning')
export class FacilityProvisioningPublicController {
  constructor(private readonly provisioning: FacilityProvisioningService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  getByToken(@Param('token') token: string) {
    return this.provisioning.getByToken(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token/confirm')
  confirm(@Param('token') token: string, @Body() dto: ConfirmFacilityDto) {
    return this.provisioning.confirmByToken(token, dto.note);
  }
}
