# Gaffer CRM canon-parity audit — Sprint 2 Wave A

**Date:** 2026-04-20
**Method:** Playwright Chromium (headless, local) — 9 routes × 3 widths (390/768/1280) + auxiliary mockup files.
**Script:** `scripts/canon-audit/run.mjs` (not committed; in-worktree only).
**Dev server:** localhost:3000 (Next.js), API localhost:4000.
**Login:** POST `/api/gaffer/auth/login` for `audit@example.com` (pre-seeded via `scripts/canon-audit/seed-gaffer.mjs`).
**Artifacts:** 75 PNGs in this folder.

## Severity

- **P0** — breaks design intent (wrong layout, missing route/element, broken responsiveness)
- **P1** — noticeable drift (wrong spacing/typography/colors, minor missing elements)
- **P2** — cosmetic nit

---

## Screen 01 — Login (`/gaffer/login`)

**App (1280):** `01-1280.png` · **Mockup:** `01-mockup-1280.png`

App renders the two-tab card ("СОТРУДНИК / ГАФФЕР") with E-mail, Пароль fields, "Забыли пароль?" link, "Войти" button, "ИЛИ" divider, OAuth buttons (Google, Telegram), and "Нет аккаунта? Зарегистрироваться →" link. Structure matches §01 exactly.

| Severity | Item | Location | Mockup ref |
|----------|------|----------|-----------|
| P2 | "Войти" button appears desaturated in screenshot — this is a test-state artifact (button is `disabled` because email/password fields are empty in the Playwright capture, triggering `disabled:opacity-50`). Not a real drift. | `apps/web/app/gaffer/login/page.tsx:130` | §01 |
| P2 | At 1280 the blue header stops at ~640px and below it is a large off-white area, making the page feel unfinished on desktop. Mockup shows the blue background fills the viewport. | `apps/web/app/gaffer/login/page.tsx` (GafferAuthCard wrapper) | §01 |

**Responsive:** spot check 390 matches mockup. Responsive OK.

---

## Screen 01b — Register (`/gaffer/register`)

**App (1280):** `01b-1280.png` · **Mockup:** `01b-mockup-1280.png`

**⚠ P0 — Auth-redirect masking route.** The screenshot is byte-identical to `01-1280.png` (md5 confirmed). The `page.tsx` file exists at `apps/web/app/gaffer/register/page.tsx` and contains a full registration form. The audit session hit the route *before* authentication was established, so Next.js middleware redirected to login — producing an identical screenshot. This is **not** a missing route, but it confirms the middleware does not let unauthenticated public registration through.

**Root cause:** `apps/web/middleware.ts` (or equivalent) is protecting `/gaffer/register` as if it were an authenticated route. Canon §01b requires `/gaffer/register` to be publicly accessible (no auth required).

| Severity | Item | Location | Mockup ref |
|----------|------|----------|-----------|
| P0 | `/gaffer/register` redirects unauthenticated visitors to login instead of showing the registration form. Middleware must whitelist this route alongside `/gaffer/login`. | `apps/web/middleware.ts` (confirm with `grep -n "register" apps/web/middleware.ts`) | §01b |

---

## Screen 01c — Welcome (`/gaffer/welcome`)

**App (1280):** `01c-1280.png` · **Mockup:** `01c-mockup-1280.png`

**⚠ P0 — Auth-redirect masking route.** Byte-identical to `02-1280.png` (the dashboard). This route requires a freshly-registered user without `onboardingCompletedAt`. The audit user already had onboarding complete, so the `useEffect` in `welcome/page.tsx:31` immediately called `router.replace("/gaffer")` — producing the dashboard screenshot.

**Root cause:** The welcome page logic at `apps/web/app/gaffer/welcome/page.tsx:30-34` short-circuits to dashboard for any user with `onboardingCompletedAt`. The seed script must create a user with `onboardingCompletedAt = null` for this route to be auditable. This is a **seed data gap**, not a code bug. The page implementation itself matches §01c (3-step progress bar, team/vendor add forms, explanatory cards).

| Severity | Item | Location | Mockup ref |
|----------|------|----------|-----------|
| P0 (audit-only) | Welcome page not captured — seed user had onboarding already complete. Wave B seed script must create a second user without `onboardingCompletedAt`. | `scripts/canon-audit/seed-gaffer.mjs` | §01c |
| P1 | Step 1 card uses emoji `👋` in heading — mockup shows plain text greeting. Minor tone drift. | `apps/web/app/gaffer/welcome/page.tsx:156` | §01c |

