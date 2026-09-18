import { ValidationPipe } from '@nestjs/common';

import {
  DeclineFacilityDto,
  NotifyFacilityDto,
} from './dto/facility-provisioning.dto';

/**
 * The facility-notification payload the picker actually sends.
 *
 * Every recipient chosen from the directory arrives with `email: ''`, because
 * the employee list stopped carrying personal email addresses and the client
 * defaults the missing field to an empty string. `@IsOptional()` does not skip
 * an empty string, so this rejected every such request with
 * "recipients.0.email must be an email" — over a field the service ignores,
 * since it resolves the address from `userId`.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});
const meta = { type: 'body' as const, metatype: NotifyFacilityDto };

describe('NotifyFacilityDto', () => {
  it('accepts a directory pick whose email came through blank', async () => {
    await expect(
      pipe.transform(
        { recipients: [{ userId: 'user-1', name: 'Test Person', email: '' }] },
        meta,
      ),
    ).resolves.toBeDefined();
  });

  it('accepts whitespace as blank too', async () => {
    await expect(
      pipe.transform(
        {
          recipients: [{ userId: 'user-1', name: 'Test Person', email: '   ' }],
        },
        meta,
      ),
    ).resolves.toBeDefined();
  });

  it('accepts a manual entry with a real address', async () => {
    const out = (await pipe.transform(
      { recipients: [{ name: 'Test Person', email: 'test@example.invalid' }] },
      meta,
    )) as NotifyFacilityDto;
    expect(out.recipients[0].email).toBe('test@example.invalid');
  });

  it('still rejects an address that is merely wrong', async () => {
    // Tolerating blank must not tolerate nonsense — a typo in a manually typed
    // address would otherwise reach the mail server.
    await expect(
      pipe.transform(
        { recipients: [{ name: 'X', email: 'not-an-address' }] },
        meta,
      ),
    ).rejects.toThrow();
  });

  it('still requires at least one recipient', async () => {
    await expect(pipe.transform({ recipients: [] }, meta)).rejects.toThrow();
  });
});

/**
 * Declining is the recipient's way of saying "this can't be done", and the
 * reason is the only thing HR gets to act on — so an empty or whitespace
 * refusal must not get through.
 */
describe('DeclineFacilityDto', () => {
  const declineMeta = { type: 'body' as const, metatype: DeclineFacilityDto };

  it('accepts a real reason', async () => {
    const out = (await pipe.transform(
      { reason: 'No quarters free until 15 October.' },
      declineMeta,
    )) as DeclineFacilityDto;
    expect(out.reason).toBe('No quarters free until 15 October.');
  });

  it('trims before measuring, so padding does not pass as a reason', async () => {
    await expect(
      pipe.transform({ reason: '    ' }, declineMeta),
    ).rejects.toThrow();
  });

  it('rejects a missing reason', async () => {
    await expect(pipe.transform({}, declineMeta)).rejects.toThrow();
  });

  it('rejects an empty reason', async () => {
    await expect(pipe.transform({ reason: '' }, declineMeta)).rejects.toThrow();
  });

  it('keeps the trimmed value, so the stored note has no stray padding', async () => {
    const out = (await pipe.transform(
      { reason: '  Vehicle already allocated elsewhere.  ' },
      declineMeta,
    )) as DeclineFacilityDto;
    expect(out.reason).toBe('Vehicle already allocated elsewhere.');
  });
});
