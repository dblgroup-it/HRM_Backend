import { Controller, Get, Query } from '@nestjs/common';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { OrganogramService } from './organogram.service';
import { SeatLookupDto } from './dto/lookup.dto';

@Controller('organogram')
export class OrganogramController {
  constructor(private readonly organogramService: OrganogramService) {}

  @Get()
  getOrganogram(@CurrentUser() user: AuthUser) {
    return this.organogramService.getOrganogram(user.id);
  }

  @Get('lookup')
  lookup(@Query() query: SeatLookupDto, @CurrentUser() user: AuthUser) {
    return this.organogramService.lookup(
      query.unit,
      query.department,
      query.designation,
      user.id,
    );
  }
}