---

## Screen 02 — Dashboard (`/gaffer`)

**App (1280):** `02-1280.png` · **Mockup:** `02-mockup-1280.png`

App shows: greeting ("Доброе вечер, Дмитрий"), date/project subtitle, **four** KPI cards in a row (Мне должны / Я должен / Свободные деньги / Прогноз на 14 дней), then three panels below (Просрочено · мне не заплатили, Ближайшие платежи, Проекты в зоне риска) and a Доnut chart "Структура долгов".

Mockup §02 shows: greeting, **two** large colored KPI cards with full green/red backgrounds ("МНЕ ДОЛЖНЫ", "Я ДОЛЖЕН"), then two list sections ("Заказчики с долгом", "Команда с долгом").

| Severity | Item | Location | Mockup ref |
|----------|------|----------|-----------|
| P1 | KPI cards have no colored background — app uses a thin 3-px left accent strip. Mockup §02 shows full green card for "МНЕ ДОЛЖНЫ" and full red/pink card for "Я ДОЛЖЕН". | `apps/web/src/components/gaffer/designSystem.tsx` (`KPI` component) | §02 |
| P1 | App shows 4 KPI cards (adds "Свободные деньги" and "Прогноз на 14 дней"). Mockup §02 shows 2. The extra two are new cards not yet in canon — this is scope addition, not removal, so lower severity. | `apps/web/app/gaffer/page.tsx:437-449` | §02 |
| P1 | Lower sections differ: app shows "Просрочено / Ближайшие платежи / Проекты в зоне риска / Структура долгов" panels. Mockup §02 shows "Заказчики с долгом" and "Команда с долгом" rows (clickable list items linking to contacts). Canon lists are absent. | `apps/web/app/gaffer/page.tsx` | §02 |
| P2 | App header breadcrumb is "ГАФФЕР · ПОНЕДЕЛЬНИК, 20 АПРЕЛЯ"; mockup shows just the greeting + subtitle with avatar initials chip in top-right corner. App lacks the avatar initials chip at desktop. | `apps/web/app/gaffer/page.tsx:403` | §02 |

**Responsive:** 390 width captured — layout collapses to single column correctly. Responsive OK structurally.

---

## Screen 03 — Projects list (`/gaffer/projects`)

**App (1280):** `03-1280.png` · **Mockup:** `03-mockup-1280.png`

App shows: "Проекты" heading, search input, filter chips (Все / С долгом клиента / С долгом команде / Архив) with counts, project card with 3 metrics (От клиента / Должны мне / Должен я) and status/debt pills.

| Severity | Item | Location | Mockup ref |
|----------|------|----------|-----------|
| P2 | "Все · 1" chip uses filled dark style (correct for selected). Filter chip font slightly larger than mockup. Minor. | `apps/web/app/gaffer/projects/page.tsx` | §03 |
| P2 | No top-bar avatar chip at desktop (sidebar shows user at bottom). Mockup shows avatar "КЛ" initials in the top-right. Affects all desktop screens. | `apps/web/app/gaffer/layout.tsx` | §03 |

**Responsive:** spot check OK. Responsive OK.

---

## Screen 04 — Project card (`/gaffer/projects/<id>`)

**App (1280):** `04-1280.png` · **Mockup:** `04-mockup-1280.png`, `04-project-card-full-mockup-1280.png`, `04-project-header-mockup-1280.png`

App shows: breadcrumb with status pill "ОТКРЫТ", project title + client + date, 3-metric KPI row (СУММА / ДОЛЖНЫ МНЕ / ДОЛЖЕН Я), "ОТ ЗАКАЗЧИКА" section with 3-cell row + "+ Новое поступление" inline button, "КОМАНДА" section with summary row + member rows each with "+ выплата" button, "АРЕНДА СВЕТА" section with "+ Добавить рентал" button. "Редактировать" and "⋯" menu (contains Архивировать/Удалить) in top-right.

