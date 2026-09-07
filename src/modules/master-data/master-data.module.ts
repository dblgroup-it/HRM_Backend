import { Module } from '@nestjs/common';

import { MasterDataService } from './master-data.service';
import { MasterDataController } from './master-data.controller';

@Module({
  providers: [MasterDataService],
  controllers: [MasterDataController],
  exports: [MasterDataService],
})
export class MasterDataModule {}
