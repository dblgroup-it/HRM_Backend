import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';

/** Global so any module (e.g. candidate AI screening) can read app settings. */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [SettingsService],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
