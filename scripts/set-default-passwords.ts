/**
 * Give the shared default password to every account still on its employee code.
 *
 * Until 2026-10-30 an account nobody had chosen a password for — every user
 * the ZingHR sync created, and every reset from Access Control — signed in
 * with its employee code. The owner replaced that with one shared default,
 * `DEFAULT_USER_PASSWORD` in the server's .env (`auth/default-password.ts`).
 * New accounts and resets get it from the code; this moves the existing ones.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/set-default-passwords.ts                  # dry run (default)
 *   npx ts-node -r tsconfig-paths/register scripts/set-default-passwords.ts --execute        # write
 *   npx ts-node -r tsconfig-paths/register scripts/set-default-passwords.ts --only 15106254  # one account
 *
 * An account is moved only if its password still IS its employee code —
 * checked against its stored hash — so anyone who chose their own password is
 * left alone, and a second run finds nothing to do. Each account moved:
 *   - gets the shared default (with its own salt) and must change it at its
 *     next sign-in (`mustChangePassword`), owner's decision;
 *   - is signed out everywhere (`tokenVersion`): the password its sessions
 *     were opened with no longer works, and a session left open would hit the
 *     change-password lock on its next click instead.
 * Nothing else — not status, roles, two-factor or email. Only ACTIVE accounts.
 *
 * Only counts and employee codes are printed — no names.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { sharedDefaultPassword } from '../src/modules/auth/default-password';

const EXECUTE = process.argv.includes('--execute');
const onlyAt = process.argv.indexOf('--only');
const ONLY = onlyAt > -1 ? process.argv[onlyAt + 1] : undefined;
// Constructing the client loads .env, which is where the default lives.
const prisma = new PrismaClient();

// As the ZingHR sync: a default password, thousands of rows.
const SALT_ROUNDS = 8;
const PROGRESS_EVERY = 500;

async function main(): Promise<void> {
  const shared = sharedDefaultPassword();
  if (!shared) {
    throw new Error(
      'DEFAULT_USER_PASSWORD is not set in .env — there is no default to give',
    );
  }
  if (shared.length < 6 || Buffer.byteLength(shared, 'utf8') > 72) {
    throw new Error(
      'DEFAULT_USER_PASSWORD must be at least 6 characters and at most 72 bytes',
    );
  }
  if (onlyAt > -1 && !ONLY) throw new Error('--only needs an employee code');

  const users = await prisma.user.findMany({
    where: { status: 'ACTIVE', ...(ONLY ? { employeeCode: ONLY } : {}) },
    select: {
      id: true,
      employeeCode: true,
      passwordHash: true,
      role: true,
      _count: { select: { roleAssignments: true } },
    },
    orderBy: { employeeCode: 'asc' },
  });
  if (ONLY && users.length === 0) {
    throw new Error(`No active account with employee code ${ONLY}`);
  }

  console.log(`Checking ${users.length} active account(s)…`);
  const onCode: typeof users = [];
  for (const [i, u] of users.entries()) {
    if (await bcrypt.compare(u.employeeCode, u.passwordHash)) onCode.push(u);
    if ((i + 1) % PROGRESS_EVERY === 0) {
      console.log(`  checked ${i + 1} / ${users.length}`);
    }
  }
  // The sign-in gate lets in the ADMIN login and anyone holding a role; the
  // rest cannot sign in today, but will meet the default if given a role.
  const canSignIn = onCode.filter(
    (u) => u.role === 'ADMIN' || u._count.roleAssignments > 0,
  );

  console.log('');
  console.log(`Active accounts checked:         ${users.length}`);
  console.log(
    `Chose their own password:        ${users.length - onCode.length}`,
  );
  console.log(`Still on their employee code:    ${onCode.length}`);
  console.log(`  of whom can sign in today:     ${canSignIn.length}`);
  if (canSignIn.length) {
    console.log(
      `  (tell them the new password): ${canSignIn.map((u) => u.employeeCode).join(', ')}`,
    );
  }

  // Not this script's to change, but worth saying out loud: the default is
  // told to everyone, so an ADMIN login holding it is a super user anyone can
  // sign in as.
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', status: 'ACTIVE' },
    select: { employeeCode: true, email: true, passwordHash: true },
  });
  for (const a of admins) {
    if (await bcrypt.compare(shared, a.passwordHash)) {
      console.log('');
      console.log(
        `WARNING: the ADMIN login ${a.email ?? a.employeeCode} uses the default password itself.`,
      );
      console.log(
        '         Anyone told the default can sign in as a super user. Change it in Settings › Security.',
      );
    }
  }

  console.log('');
  if (!EXECUTE) {
    console.log('Dry run — nothing written. Re-run with --execute to apply.');
    return;
  }

  let moved = 0;
  let changedMeanwhile = 0;
  for (const [i, u] of onCode.entries()) {
    // Matching on the hash read above: someone who changed their password
    // since then keeps it.
    const { count } = await prisma.user.updateMany({
      where: { id: u.id, passwordHash: u.passwordHash },
      data: {
        passwordHash: await bcrypt.hash(shared, SALT_ROUNDS),
        mustChangePassword: true,
        tokenVersion: { increment: 1 },
      },
    });
    if (count) moved++;
    else changedMeanwhile++;
    if ((i + 1) % PROGRESS_EVERY === 0) {
      console.log(`  written ${i + 1} / ${onCode.length}`);
    }
  }

  if (moved) {
    await prisma.auditLog.create({
      data: {
        actorName: 'System',
        actorType: 'system',
        action: 'default_password_applied',
        entity: 'User',
        ...(ONLY && users[0]
          ? { entityId: users[0].id, entityLabel: ONLY }
          : {}),
        summary: `Shared default password given to ${moved} account(s) still on their employee code; each must change it at next sign-in`,
        source: 'system',
      },
    });
  }

  console.log(`Moved to the default password:   ${moved}`);
  if (changedMeanwhile) {
    console.log(
      `Changed their password meanwhile: ${changedMeanwhile} (left alone)`,
    );
  }
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
