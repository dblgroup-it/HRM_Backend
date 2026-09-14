import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { OnboardingService, isMedicalDoc } from './onboarding.service';

/**
 * Medical access, tested at the service boundary.
 *
 * These call the real `OnboardingService` with a fake Prisma; nothing stubs the
 * authorization check itself, so a regression that widens who sees clinical
 * data fails here rather than passing a mocked gate.
 */
describe('OnboardingService — medical data', () => {
  const CLINICAL = {
    id: 'exam-1',
    onboardingId: 'ob-1',
    dateOfBirth: new Date('1990-01-01'),
    hepatitisBNegative: true,
    liverFunctionNormal: true,
    urineTestClear: true,
    pastIllnessHistory: 'Asthma in childhood',
    familyHistoryDmHtn: true,
    familyHistoryDetail: 'Father, type 2 diabetes',
    bloodGroup: 'B+',
    bloodPressure: '120/80',
    fitToJoin: true,
    examDate: new Date('2026-09-01'),
    issueDate: new Date('2026-09-02'),
    refNo: 'DBL/Corp/HR/MT-001/26',
    consultantName: 'Dr Example',
    remarks: 'Cleared',
  } as never;

  function build(opts: {
    medicalRole: boolean;
    superUser?: boolean;
    recruitmentAllowed?: boolean;
    doc?: { label: string; fileId: string } | null;
  }) {
    const prisma = {
      onboarding: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ob-1',
          candidate: {
            id: 'c1',
            requisition: { unitFactory: 'Unit A', recruiterId: null },
          },
        }),
      },
      medicalExam: { findUnique: jest.fn().mockResolvedValue(CLINICAL) },
      roleAssignment: {
        findFirst: jest
          .fn()
          .mockResolvedValue(opts.medicalRole ? { id: 'ra' } : null),
      },
      onboardingDoc: {
        findUnique: jest.fn().mockResolvedValue(
          opts.doc
            ? {
                id: 'doc-1',
                label: opts.doc.label,
                fileId: opts.doc.fileId,
                onboarding: {
                  id: 'ob-1',
                  candidate: {
                    requisition: { unitFactory: 'Unit A', recruiterId: null },
                  },
                },
              }
            : null,
        ),
        findFirst: jest
          .fn()
          .mockResolvedValue(
            opts.doc
              ? { id: 'doc-1', label: opts.doc.label, fileId: opts.doc.fileId }
              : null,
          ),
      },
    };
    const permissions = {
      isSuperUser: jest.fn().mockResolvedValue(Boolean(opts.superUser)),
      requireRecruitmentAccess: jest.fn().mockImplementation(() => {
        if (opts.recruitmentAllowed === false) {
          return Promise.reject(
            new ForbiddenException('no recruitment access'),
          );
        }
        return Promise.resolve();
      }),
    };
    const secureFiles = { stream: jest.fn().mockResolvedValue(undefined) };

    const svc = Object.create(OnboardingService.prototype) as OnboardingService;
    Object.assign(svc, {
      prisma,
      permissions,
      secureFiles,
      files: { url: () => '/api/files/grant' },
    });
    return { svc, prisma, permissions, secureFiles };
  }

  describe('getMedicalExam', () => {
    it('gives a medical officer the full clinical record', async () => {
      const { svc } = build({ medicalRole: true });
      const out = (await svc.getMedicalExam('ob-1', 'medic')) as Record<
        string,
        unknown
      >;
      expect(out.hepatitisBNegative).toBe(true);
      expect(out.pastIllnessHistory).toBe('Asthma in childhood');
      expect(out.redacted).toBeUndefined();
    });

    it('gives an ordinary recruitment user a summary only', async () => {
      const { svc } = build({ medicalRole: false, recruitmentAllowed: true });
      const out = (await svc.getMedicalExam('ob-1', 'recruiter')) as Record<
        string,
        unknown
      >;

      expect(out.fitToJoin).toBe(true);
      expect(out.redacted).toBe(true);

      for (const clinical of [
        'hepatitisBNegative',
        'liverFunctionNormal',
        'urineTestClear',
        'pastIllnessHistory',
        'familyHistoryDmHtn',
        'familyHistoryDetail',
        'bloodGroup',
        'bloodPressure',
        'dateOfBirth',
        'remarks',
      ]) {
        expect(out).not.toHaveProperty(clinical);
      }
      // Nothing clinical leaks through the serialized payload either.
      expect(JSON.stringify(out)).not.toContain('Asthma');
      expect(JSON.stringify(out)).not.toContain('type 2 diabetes');
    });

    it('refuses a user with neither medical nor recruitment access', async () => {
      const { svc } = build({ medicalRole: false, recruitmentAllowed: false });
      await expect(
        svc.getMedicalExam('ob-1', 'stranger'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('document streaming', () => {
    it('refuses a recruitment user the medical report file', async () => {
      const { svc, secureFiles } = build({
        medicalRole: false,
        recruitmentAllowed: true,
        doc: { label: 'Medical Fitness Report', fileId: 'f-med' },
      });
      await expect(
        svc.streamDoc('doc-1', 'recruiter', {} as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(secureFiles.stream).not.toHaveBeenCalled();
    });

    it('lets a medical officer stream the medical report', async () => {
      const { svc, secureFiles } = build({
        medicalRole: true,
        doc: { label: 'Medical Fitness Report', fileId: 'f-med' },
      });
      await svc.streamDoc('doc-1', 'medic', {} as never);
      expect(secureFiles.stream).toHaveBeenCalledWith(
        {},
        'f-med',
        expect.objectContaining({ filename: 'Medical Fitness Report' }),
      );
    });

    it('lets a recruitment user stream an ordinary joining document', async () => {
      const { svc, secureFiles } = build({
        medicalRole: false,
        recruitmentAllowed: true,
        doc: { label: 'National ID', fileId: 'f-nid' },
      });
      await svc.streamDoc('doc-1', 'recruiter', {} as never);
      expect(secureFiles.stream).toHaveBeenCalled();
    });

    it('refuses an unrelated user any joining document', async () => {
      const { svc, secureFiles } = build({
        medicalRole: false,
        recruitmentAllowed: false,
        doc: { label: 'National ID', fileId: 'f-nid' },
      });
      await expect(
        svc.streamDoc('doc-1', 'stranger', {} as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(secureFiles.stream).not.toHaveBeenCalled();
    });

    it('refuses the medical report endpoint to a non-medical user', async () => {
      const { svc } = build({
        medicalRole: false,
        recruitmentAllowed: true,
        doc: { label: 'Medical Fitness Report', fileId: 'f-med' },
      });
      await expect(
        svc.streamMedicalReport('ob-1', 'recruiter', {} as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s rather than 500s when no report has been uploaded', async () => {
      const { svc } = build({ medicalRole: true, doc: null });
      await expect(
        svc.streamMedicalReport('ob-1', 'medic', {} as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('isMedicalDoc', () => {
    it.each([
      'Medical Fitness Report',
      'Medical Fitness Report — scan.pdf',
      'Health Check',
      'Blood Test',
      'Pathology result',
    ])('treats "%s" as clinical', (label) => {
      expect(isMedicalDoc(label)).toBe(true);
    });

    it.each([
      'National ID',
      'SSC Certificate',
      'Passport Photo',
      'Offer Letter',
    ])('treats "%s" as ordinary', (label) => {
      expect(isMedicalDoc(label)).toBe(false);
    });
  });
});
