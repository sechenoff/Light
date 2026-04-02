# Project Health Report
<!-- updated-by-superflow:2026-04-02 -->

## Overview
- **Stack:** Node.js + TypeScript (ES2022) — Express 4, Prisma 6.19 (SQLite), Next.js 14, Telegraf 4
- **AI:** Google Gemini (`@google/generative-ai`) in API, OpenAI GPT-4o-mini in Bot
- **Queue:** BullMQ + ioredis (async photo analysis)
- **Size:** 89 source files, ~18,400 LOC across 3 apps (api, web, bot) + 1 empty package (db)
- **Tests:** 1 test file / 85 source files (1.2%). Only `crewCalculator.test.ts` (209 lines, vitest)
- **Node.js:** v20.20.1, npm workspaces monorepo

## Large Files (>500 LOC) -- Refactoring Candidates
| File | LOC | Role | Recommendation |
|------|-----|------|----------------|
| `apps/web/app/bookings/new/page.tsx` | 1,621 | Booking creation + gaffer AI + estimate preview | Split into sub-components |
| `apps/bot/src/scenes/booking.ts` | 1,247 | Entire booking flow as single Telegraf scene | Extract step handlers |
| `apps/api/src/services/equipmentMatcher.ts` | 1,092 | Fuzzy matching + ~400 lines hardcoded aliases | Extract alias map to DB |
| `apps/web/app/admin/page.tsx` | 1,024 | Admin dashboard (slang learning + settings) | Split panels |
| `apps/web/app/finance/page.tsx` | 905 | Finance dashboard with payments/expenses/export | Split tabs |
| `apps/web/app/bookings/[id]/edit/page.tsx` | 687 | Booking edit form | Extract form sections |
| `apps/web/app/equipment/manage/page.tsx` | 670 | Equipment CRUD management | Extract modals |
| `apps/web/app/crew-calculator/page.tsx` | 647 | Crew cost calculator | Extract tier logic |
| `apps/api/src/routes/bookings.ts` | 617 | Booking route handler | Move logic to service |
| `apps/api/src/routes/finance.ts` | 544 | Finance routes with inline Prisma calls | Extract to service |

## Architecture Violations
| Violation | File:Line | Details |
|-----------|-----------|---------|
| Transport coupling in service | `services/smetaExport/renderXlsx.ts:1` | `import type { Response } from "express"` — service takes Express Response directly |
| Transport coupling in service | `services/smetaExport/renderPdf.ts:3` | Same — PDF rendering coupled to Express |
| Business logic in route | `routes/bookingRequestParser.ts:4-181` | AI prompts, retry logic, JSON repair inline in route handler |
| Direct Prisma in route (no service) | `routes/equipment.ts` | 8 direct `prisma.equipment.*` calls |
| Direct Prisma in route (no service) | `routes/finance.ts` | 18+ direct `prisma.*` calls |
| Direct Prisma in route (no service) | `routes/slangLearning.ts` | 10 direct `prisma.*` calls |
| Code duplication across apps | `bot/lib/crewRates.ts` = `web/lib/crewRates.ts` | Identical 73-line files, manually synced |
| Code duplication across apps | `bot/lib/crewCalculator.ts` = `web/lib/crewCalculator.ts` | Identical calculation logic |
| Code duplication across apps | `api/utils/dates.ts` = `web/lib/rentalTime.ts` | Identical rental duration functions |
| Dead shared package | `packages/db/` | Empty directory — never populated |

## Technical Debt (Prioritized)
| Priority | Issue | Location | Evidence | Recommendation |
|----------|-------|----------|----------|----------------|
| P0 | Zero authentication on API | `app.ts:55` | No auth middleware — 40+ endpoints publicly accessible | Add API key / JWT auth |
| P0 | Hardcoded admin password in client code | `admin/page.tsx:10`, `finance/page.tsx:162` | `ADMIN_PASSWORD = "4020909Bear"` visible in bundle | Server-side auth |
| P0 | No DB backup strategy | — | Zero backup scripts or cron jobs for SQLite prod.db | Add automated backup |
| P1 | Test coverage 1.2% | 1/85 files tested | Only crewCalculator.test.ts exists | Add tests for critical paths |
| P1 | CORS defaults to allow-all | `app.ts:32-33` | `corsOrigin = true` when env unset | Require explicit CORS_ORIGIN |
| P1 | No CI quality gates | `deploy.yml` | No lint/test/typecheck before deploy | Add CI checks |
| P1 | `prisma db push --accept-data-loss` in prod | `deploy.sh:55` | Can silently drop columns | Use `prisma migrate deploy` |
| P1 | 11 npm audit vulnerabilities (9 HIGH) | `package-lock.json` | next, path-to-regexp, xlsx, prisma | `npm audit fix` |
| P2 | No rate limiting | `app.ts` | Zero rate-limit middleware | Add express-rate-limit on AI endpoints |
| P2 | dev.db tracked by git | `prisma/dev.db` | SQLite with data in git history | `git rm --cached`, add to .gitignore |
| P2 | .env.production not gitignored | `apps/api/.env.production` | One `git add -A` from credential leak | Add to .gitignore |
| P2 | 17 `as any` casts | 5 files | Type safety bypassed | Fix Prisma Decimal types |
| P2 | 7 unused exports | `dates.ts`, `api.ts`, `llm.ts` | Dead code never imported | Remove |
| P3 | Ghost `apps/prod-bot` reference | `deploy.sh:67` | Directory deleted, script still references it | Clean up deploy.sh |
| P3 | No eslint config files | `apps/api/`, `apps/web/` | eslint in devDeps but no config — lint scripts would fail | Add configs |

