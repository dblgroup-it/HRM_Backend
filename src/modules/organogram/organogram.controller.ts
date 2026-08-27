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

  /** Distinct grade values already in use (Employee + Position) — for the grade input's suggestions. */
  @Get('grade-values')
  getGradeValues() {
    return this.organogramService.getGradeValues();
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
