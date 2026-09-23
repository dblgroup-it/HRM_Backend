import { ForbiddenException } from '@nestjs/common';

import { OnboardingService } from './onboarding.service';

/**
 * The medical test goes recruiter → Head of Talent Acquisition → out.
 *
 * The recruiter asks (test list, salutation, reference) and nothing is
 * emailed; only Head of Talent Acquisition, or a super user, sends the letter,
 * each candidate on their own. Tested against the real service with a fake
 * Prisma, so the gate itself is what is exercised, not a mock of it.
 */
describe('OnboardingService: medical request routing', () => {
  function build(opts: { holdsCorporateHr: boolean; superUser?: boolean }) {
    const ob = {
      id: 'ob-1',
      candidateId: 'c1',
      medicalStatus: 'pending',
      medicalRefNo: null,
      medicalSalutation: null,
      medicalAgeBand: null,
      medicalRequestedById: 'recruiter',
      candidate: {
        id: 'c1',
        name: 'Rahim Uddin',
        email: 'rahim@example.com',
        requisitionId: 'r1',
        requisition: { unitFactory: 'Unit A', designation: 'Executive', recruiterId: 'recruiter' },
      },
    };
    const prisma = {
      onboarding: {
        findUnique: jest.fn().mockResolvedValue(ob),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(ob),
      },
      roleAssignment: {
        findFirst: jest
          .fn()
          .mockResolvedValue(opts.holdsCorporateHr ? { id: 'ra' } : null),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const permissions = {
      isSuperUser: jest.fn().mockResolvedValue(Boolean(opts.superUser)),
      requireRecruitmentAccess: jest.fn().mockResolvedValue(undefined),
      roleHolders: jest.fn().mockResolvedValue([{ id: 'hota', name: 'HoTA' }]),
    };
    const notifications = {
      notify: jest.fn().mockResolvedValue(undefined),
      broadcastChange: jest.fn(),
    };
    const mail = { isConfigured: () => true, send: jest.fn() };

    const svc = Object.create(OnboardingService.prototype) as OnboardingService;
    Object.assign(svc, {
      prisma,
      permissions,
      notifications,
      mail,
      logger: { warn: jest.fn() },
    });
    return { svc, prisma, permissions, notifications, mail };
  }

  it('a recruiter request is parked for HoTA, and nothing is emailed', async () => {
    const { svc, prisma, notifications, mail } = build({ holdsCorporateHr: false });
    await svc.requestMedicalTest('ob-1', 'recruiter', {
      band: 'above_40',
      salutation: 'Mr.',
      refNo: 'DBL/Corp/HR/MT - 12/26',
    });

    const data = prisma.onboarding.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      medicalAgeBand: 'above_40',
      medicalSalutation: 'Mr.',
      medicalRefNo: 'DBL/Corp/HR/MT - 12/26',
      medicalRequestPending: true,
      medicalRequestedById: 'recruiter',
    });
    expect(mail.send).not.toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith(
      'hota',
      expect.objectContaining({ link: '/medical-requests' }),
    );
  });

  it('refuses the direct send to anybody who is not HoTA', async () => {
    const { svc, mail } = build({ holdsCorporateHr: false });
    await expect(
      svc.sendMedicalTestLetter('ob-1', 'recruiter', {
        band: 'below_40',
        examAt: '2026-10-01T04:30:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('refuses the batch send and the inbox to anybody who is not HoTA', async () => {
    const { svc } = build({ holdsCorporateHr: false });
    await expect(svc.medicalRequestInbox('recruiter')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      svc.sendMedicalRequests('recruiter', {
        items: [{ onboardingId: 'ob-1', examAt: '2026-10-01T04:30:00.000Z' }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets HoTA and a super user into the inbox', async () => {
    await expect(
      build({ holdsCorporateHr: true }).svc.medicalRequestInbox('hota'),
    ).resolves.toEqual([]);
    await expect(
      build({ holdsCorporateHr: false, superUser: true }).svc.medicalRequestInbox('su'),
    ).resolves.toEqual([]);
  });
});