## DevOps & Infrastructure
- **Docker:** None — no Dockerfile, no docker-compose. Services run on bare VPS via PM2
- **CI/CD:** GitHub Actions (`deploy.yml`) — SSH deploy on push to main. No tests, no build verification, no staging
- **Deploy:** `deploy.sh` — runs prisma db push + tsc + pm2 reload. No rollback. No health checks
- **Security scanning:** None — no Dependabot, no Renovate, no CodeQL, no npm audit in CI
- **Backups:** None detected — SQLite prod.db with zero backup automation

## Documentation Freshness
| Doc | Last Updated | Status |
|-----|-------------|--------|
| README.md | — | **missing** |
| CLAUDE.md | — | **missing** |
| llms.txt | — | **missing** |
| `docs/DATA_MODEL_SMETA.md` | 2026-03-25 | stale (covers ~20% of 17 models, never updated after 48 commits) |
| `apps/api/.env.example` | 2026-03-31 | current |
| `apps/bot/.env.example` | 2026-03-31 | current |
| `apps/web/.env.example` | — | **missing** |
| API documentation | — | **missing** (no Swagger/OpenAPI, 14 route files undocumented) |

## Security Issues
| Severity | Issue | Location | Evidence |
|----------|-------|----------|----------|
| CRITICAL | Live Gemini API key in .env | `apps/api/.env:14` | `AIzaSyCcuypIka_00t...` |
| CRITICAL | Live OpenAI key + Telegram token in .env | `apps/bot/.env:1-2` | `sk-proj-2XaI6u...`, `8591446512:AAEj...` |
| CRITICAL | Zero authentication on all API endpoints | `apps/api/src/app.ts:55` | No auth middleware anywhere |
| CRITICAL | Hardcoded password in client JS | `admin/page.tsx:10` | `"4020909Bear"` in browser bundle |
| HIGH | .env.production not gitignored | `.gitignore` | Missing entry for `*.env.production` |
| HIGH | dev.db tracked by git (contains data) | `prisma/dev.db` | `git ls-files` confirms tracked |
| HIGH | CORS allows all origins by default | `app.ts:32` | `corsOrigin = true` when unset |
| HIGH | SSRF via Next.js API proxy | `app/api/[...path]/route.ts:33` | Path segments from URL concatenated |
| HIGH | 9 HIGH npm audit vulnerabilities | `package-lock.json` | next, path-to-regexp, picomatch, xlsx |
| HIGH | `--accept-data-loss` in production deploy | `deploy.sh:55` | Can drop columns silently |
| HIGH | No build/test verification in CI | `deploy.yml` | Pushes deploy on any main commit |
| HIGH | No rollback procedure | `deploy.sh` | No automated recovery path |
| MEDIUM | Path traversal risk in pricelist upload | `routes/pricelist.ts:73` | Extension from client input |
| MEDIUM | Path traversal risk in storage read | `services/storage.ts:110` | No base-dir validation |
| MEDIUM | Error messages leak details | `app.ts:88` | Raw errors in non-production |
| MEDIUM | No rate limiting on any endpoint | `app.ts` | Zero rate-limit middleware |
| MEDIUM | SQLite in production (no write concurrency) | `schema.prisma:5` | Database-level write locking |
| MEDIUM | Webhook secret defaults to empty | `bot/index.ts:126` | Accepts fake Telegram updates |
| MEDIUM | AI endpoints have no cost controls | `bookingRequestParser.ts:11` | Unauthenticated Gemini calls |
| LOW | Helmet CORP set to cross-origin | `app.ts:24` | Allows any site to load resources |
| LOW | Gemini responses logged with content | `gemini.ts:226` | AI data in PM2 logs |
| LOW | No CSRF protection | `app.ts` | State-changing endpoints unprotected |
