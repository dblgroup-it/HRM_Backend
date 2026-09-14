# Salary `Float` → `Decimal` — the code side

The SQL is the easy half. This is the half that needs a change window.

## 1. Schema

```prisma
model SalaryFixation {
  proposedSalary         Decimal? @map("proposed_salary")          @db.Decimal(12, 2)
  proposedSalaryOverride Decimal? @map("proposed_salary_override") @db.Decimal(12, 2)
}

model Candidate {
  salaryExpectation Decimal? @map("salary_expectation") @db.Decimal(12, 2)
}
```

## 2. What breaks, and where

`Prisma.Decimal` is an object. `number` operations silently stop meaning what
they meant — this is the part that needs care, not the migration.

| Pattern | Where it appears | Becomes |
| --- | --- | --- |
| `a > b`, `a === b` | salary band selection, `fixedSalary()` | `a.greaterThan(b)`, `a.equals(b)` |
| `a + b`, `a * 0.5` | proposed-salary computation | `a.plus(b)`, `a.times(0.5)` |
| `salary.toFixed(0)` | letters, emails, Excel export | `salary.toNumber().toLocaleString()` or `salary.toFixed(0)` (Decimal has its own) |
| `JSON.stringify(salary)` | API responses | serialises as a **string** — decide deliberately and document it for the frontend |
| `Number(dto.salary)` | DTO ingestion | `new Prisma.Decimal(dto.salary)` |

## 3. Files to change

Established by `grep -rn "proposedSalary\|proposedSalaryOverride\|salaryExpectation" src`:

- `src/modules/salary-fixation/salary-fixation.service.ts` — computation, band
  selection, finalize. **The main one.**
- `src/modules/salary-fixation/dto/salary-fixation.dto.ts` — `@IsNumber()` stays
  (the wire format is still a number); convert at the boundary.
- `src/modules/board/board.service.ts` — `fixedSalary()`, the approval email,
  the Excel export, the sheet row.
- `src/modules/onboarding/letters.ts` + `onboarding.service.ts` — the figure
  printed on the offer letter.
- `src/modules/candidates/candidates.service.ts` — `salaryExpectation` on
  create, the candidate serializer, the Excel export.
- Frontend: `salary` fields in `board.types.ts`, `candidate.types.ts` and the
  salary-fixation types become `string` in JSON. Every display site needs
  `Number(...)` before formatting.

## 4. Order of deployment

1. Take a backup (`./scripts/backup-production.sh`).
2. Deploy the code that reads `Decimal` **and** tolerates a `number` — Prisma
   returns a Decimal only after the column type changes, so the code can ship
   first and be inert.
3. Apply the migration.
4. Verify a salary end to end: fix one, preview an offer letter, export a sheet.

## 5. Tests to add first

- A salary of `35000.50` survives save → read → letter → export unchanged.
- Band selection at an exact boundary (the case floating point gets wrong).
- The API response shape for a salary is asserted, so the frontend contract
  change is caught by a test rather than by a user.
