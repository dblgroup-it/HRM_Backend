/**
 * The password an account is given when nobody has chosen one for it: a new
 * user from the ZingHR sync, or a super user's reset from Access Control.
 *
 * `DEFAULT_USER_PASSWORD` in the server's .env (owner's decision, 2026-10-30).
 * Unset, it is the employee code, as it always was. It is kept out of the repo
 * on purpose — a password committed to git stays in its history for good.
 *
 * Either way it is a password other people know, so every account given it
 * must change it at its next sign-in (`mustChangePassword`), and
 * `assertPasswordPolicy` refuses it as anyone's own choice.
 *
 * Read at call time, like the password-length limits, so a changed .env needs
 * only a restart, and so `scripts/set-default-passwords.ts` — which runs
 * outside Nest — reads the same value.
 */
export function sharedDefaultPassword(): string | null {
  const pw = (process.env.DEFAULT_USER_PASSWORD ?? '').trim();
  return pw || null;
}

/** What `employeeCode`'s account is set to when it is given the default. */
export function defaultPasswordFor(employeeCode: string): string {
  return sharedDefaultPassword() ?? employeeCode;
}
