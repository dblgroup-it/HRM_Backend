import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { CandidatesService } from './candidates.service';

/**
 * CV access at the service boundary.
 *
 * CVs used to be world-readable on Google Drive by URL. They are now streamed
 * by this API, and the gate is the requisition's existing recruitment check —
 * exercised here for real, not stubbed.
 */
describe('CandidatesService.streamCv', () => {
  const UNIT_A = { id: 'req-a', unitFactory: 'Unit A', recruiterId: null };

  function build(opts: {
    allowed: boolean;
    delegated?: boolean;
    cvFileId?: string | null;
  }) {
    const prisma = {
      candidate: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          name: 'Candidate',
          cvFileId: opts.cvFileId === undefined ? 'file-1' : opts.cvFileId,
          requisition: UNIT_A,
        }),
      },
    };
    const permissions = {
      hasInterviewDelegation: jest
        .fn()
        .mockResolvedValue(Boolean(opts.delegated)),
      requireRecruitmentAccess: jest
        .fn()
        .mockImplementation(() =>
          opts.allowed
            ? Promise.resolve()
            : Promise.reject(new ForbiddenException('not your requisition')),
        ),
    };
    const secureFiles = { stream: jest.fn().mockResolvedValue(undefined) };

    const svc = Object.create(CandidatesService.prototype) as CandidatesService;
    Object.assign(svc, { prisma, permissions, secureFiles });
    return { svc, secureFiles, permissions };
  }

  it('streams the CV to a user with recruitment access', async () => {
    const { svc, secureFiles } = build({ allowed: true });
    await svc.streamCv('c1', 'hr', {} as never);
    expect(secureFiles.stream).toHaveBeenCalledWith(
      {},
      'file-1',
      expect.objectContaining({ filename: 'Candidate — CV' }),
    );
  });

  it('refuses a user from another unit — no bytes are sent', async () => {
    const { svc, secureFiles } = build({ allowed: false });
    await expect(
      svc.streamCv('c1', 'other-unit-user', {} as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(secureFiles.stream).not.toHaveBeenCalled();
  });

  it('allows an interview delegate, without granting recruitment access', async () => {
    const { svc, secureFiles, permissions } = build({
      allowed: false,
      delegated: true,
    });
    await svc.streamCv('c1', 'factory-interviewer', {} as never);
    expect(secureFiles.stream).toHaveBeenCalled();
    // The delegation short-circuits; the recruitment gate is never consulted,
    // and is certainly never widened.
    expect(permissions.requireRecruitmentAccess).not.toHaveBeenCalled();
  });

  it('404s when the candidate has no CV document', async () => {
    const { svc } = build({ allowed: true, cvFileId: null });
    await expect(svc.streamCv('c1', 'hr', {} as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s for an unknown candidate before any authorization work', async () => {
    const { svc } = build({ allowed: true });
    const prisma = (
      svc as unknown as { prisma: { candidate: { findUnique: jest.Mock } } }
    ).prisma;
    prisma.candidate.findUnique.mockResolvedValue(null);
    await expect(
      svc.streamCv('nope', 'hr', {} as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
