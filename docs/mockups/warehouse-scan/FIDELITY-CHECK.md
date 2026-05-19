# Warehouse-scan UI — Design Fidelity Check

**Date:** 2026-05-19  
**Widths tested:** 375×812 (mobile) · 1440×900 (desktop)  
**Screenshots captured:** 31  
**Output directory:** `docs/mockups/warehouse-scan/_fidelity/`  
**Mockup source of truth:** `docs/mockups/warehouse-scan/01-return-checklist.html`, `02-problem-reasons.html`, `03-issue-and-desktop.html`

---

## Per-screen verdict

| # | Screen | Mobile 375 | Desktop 1440 | Notes |
|---|--------|-----------|--------------|-------|
| 01 | Login | PASS | PASS | Dark navy header, eyebrow СКЛАД, name select, PIN field, «Войти». Desktop centers form card. |
| 02 | Operation pick | PASS | PASS | «Выберите операцию», Выдача/Возврат cards (blue-soft/teal-soft), «Открыть мастерскую» dashed-border link below. |
| 03 | Booking list (ISSUE) | PASS | PASS | Сегодня/Завтра buckets, `#XXXXXX` truncated IDs (no barcode strings), project + client + unit count. Desktop: two-pane, placeholder text in right pane. |
| 04 | Issue checklist | PASS | PASS | «Выдать всё разом» primary bar, СВЕТ/СТОЙКИ groups, 2-button rows («выдано»/«не выдаём»), «＋ Добор» bottom bar. Desktop: counter chip «0 / 4 ✓», «+ Добор» top-right dashed chip, sticky bottom footer. |
| 05a | Addon search open | PASS | PASS | Mobile: bottom sheet rises, grayed background. Desktop: inline panel below checklist. Both show «ДОБОР В БРОНЬ #...» eyebrow, search input. |
| 05b | Addon — free result | PASS | PASS | Manfrotto 1004 row with «свободно ×4» emerald badge. |
| 05c | Addon — busy result | PASS | PASS | Astera Titan Tube row with «занято» rose badge. |
| 05d | Addon — conflict warning | PASS | PASS | Rose conflict card: «Astera Titan Tube занят», conflicting booking info, «Отмена»/«Выдать под ответственность» buttons, «Конфликт зафиксируется в аудите» note. |
| 06 | Return checklist | PASS | PASS | 3-button rows (✓ Принято / 🔧 Ремонт / ✗ Проблема), «Принять всё разом» primary bar, СВЕТ group, 3×SkyPanel S60, sticky «Завершить приёмку» footer. |
| 07 | Repair panel (amber) | PASS | PASS | Amber `bg-amber-50 border-amber-200` expanded panel, «Что сломалось?» textarea, «Фото» camera button, «→ создаст карточку ремонта, фото видны руководителю» amber note. |
| 08 | Problem panel (rose) | PASS | PASS | Rose panel, 4 chips: 📍 Остался на площадке / 🤷 Потерян / 💥 Уничтожен / 🚨 Украден. «Комментарий (обязательно)» textarea. Sub-note «→ в список «Потеряшки»». |
| 08b | LEFT_ON_SITE date field | PASS | PASS | «Остался на площадке» chip toggles to rose-filled. «Ожидается к:» date input appears exclusively for this chip. No date field for other chips (Потерян/Уничтожен/Украден). |
| 09 | Return completion result | PASS | PASS | Emerald header «Приёмка завершена», project name, dl counts (Принято/На ремонт/В «Потеряшки»), «Готово» button. |
| 10 | Desktop two-pane | PASS (N/A) | PASS | `lg:grid-cols-[minmax(280px,360px)_1fr]`: left pane = booking list, right pane = checklist detail. Booking list scrollable with aside border-r. |
| 11 | /warehouse/problems registry | PASS | PASS | «Потеряшки» title, eyebrow СКЛАД, 5-pill filter (Все/Ожидается/На поиске/Найдено/Не найдено/Списано), «Потеряшек нет» empty-state. Desktop: rendered inside AppShell with sidebar nav (WAREHOUSE role). |

---

## Summary

**Total screens:** 15 (across 2 widths = up to 30 viewport instances)  
**PASS:** 15/15  
**DIFF:** 0/15  
**Code fixes applied:** 0 (no UI component changes needed)

All critical mockup requirements verified:
- No barcode strings (LR-XXX-NNN) anywhere in UI
- Russian labels throughout
- `#XXXXXX` short booking IDs (last 6 chars uppercase)
- IBM Plex canon tokens only (no hex colors in components)
- 3-button return rows (not 2)
- 4-chip problem panel (not 3), date field only for «Остался на площадке»
- Amber RepairPanel, rose ProblemPanel
- Desktop two-pane `lg:grid-cols` layout
- Sticky footers on mobile

---

## Infrastructure fix discovered during run

**Bug:** `BookingItemUnit.returnedAt` was not reset during seed re-runs. After the first walkthrough run completed the RETURN session, the `returnedAt` timestamp was set on all 3 SkyPanel BookingItemUnits. The `getChecklistState` service queries `returnedAt: null` to find ISSUED units for RETURN sessions. On subsequent runs, all units were filtered out, producing `units: []` → empty checklist.

**Fix applied:** `apps/api/scripts/seed-warehouse-fidelity.ts` now calls `prisma.bookingItemUnit.update({ data: { returnedAt: null } })` for all existing return-booking BookingItemUnit records on every seed run.

This was a test-infrastructure bug, not a UI bug. No component code was changed.

---

## Methodology

1. Servers started: `apps/api` on :4000, `apps/web` on :3000  
2. DB seeded: `npx tsx apps/api/scripts/seed-warehouse-fidelity.ts` (WarehousePin, 3 Equipment, 5 Bookings, AdminUser)  
3. Playwright Chromium headless, `isMobile: true` at 375, `isMobile: false` at 1440  
4. Between viewport runs: seed re-run to restore `returnedAt: null` and unit statuses  
5. All `clearScanSessions()` calls use `execSync('npx tsx apps/api/scripts/clear-scan-sessions.ts')` — no Prisma dynamic import from scripts  
6. Screenshots taken with `fullPage: true` after `waitForLoadState("networkidle")`
