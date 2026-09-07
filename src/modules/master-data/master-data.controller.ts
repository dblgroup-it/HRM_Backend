import { Controller, Get } from '@nestjs/common';

import { MasterDataService } from './master-data.service';

/**
 * The requisition form's fixed vocabulary. Readable by any signed-in user —
 * it is org reference data, not sensitive, and every requisitioner needs it.
 */
@Controller('master-data')
export class MasterDataController {
  constructor(private readonly masterData: MasterDataService) {}

  @Get()
  getAll() {
    return this.masterData.getAll();
  }
}