| Severity | Item | Location | Mockup ref |
|----------|------|----------|-----------|
| P1 | "Архивировать" is hidden behind "⋯" overflow menu. Mockup §04 shows it as a direct secondary button "Архивировать (долги ≠ 0)" in the header, visually disabled with tooltip. | `apps/web/app/gaffer/projects/[id]/page.tsx:1468` | §04 |
| P1 | Full-card mockup (`04-project-card-full-mockup`) shows inline payment forms (amount input + date picker + "Выплатить" button) embedded directly in each team member row — always visible. App shows only a "+ выплата" button that opens a modal/form. Different UX pattern. | `apps/web/app/gaffer/projects/[id]/page.tsx:84-215` | §04 (card-full) |
| P1 | Header mockup (`04-project-header-mockup`) shows KPI values in color (red for "ДОЛЖЕН Я" negative, blue/accent for positive). App KPI values are already colored (red/blue) — this is actually matched. Minor OK. | — | §04 (header) |
| P2 | Project header label "ПРОЕКТ" eyebrow is absent in app — app goes straight to the project title. Mockup shows "ПРОЕКТ" small eyebrow above title. | `apps/web/app/gaffer/projects/[id]/page.tsx` | §04 |

**Responsive:** not checked (no 1280 misalignment that propagates to mobile structure).

---

## Screen 05 — Client contact card (`/gaffer/contacts/<client>`)

**App (1280):** `05-1280.png` · **Mockup:** `05-mockup-1280.png`, `05-member-projects-variants-mockup-1280.png`

App shows: breadcrumb "← КОНТАКТЫ" with "Заказчик" pill, "КАРТОЧКА ЗАКАЗЧИКА" eyebrow (Title Case label), name, phone, "СУММАРНО ДОЛЖЕН МНЕ" KPI block, project list, "ПОСТУПЛЕНИЯ ОТ КЛИЕНТА" section.

| Severity | Item | Location | Mockup ref |
|----------|------|----------|-----------|
| P1 | KPI block subtext is "1 проект" only. Mockup shows richer subtext: "2 проекта из 3 не закрыты · средний цикл оплаты 24 дня". The `avgPaymentCycleDays` field may not be returned by API or not rendered. | `apps/web/app/gaffer/contacts/[id]/page.tsx:105` | §05 |
| P1 | Seed contact "Ромашка Продакшн" has no telegram handle — so the Telegram link row is absent. This is seed data gap. Code at `contacts/[id]/page.tsx:620-631` handles telegram display correctly when data is present. | `scripts/canon-audit/seed-gaffer.mjs` | §05 |
| P2 | Eyebrow label reads "КАРТОЧКА ЗАКАЗЧИКА" (all-caps via CSS). Mockup shows "ЗАКАЗЧИК" as an uppercase badge pill in the header area, not an eyebrow. Minor positional diff. | `apps/web/app/gaffer/contacts/[id]/page.tsx:600` | §05 |

**Responsive:** spot check OK.

---

## Screen 06 — Team member card (`/gaffer/contacts/<team>`)

**App (1280):** `06-1280.png` · **Mockup:** `06-mockup-1280.png`, `06-team-variants-mockup-1280.png`

App shows: breadcrumb with "Команда" pill, "ПРОФИЛЬ ОСВЕТИТЕЛЯ" eyebrow, name, telegram + phone inline, pink "СУММАРНО Я ДОЛЖЕН" KPI block (full pink background — correctly colored), project list with ПЛАН/ВЫПЛ./ОСТАТОК columns and "+ выпл." button, "ВЫПЛАТЫ ЕМУ" section.

| Severity | Item | Location | Mockup ref |
|----------|------|----------|-----------|
| P1 | KPI block subtext is "1 проект" only. Mockup shows "по 3 проектам · последняя выплата 08.04". The "последняя выплата" date is rendered at `contacts/[id]/page.tsx:187` — verify if the API returns `lastPayoutDate` for team member with no payouts yet (seed gap). | `apps/web/app/gaffer/contacts/[id]/page.tsx:187` | §06 |
| P2 | Eyebrow reads "ПРОФИЛЬ ОСВЕТИТЕЛЯ" (role-aware). Mockup shows "УЧАСТНИК КОМАНДЫ" as a generic label + "КОМАНДА" badge pill. Label is functionally correct but diverges from canon wording. | `apps/web/app/gaffer/contacts/[id]/page.tsx:600` | §06 |

**Responsive:** spot check OK.

---

## Screen 07 — Contacts list (`/gaffer/contacts`)

