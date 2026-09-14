import { Global, Module } from '@nestjs/common';

import { FileGrantService } from './file-grant.service';
import { SecureFileService } from './secure-file.service';
import { SecureFileController } from './secure-file.controller';

/**
 * Global so every module that serializes a document link can mint a grant
 * without a new import, the same way DriveService is available everywhere.
 */
@Global()
@Module({
  providers: [FileGrantService, SecureFileService],
  controllers: [SecureFileController],
  exports: [FileGrantService, SecureFileService],
})
export class SecureFilesModule {}
