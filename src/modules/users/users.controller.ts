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
  IMAGE_UPLOAD as AVATAR_UPLOAD,
  SIGNATURE_UPLOAD,
} from '../../common/upload/file-upload';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { UsersService, type UploadedImage } from './users.service';

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

  /** Your own e-signature. */
  @Post('me/signature')
  @UseInterceptors(FileInterceptor('image', SIGNATURE_UPLOAD))
  uploadMySignature(
    @CurrentUser() user: AuthUser,
    @UploadedFile() image?: UploadedImage,
  ) {
    return this.users.uploadSignature(user.id, user.id, image);
  }

  @Delete('me/signature')
  removeMySignature(@CurrentUser() user: AuthUser) {
    return this.users.deleteSignature(user.id, user.id);
  }

  /**
   * Someone else's e-signature — HR placing one for staff who will not do it
   * themselves. Refused once that person has signed for themselves; the rule
   * lives in the service, not here.
   */
  @Post(':userId/signature')
  @UseInterceptors(FileInterceptor('image', SIGNATURE_UPLOAD))
  uploadSignature(
    @Param('userId') userId: string,
    @CurrentUser() actor: AuthUser,
    @UploadedFile() image?: UploadedImage,
  ) {
    return this.users.uploadSignature(userId, actor.id, image);
  }

  @Delete(':userId/signature')
  removeSignature(
    @Param('userId') userId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.users.deleteSignature(userId, actor.id);
  }

  // NOTE: there is deliberately no `GET :userId/signature` route.
  //
  // An open image route was the first version of this, copied from the avatar
  // proxy. A signature is forgery material and user ids appear in ordinary API
  // responses, so "you have to know the id" was not a control. Signatures are
  // now served as signed, expiring grants through /api/files/:grant, minted
  // into the responses that already carry the record.
  //
  // If a signature ever needs to appear in an emailed letter, a 15-minute
  // grant will be dead before the mail is opened. The answer then is a
  // token-scoped route like /api/board-vote/:token/cv — NOT reopening this one.

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
