import { PrismaClient, SeatCategory } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

interface SeatSeed {
  designation: string;
  sanctioned: number;
  filled?: number;
  category?: SeatCategory;
}
interface DeptSeed {
  name: string;
  seats: SeatSeed[];
}
interface UnitSeed {
  name: string;
  departments: DeptSeed[];
}

const UNITS: UnitSeed[] = [
  {
    name: 'Jinnat Textile Mills Ltd.',
    departments: [
      {
        name: 'Production & QC',
        seats: [
          { designation: 'Assistant Production Officer', sanctioned: 6, filled: 3 },
          { designation: 'Production Officer', sanctioned: 6, filled: 6 },
          { designation: 'Senior Officer - Production', sanctioned: 4, filled: 4 },
          { designation: 'Machine Operator', sanctioned: 159, filled: 156, category: 'WORKER' },
        ],
      },
      {
        name: 'Quality',
        seats: [
          { designation: 'Quality Officer', sanctioned: 4, filled: 4 },
          { designation: 'Quality Assistant Manager', sanctioned: 2, filled: 1 },
        ],
      },
      {
        name: 'Maintenance',
        seats: [{ designation: 'Maintenance Engineer', sanctioned: 3 }],
      },
      {
        name: 'Human Resources',
        seats: [{ designation: 'HR Officer', sanctioned: 3 }],
      },
      {
        name: 'IT & Systems',
        seats: [{ designation: 'IT Officer', sanctioned: 2 }],
      },
    ],
  },
  {
    name: 'Jinnat Apparels Ltd',
    departments: [
      {
        name: 'Merchandising',
        seats: [
          { designation: 'Senior Merchandiser', sanctioned: 4 },
          { designation: 'Merchandiser', sanctioned: 8 },
        ],
      },
    ],
  },
  {
    name: 'DBL Group — Head Office',
    departments: [
      {
        name: 'Human Resources',
        seats: [{ designation: 'HR Business Partner', sanctioned: 4 }],
      },
      {
        name: 'Finance & Accounts',
        seats: [{ designation: 'Financial Analyst', sanctioned: 3 }],
      },
    ],
  },
];

// A few employees so organogram "filled" counts are meaningful.
const EMPLOYEES = [
  { code: '151001', name: 'Tanvir Ahmed', unit: 'Jinnat Textile Mills Ltd.', dept: 'Production & QC', designation: 'Assistant Production Officer' },
  { code: '151002', name: 'Nusrat Jahan', unit: 'Jinnat Textile Mills Ltd.', dept: 'Production & QC', designation: 'Assistant Production Officer' },
  { code: '151003', name: 'Rafiul Islam', unit: 'Jinnat Textile Mills Ltd.', dept: 'Production & QC', designation: 'Assistant Production Officer' },
  { code: '151004', name: 'Sabbir Khan', unit: 'Jinnat Textile Mills Ltd.', dept: 'Quality', designation: 'Quality Officer' },
];

async function main() {
  console.log('Seeding…');

  // Admin (matches the frontend demo login).
  const adminPass = await bcrypt.hash('password123', 10);
  await prisma.user.upsert({
    where: { employeeCode: 'ADMIN-001' },
    update: {},
    create: {
      employeeCode: 'ADMIN-001',
      name: 'Ayesha Rahman',
      email: 'admin@dbl-group.com',
      passwordHash: adminPass,
      role: 'ADMIN',
    },
  });

  // Access-control roles (dynamic, but seed the standard ones).
  const ROLES = [
    { key: 'super_user', name: 'Super User', scope: 'GLOBAL', description: 'Full system access.' },
    { key: 'chro', name: 'CHRO', scope: 'GLOBAL', description: 'Chief Human Resources Officer.' },
    { key: 'corporate_hr', name: 'Corporate HR', scope: 'GLOBAL', description: 'Corporate HR — final approver.' },
    { key: 'requisition_raiser', name: 'Requisition Raiser', scope: 'UNIT', description: 'Opens requisitions for their unit. Not an approval step — the sign-off chain is configured per unit in Approval Paths.' },
    { key: 'unit_approver', name: 'Unit Approver', scope: 'UNIT', description: 'Can be named as an approval level for their unit. Grants sign-in and visibility of that unit’s requisitions — nothing else.' },
    { key: 'sbu_head', name: 'SBU Head', scope: 'UNIT', description: 'Strategic Business Unit head.' },
    { key: 'medical_officer', name: 'Medical Officer', scope: 'GLOBAL', description: 'Records onboarding medical clearance (all units).' },
    { key: 'corporate_recruiter', name: 'Corporate Recruiter', scope: 'GLOBAL', description: 'Runs a requisition’s hiring lifecycle once Corporate HR assigns it to them.' },
  ] as const;
  for (const r of ROLES) {
    await prisma.role.upsert({
      where: { key: r.key },
      // `isSystem` is set on update too: a role first created by hand in
      // Access Control (and only later added here) would otherwise stay
      // deletable, even though the workflow now depends on it existing.
      update: {
        name: r.name,
        scope: r.scope,
        description: r.description,
        isSystem: true,
      },
      create: { ...r, isSystem: true },
    });
  }

  // Units → departments → positions.
  for (const unit of UNITS) {
    const createdUnit = await prisma.unit.upsert({
      where: { name: unit.name },
      update: {},
      create: { name: unit.name },
    });

    for (const dept of unit.departments) {
      const createdDept = await prisma.department.upsert({
        where: { unitId_name: { unitId: createdUnit.id, name: dept.name } },
        update: {},
        create: { unitId: createdUnit.id, name: dept.name },
      });

      for (const seat of dept.seats) {
        await prisma.position.upsert({
          where: {
            unitId_departmentId_designation: {
              unitId: createdUnit.id,
              departmentId: createdDept.id,
              designation: seat.designation,
            },
          },
          update: { sanctioned: seat.sanctioned, filled: seat.filled ?? 0 },
          create: {
            unitId: createdUnit.id,
            departmentId: createdDept.id,
            designation: seat.designation,
            category: seat.category ?? 'OFFICER',
            sanctioned: seat.sanctioned,
            filled: seat.filled ?? 0,
          },
        });
      }
    }
  }

  // Employees.
  for (const emp of EMPLOYEES) {
    const unit = await prisma.unit.findUnique({ where: { name: emp.unit } });
    const pass = await bcrypt.hash(emp.code, 10);
    const user = await prisma.user.upsert({
      where: { employeeCode: emp.code },
      update: { name: emp.name },
      create: {
        employeeCode: emp.code,
        name: emp.name,
        passwordHash: pass,
        role: 'MANAGEMENT',
      },
    });
    await prisma.employee.upsert({
      where: { userId: user.id },
      update: {
        designation: emp.designation,
        department: emp.dept,
        unitName: emp.unit,
        unitId: unit?.id,
        source: 'MANUAL',
      },
      create: {
        userId: user.id,
        employeeCode: emp.code,
        designation: emp.designation,
        department: emp.dept,
        unitName: emp.unit,
        unitId: unit?.id,
        source: 'MANUAL',
      },
    });
  }

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