**App (1280):** `07-1280.png` · **Mockup:** `07-mockup-1280.png`

App shows: "Контакты" heading + "+ Новый" button, two KPI tiles (МНЕ ДОЛЖНЫ / Я ДОЛЖЕН) with green/red dot indicators, search input, filter chips (Все / Заказчики / Команда / Ренталы / С долгом / Архив), contact list with avatar initials, role chips (ЗАКАЗЧИК / КОМАНДА), debt amounts with directional arrows.

| Severity | Item | Location | Mockup ref |
|----------|------|----------|-----------|
| P2 | Search placeholder is "Поиск по имени, телефону…"; mockup shows "Поиск по имени, телефону, @tg…". Minor text diff. | `apps/web/app/gaffer/contacts/page.tsx` | §07 |
| P2 | App has "Ренталы · 0" filter tab not present in mockup. Extra tab — additive, low severity. | `apps/web/app/gaffer/contacts/page.tsx` | §07 |

**Responsive:** spot check OK.

---

## Screen 08 — New project wizard (`/gaffer/projects/new`)

**App (1280):** `08-1280.png` · **Mockup:** `08-mockup-1280.png`

App renders a 6-section single-page form: (1) Клиент with dropdown + "+ Новый клиент", (2) Проект with name/date/comment fields, (3) Сумма от клиента with amount input and "Калькулятор команды осветителей" link, (4) Аренда света with amount input + "+ прикрепить смету" note, (5) Команда with member picker + shift/hours slider + overtime tiers explanation, (6) Итог live summary (От клиента / Должен ренталу / Должен команде / Моя маржа). Well-aligned with mockup.

| Severity | Item | Location | Mockup ref |
|----------|------|----------|-----------|
| P1 | "Создать проект" button appears muted/desaturated (test-state artifact: button is disabled when required fields are empty). Visually alarming but not a code bug. | `apps/web/app/gaffer/projects/new/page.tsx` | §08 |
| P2 | Client dropdown displays "— Выберите заказчика —" placeholder with no contextual debt info. Mockup dropdown option shows "Ромашка Продакшн · 3 проекта · долг 180 000 ₽" — debt context inline in the select option. | `apps/web/app/gaffer/projects/new/page.tsx` | §08 |

**Responsive:** spot check OK.

---

## Screen Bonus — Obligations (`/gaffer/obligations`)

**App (1280):** `bonus-1280.png`

App shows "Реестр долгов" heading with "2 открытых · 0 просрочено" subtitle, 3 KPI tiles (Мне должны / Я должен / Просрочено), 3 rows of filter tabs (Все/Мне должны/Я должен; Все/Клиенты/Рентал/Осветители; Активные/Просрочено/Все), and a table with columns КОНТРАГЕНТ / ПРОЕКТ / КАТЕГОРИЯ / СРОК / СУММА / ОСТАТОК / СТАТУС.

Visual consistency: good. Layout is clean, typography consistent with rest of app.

| Severity | Item | Location | Mockup ref |
|----------|------|----------|-----------|
| P2 | "КАТЕГОРИЯ" column shows pill chip "Клиент" (blue) and "Осветитель" (plain text) — inconsistent pill application. | `apps/web/app/gaffer/obligations/page.tsx` | bonus |

---

## Summary

| Severity | Count |
|----------|-------|
| P0 | 2 |
| P1 | 11 |
| P2 | 10 |

**P0 items:**
1. `/gaffer/register` blocked by middleware for unauthenticated users — route must be public.
2. `/gaffer/welcome` not auditable with current seed — seed must create user with `onboardingCompletedAt = null`.

---

## Recommended Wave B scope (top items by severity × visibility)

1. **Fix middleware to allow unauthenticated access to `/gaffer/register`** — `apps/web/middleware.ts`. Canon §01b cannot be audited until this is fixed. P0 blocker.

2. **Dashboard KPI cards — add colored full-background variant** — `apps/web/src/components/gaffer/designSystem.tsx` (`KPI` component). Add a `colored` prop that applies green/rose background when `tone="pos"/"neg"`. The two primary cards (МНЕ ДОЛЖНЫ, Я ДОЛЖЕН) must use it. P1 high-visibility.

