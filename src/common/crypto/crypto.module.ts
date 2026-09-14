import { Global, Module } from '@nestjs/common';

import { SecretEncryptionService } from './secret-encryption.service';

/** Global: any service storing a reversible secret needs this. */
@Global()
@Module({
  providers: [SecretEncryptionService],
  exports: [SecretEncryptionService],
})
export class CryptoModule {}
