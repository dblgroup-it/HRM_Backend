import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { UsersService, type UploadedImage } from './users.service';

const AVATAR_UPLOAD = { limits: { fileSize: 2 * 1024 * 1024 } };

class UpdatePreferencesDto {
  @IsBoolean()
  emailNotifications!: boolean;
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Current user's notification preferences. */
  @Get('me/preferences')
  getPreferences(@CurrentUser() user: AuthUser) {
    return this.users.getPreferences(user.id);
  }

  @Patch('me/preferences')
  updatePreferences(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.users.updatePreferences(user.id, dto.emailNotifications);
  }

  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('image', AVATAR_UPLOAD))
  uploadAvatar(
    @CurrentUser() user: AuthUser,
    @UploadedFile() image?: UploadedImage,
  ) {
    return this.users.uploadAvatar(user.id, image);
  }

  @Delete('me/avatar')
  removeAvatar(@CurrentUser() user: AuthUser) {
    return this.users.deleteAvatar(user.id);
  }

  /** Public so it can be used directly as an <img> source. */
  @Public()
  @Get(':userId/avatar')
  async avatar(@Param('userId') userId: string, @Res() res: Response) {
    const { stream, mimeType } = await this.users.getAvatarMedia(userId);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    stream.on('error', () => res.status(404).end());
    stream.pipe(res);
  }
}