3. **Dashboard lower sections — add "Заказчики с долгом" and "Команда с долгом" list panels** — `apps/web/app/gaffer/page.tsx`. Canon §02 shows these as clickable rows linking to contact cards. The existing "Просрочено" and "Ближайшие платежи" panels can remain as additions. P1 high-visibility.

4. **Project card — surface "Архивировать" button directly in header** (not hidden in overflow menu) — `apps/web/app/gaffer/projects/[id]/page.tsx:1468`. Mockup shows it as a visible disabled secondary button with tooltip. P1.

5. **Login/all screens — fix blue header not filling full viewport height at 1280px** — `apps/web/src/components/gaffer/GafferAuthCard.tsx`. The blue area should cover at least the viewport rather than ~640px. P2 but prominent on first impression.

6. **Client contact card — add `avgPaymentCycleDays` to KPI subtext** — `apps/web/app/gaffer/contacts/[id]/page.tsx:105`. Verify API returns field; add render. P1.

7. **Team member card — add `lastPayoutDate` to KPI subtext** — `apps/web/app/gaffer/contacts/[id]/page.tsx:187`. Already has the render logic; verify seed data and API response. P1.

8. **New project wizard — client dropdown should show debt context inline** — `apps/web/app/gaffer/projects/new/page.tsx`. Append "· N проектов · долг X ₽" to each `<option>` label. P2 but improves UX significantly.

9. **Update seed script to create second user with `onboardingCompletedAt = null`** — `scripts/canon-audit/seed-gaffer.mjs`. Required for Wave B to audit `/gaffer/welcome`. P0 (audit-only).

10. **Contacts search placeholder — add "@tg"** — `apps/web/app/gaffer/contacts/page.tsx`. One-line copy fix. P2.

---

---

## Post-investigation (Sprint 2 Wave B)

**Screen 01b — `/gaffer/register` — audit false positive.**
`apps/web/middleware.ts` line 32 already has `if (pathname.startsWith("/gaffer")) return true;` which passes all `/gaffer/*` routes without a session cookie. `apps/web/app/gaffer/layout.tsx` line 9 lists `"/gaffer/register"` in `PUBLIC_PATHS`, so the client-side auth guard also skips the redirect. The register page uses `<GafferAuthCard>` with distinct content (Name field, "Зарегистрироваться" button, `gafferRegister` submit handler). The byte-identical screenshots in the audit were caused by the Playwright script hitting the route before auth cookies were propagated — not by a real redirect. **No code fix needed.**

---

## Deferred (out of Sprint 2 scope)

- Avatar initials chip in desktop top-bar (affects all screens) — requires layout-level changes to `apps/web/app/gaffer/layout.tsx`.
- Inline payment forms in project team member rows (full-card mockup variant) — significant UX rework; current modal approach functional.
- "ПРОЕКТ" eyebrow label on project card header — pure cosmetic.
- Obligations "Осветитель" pill inconsistency.
- Welcome page emoji vs plain text heading.

---

## After-fix summary (Sprint 2 Wave B)

| Fix | Status | Before → After |
|-----|--------|----------------|
| Fix 1 — `/gaffer/register` investigation | FALSE POSITIVE — no code change | Audit script artifact; middleware already whitelists `/gaffer/*` |
| Fix 2 — KPI colored variant | DONE | `designSystem.tsx`: added `colored?: boolean` prop; `page.tsx`: "Мне должны" and "Я должен" now use `colored` + full bg-gaffer-pos-soft / bg-gaffer-neg-soft cards |
| Fix 3 — AuthCard full-height blue desktop | DONE | `GafferAuthCard.tsx:22`: removed `style={{ minHeight: "640px" }}` override; `min-h-screen` class now applies correctly |
| Fix 4 — Client KPI subtext avgPaymentCycleDays | BLOCKED | `avgPaymentCycleDays` field absent from `GafferContact` DTO in `gafferApi.ts`; adding API fields is out of surgical scope |
| Fix 5 — Team KPI subtext lastPayoutDate | BLOCKED | `lastPayoutDate`/`lastPayoutAt` absent from DTO in `gafferApi.ts`; out of surgical scope |
| Fix 6 — Contacts search placeholder | DONE | `contacts/page.tsx:392`: `"Поиск по имени, телефону…"` → `"Поиск по имени, телефону, @tg…"` |
| Fix 7 — Welcome emoji | DONE | `welcome/page.tsx:155`: removed `<div className="text-[40px]...">👋</div>` |
