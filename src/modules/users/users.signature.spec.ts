import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ForbiddenException } from '@nestjs/common';

import { UsersService } from './users.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { DriveService } from '../integrations/google/drive.service';
import type { PermissionsService } from '../rbac/permissions.service';
import type { FileGrantService } from '../../common/files/file-grant.service';

/**
 * Who may place an e-signature on whose profile.
 *
 * The rule the business asked for, and the reason it exists: a signature is
 * the person's own mark. HR may put one there for staff who will not do it
 * themselves, but the moment the owner has signed for themselves it stops
 * being HR's to change. These tests exist because that last clause is easy to
 * lose in a refactor and impossible to notice until someone's signature has
 * been overwritten on a letter that has already gone out.
 */
describe('UsersService — e-signature rights', () => {
  const OWNER = 'user-owner';

  function build(opts: { uploadedBy: string | null; actorIsAdmin: boolean }) {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: OWNER,
          name: 'Test Employee',
          employeeCode: '15100000',
          signatureFileId: opts.uploadedBy ? 'file-1' : null,
          signatureUploadedById: opts.uploadedBy,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const drive = {
      isConfigured: () => true,
      ensureFolder: jest.fn().mockResolvedValue('folder-1'),
      uploadFile: jest.fn().mockResolvedValue({ id: 'file-2' }),
      discardFile: jest.fn().mockResolvedValue(undefined),
    } as unknown as DriveService;
    const permissions = {
      isEmployeeAdmin: jest.fn().mockResolvedValue(opts.actorIsAdmin),
    } as unknown as PermissionsService;
    // Signatures are served as signed grants, never an open route.
    const grants = {
      url: jest.fn((fileId: string | null) =>
        fileId ? `/api/files/grant-for-${fileId}` : null,
      ),
    } as unknown as FileGrantService;
    return {
      service: new UsersService(prisma, drive, permissions, grants),
      prisma,
      drive,
    };
  }

  /** A real 900x300 PNG header — the ratio check reads the bytes. */
  const image = () => {
    const b = Buffer.alloc(24);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(0x0d0a1a0a, 4);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(900, 16);
    b.writeUInt32BE(300, 20);
    return {
      originalname: 'signature.png',
      mimetype: 'image/png',
      buffer: b,
      size: b.length,
    };
  };

  it('lets a person upload their own signature', async () => {
    const { service, prisma } = build({
      uploadedBy: null,
      actorIsAdmin: false,
    });
    const out = await service.uploadSignature(OWNER, OWNER, image());
    expect(out.signatureSelfUploaded).toBe(true);
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('lets HR place one for someone who has none', async () => {
    const { service, prisma } = build({
      uploadedBy: null,
      actorIsAdmin: true,
    });
    const out = await service.uploadSignature(OWNER, 'hr-user', image());
    expect(out.signatureSelfUploaded).toBe(false);
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('lets HR replace one that HR placed', async () => {
    const { service } = build({ uploadedBy: 'hr-user', actorIsAdmin: true });
    await expect(
      service.uploadSignature(OWNER, 'another-hr', image()),
    ).resolves.toBeDefined();
  });

  it('REFUSES HR replacing a signature the person uploaded themselves', async () => {
    const { service, prisma, drive } = build({
      uploadedBy: OWNER,
      actorIsAdmin: true,
    });
    await expect(
      service.uploadSignature(OWNER, 'hr-user', image()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Nothing uploaded, nothing written — refused before it touched anything.
    expect(drive.uploadFile).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('REFUSES HR removing a signature the person uploaded themselves', async () => {
    const { service, prisma } = build({
      uploadedBy: OWNER,
      actorIsAdmin: true,
    });
    await expect(
      service.deleteSignature(OWNER, 'hr-user'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('still lets the owner replace their own signature', async () => {
    const { service } = build({ uploadedBy: OWNER, actorIsAdmin: false });
    await expect(
      service.uploadSignature(OWNER, OWNER, image()),
    ).resolves.toBeDefined();
  });

  it('refuses an ordinary colleague outright', async () => {
    const { service } = build({ uploadedBy: null, actorIsAdmin: false });
    await expect(
      service.uploadSignature(OWNER, 'someone-else', image()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses an image that is not about 3:1', async () => {
    const { service } = build({ uploadedBy: null, actorIsAdmin: false });
    const square = image();
    square.buffer.writeUInt32BE(300, 16); // 300x300
    await expect(service.uploadSignature(OWNER, OWNER, square)).rejects.toThrow(
      /3 times as wide/,
    );
  });
});

/**
 * Signatures must never be reachable without a grant.
 *
 * The first version of this feature served them from `GET /users/:id/signature`
 * with `@Public()`, copied from the avatar proxy. An avatar leaking is a
 * privacy nuisance; a signature is forgery material, and user ids appear in
 * ordinary API responses — so "you have to know the id" was never a control.
 *
 * These assertions are deliberately about the source rather than behaviour.
 * The failure mode is someone adding the convenient route back, and no
 * behavioural test would catch that: the new route would simply work.
 */
describe('signature access surface', () => {
  const read = (relative: string) =>
    readFileSync(join(__dirname, relative), 'utf8');

  it('exposes no open route for signature images', () => {
    const controller = read('users.controller.ts');
    expect(controller).not.toMatch(/@Get\(['"`]:userId\/signature/);
  });

  it('keeps the avatar proxy public — the contrast is the point', () => {
    // Avatars legitimately stay open; if this ever fails, the two were
    // conflated again and the reasoning above needs re-reading.
    const controller = read('users.controller.ts');
    expect(controller).toMatch(/@Get\(['"`]:userId\/avatar/);
  });

  it('has no helper that builds a bare signature path', () => {
    // buildSignatureUrl() was deleted rather than left unused: an unsafe path
    // that still exists is one somebody reaches for.
    const util = read('../../common/signature.util.ts');
    expect(util).not.toContain('buildSignatureUrl');
  });

  it('serves signatures through the signed-grant purpose', () => {
    const grant = read('../../common/files/file-grant.service.ts');
    expect(grant).toContain("| 'signature'");
  });
});
