import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { FacilityProvisioningService } from './facility-provisioning.service';
import { NotifyFacilityDto } from './dto/facility-provisioning.dto';

/** HR-facing: notify Admin/IT to arrange a confirmed facility ahead of joining. */
@Controller('candidates/:id/facility-provisioning')
export class FacilityProvisioningController {
  constructor(private readonly provisioning: FacilityProvisioningService) {}

  @Get()
  getStatus(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.provisioning.getStatus(id, user.id);
  }

  @Get(':key/suggest')
  suggest(
    @Param('id') id: string,
    @Param('key') key: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.provisioning.suggestRecipients(id, key, user.id);
  }

  @Post(':key/notify')
  notify(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: NotifyFacilityDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.provisioning.notify(id, key, dto, user);
  }
}
