import { Body, Controller, Get, Patch, Post } from '@nestjs/common';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { LeaveService } from './leave.service';
import { StartLeaveDto } from './dto/leave.dto';

/**
 * Your own availability.
 *
 * Deliberately self-service: going on leave hands your work to named people,
 * and the person who knows who should take which requisition is you. Corporate
 * HR can still reassign a recruiter, or change a unit's HR layering, if
 * somebody is away without having said so.
 */
@Controller('me/leave')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get()
  status(@CurrentUser() user: AuthUser) {
    return this.leave.status(user.id);
  }

  /** What would move — read before setting leave, to fill in the panel. */
  @Get('handover')
  handover(@CurrentUser() user: AuthUser) {
    return this.leave.handover(user.id);
  }

  @Post()
  start(@Body() dto: StartLeaveDto, @CurrentUser() user: AuthUser) {
    return this.leave.start(dto, { id: user.id, name: user.name });
  }

  /** Back — early, or from an open-ended absence. */
  @Patch('end')
  end(@CurrentUser() user: AuthUser) {
    return this.leave.end({ id: user.id, name: user.name });
  }
}
