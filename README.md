# DBL HRM — Backend

NestJS + Prisma + PostgreSQL API for the DBL HR Management System.

## Stack

- **NestJS 10** (TypeScript, modular architecture)
- **Prisma 6** + **PostgreSQL**
- **JWT** auth (Passport) with global guard + `@Public()` / `@Roles()`
- **@nestjs/schedule** for the ZingHR daily sync cron
- **class-validator** DTOs, consistent `{ success, data }` response envelope

## Getting started

```bash
npm install
cp .env.example .env          # set DATABASE_URL, JWT_SECRET, ZingHR creds
npm run prisma:generate
npm run prisma:migrate        # creates tables (needs a running Postgres)
npm run db:seed               # admin user + units/seats + sample employees
npm run start:dev             # http://localhost:8000/api
```

**Demo login** (seeded): `admin@dbl-group.com` / `password123`.

## Architecture

```
src/
├── config/                 # env configuration
├── common/                 # guards, decorators, filters, interceptors, dto
├── prisma/                 # PrismaModule + PrismaService (global)
├── health/                 # GET /api/health
└── modules/
    ├── auth/               # POST /auth/login, GET /auth/me  (JWT)
    ├── employees/          # GET /employees, /employees/:id
    ├── units/              # Unit Configuration → drives the organogram
    ├── organogram/         # GET /organogram, /organogram/lookup
    ├── requisition/        # Phase-1 requisition + dynamic sign-off chain
    └── integrations/zinghr # ZingHR employee sync (cron + manual trigger)
```

## Key endpoints

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/login` | `{ identifier, password }` → `{ token, user }` |
| GET | `/api/auth/me` | current user |
| GET | `/api/employees` | paginated, `?search&department&unit` |
| GET | `/api/units` | unit configuration (units → departments → positions) |
| POST | `/api/units` | create unit (ADMIN/HR) |
| POST | `/api/units/:id/departments` | add department |
| POST | `/api/units/departments/:deptId/positions` | upsert sanctioned seat |
| GET | `/api/organogram` | seats with filled/vacant derived from employees |
| GET | `/api/organogram/lookup?unit&department&designation` | New vs Replacement |
| GET/POST | `/api/requisitions` | list / create |
| PATCH | `/api/requisitions/:id/approval` | `{ decision, note }` sign-off |
| POST | `/api/requisitions/:id/role-profile` | generate role profile |
| POST | `/api/requisitions/:id/post` | publish to sources |
| POST | `/api/integrations/zinghr/sync` | manual ZingHR sync (ADMIN/HR) |
| GET | `/api/integrations/zinghr/logs` | recent sync runs |

## ZingHR sync

Mirrors the existing integration: pulls `GetEmployeeMasterDetails`, keeps only
codes starting with `ZINGHR_EMPLOYEE_CODE_PREFIX` (default `151`) and status
`Existing` / `NewJoinee`, then upserts a `User` + `Employee` per record. Units
are auto-created from the ZingHR `unit_name` attribute (so the organogram fills
dynamically). Runs daily on `ZINGHR_SYNC_CRON` (default `36 20 * * *`) and can
be triggered manually via the endpoint above.

## Requisition workflow

The New vs Replacement decision is derived from the **organogram** (vacant
sanctioned seat → replacement, otherwise new). The sign-off chain is built
dynamically:

- Department Head → (Factory HR if factory) → (SBU Head if **new** + factory) → Corporate HR

Each approver may **approve**, **reject**, or **need more info** (which rolls
back to the previous approver). Every action is recorded in the activity log.
