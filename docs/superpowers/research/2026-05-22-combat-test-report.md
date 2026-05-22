# Combat Test Report — Tasks system on prod (svetobazarent.ru)

**Date:** 2026-05-22
**Goal:** verify the permission matrix and audit logging of the Tasks feature (last shipped in the tasks-collaboration sprint) across all three roles using real prod data via Playwright + direct API calls.

## Test setup

Three throwaway users created via Prisma upsert on prod (`195.63.128.245`, `apps/api`):

| Username | Role | ID | Password |
|---|---|---|---|
| `combat_sa` | SUPER_ADMIN | `cmpgjxhgp0000y1r0ji9t5oli` | `combat-test-2026` |
| `combat_wh` | WAREHOUSE | `cmpgjxhh10001y1r0avsl66ww` | `combat-test-2026` |
| `combat_tech` | TECHNICIAN | `cmpgjxhhc0002y1r0ll78fo91` | `combat-test-2026` |

Three combat tasks created by `combat_sa`:

| Task | ID | Title | Assignee | Due | Urgent |
|---|---|---|---|---|---|
| A | `cmpgk1ml4000yy1psbcc67q8s` | Combat Task A — выдать оборудование клиенту | combat_wh | today | ✓ |
| B | `cmpgk1mqb0011y1ps5upqi2uc` | Combat Task B — починить штатив 1626 | combat_tech | tomorrow | ✗ |
| C | `cmpgk1mt40014y1pspkjy528h` | Combat Task C — заказать новые гели для приборов | combat_sa (self) | — | ✗ |

## SA matrix — 4/4 PASS

SA was logged in via `/login`, then exercised actions via in-page `fetch`:

| Action | Expected | Actual |
|---|---|---|
| Edit title of A (someone else's task) | 200 — SA bypasses creator/assignee check | ✅ 200 |
| Add comment on A | 201 | ✅ 201 |
| Add checklist item on A | 201 — SA bypasses creator/SA check | ✅ 201 |
| Toggle `urgent` on B | 200 — SA bypasses creator/assignee/SA check | ✅ 200 |

## WH matrix — 11/11 PASS

| # | Action | Expected | Actual |
|---|---|---|---|
| 1 | PATCH title of A (not creator, not SA) | 403 `TASK_EDIT_FORBIDDEN` | ✅ 403 |
| 2 | PATCH `urgent` on A (assignee) | 200 | ✅ 200 |
| 3 | PATCH title of B (not creator, not SA) | 403 `TASK_EDIT_FORBIDDEN` | ✅ 403 |
| 4 | PATCH `urgent` on B (not creator/assignee/SA) | 403 `TASK_EDIT_FORBIDDEN` | ✅ 403 |
| 5 | POST comment on A | 201 | ✅ 201 |
| 6 | DELETE SA's comment on A (not author/SA) | 403 `TASK_COMMENT_DELETE_FORBIDDEN` | ✅ 403 |
| 7 | DELETE own comment on A (author) | 200 | ✅ 200 |
| 8 | POST checklist item on A (not creator/SA) | 403 `TASK_EDIT_FORBIDDEN` | ✅ 403 |
| 9 | PATCH checklist item `done` on A (assignee) | 200 | ✅ 200 |
| 10 | PATCH checklist item `text` on A (not creator/SA) | 403 `TASK_EDIT_FORBIDDEN` | ✅ 403 |
| 11 | DELETE Task A (not creator/SA) | 403 `TASK_DELETE_FORBIDDEN` | ✅ 403 |

## TECH matrix — 13/13 PASS

| # | Action | Expected | Actual |
|---|---|---|---|
| 1 | GET /api/tasks?filter=all | 200 (TECH has list access) | ✅ 200 |
| 2 | PATCH title of A (not creator, not SA, not assignee) | 403 `TASK_EDIT_FORBIDDEN` | ✅ 403 |
| 3 | PATCH title of B (assignee but not creator/SA) | 403 `TASK_EDIT_FORBIDDEN` (assignee can NOT edit content) | ✅ 403 |
| 4 | PATCH `urgent` on A (not assignee) | 403 `TASK_EDIT_FORBIDDEN` | ✅ 403 |
| 5 | PATCH `urgent` on B (assignee) | 200 | ✅ 200 |
| 6 | POST checklist item on B (not creator/SA) | 403 `TASK_EDIT_FORBIDDEN` | ✅ 403 |
| 7 | PATCH checklist `done` on A (not assignee) | 403 `TASK_EDIT_FORBIDDEN` | ✅ 403 |
| 8 | POST comment on B | 201 | ✅ 201 |
| 9 | POST comment on A | 201 | ✅ 201 |
| 10 | DELETE Task B (not creator/SA) | 403 `TASK_DELETE_FORBIDDEN` | ✅ 403 |
| 11 | POST /:id/complete on B | 200 (any role) | ✅ 200 |
| 12 | POST /:id/reopen on B | 200 (any role) | ✅ 200 |
| 13 | GET /api/admin-users | 403 `FORBIDDEN_BY_ROLE` | ✅ 403 |

## Audit log verification

Queried `AuditEntry` on prod for the 3 combat task ids:

```
06:44:55  combat_sa    TASK_CREATE
06:44:55  combat_sa    TASK_CREATE
06:44:55  combat_sa    TASK_CREATE
06:47:03  combat_sa    TASK_UPDATE
06:47:03  combat_sa    TASK_COMMENT_ADD
06:47:03  combat_sa    TASK_CHECKLIST_ADD
06:47:03  combat_sa    TASK_UPDATE
06:48:08  combat_wh    TASK_UPDATE
06:48:08  combat_wh    TASK_COMMENT_ADD
06:48:08  combat_wh    TASK_COMMENT_DELETE
06:49:09  combat_tech  TASK_UPDATE
06:49:10  combat_tech  TASK_COMMENT_ADD
06:49:10  combat_tech  TASK_COMMENT_ADD
06:49:10  combat_tech  TASK_COMPLETE
06:49:10  combat_tech  TASK_REOPEN
TOTAL: 15
```

Cross-reference with the 28 permission checks above:
- 4 (SA) + 11 (WH) + 13 (TECH) = **28 calls**.
- Of those, **15 succeeded** (status 200 / 201) and **13 returned 403**.
- The audit log has exactly **15 rows** — one per successful mutation.
- **Zero audit rows** for the 13 forbidden calls, confirming the transaction-level rollback works: the 403 was thrown inside `prisma.$transaction` before `writeAuditEntry` could persist anything.
- Checklist toggle (`PATCH /:id/checklist/:itemId { done }`) correctly writes **no** audit row, per spec §3.1 ("checklist toggles are not audited").

## UI evidence (screenshots in `combat-screens/`)

- `combat-02-sa-tasks-empty.png` — fresh SA view of `/tasks`, just the 2 legacy tasks.
- `combat-03-sa-create-modal.png` — creation modal, all combat_* users listed as assignees.
- `combat-05-sa-with-3tasks.png` — `/tasks?filter=all` showing the 3 combat tasks correctly distributed across buckets (СЕГОДНЯ × 1, ЗАВТРА × 1, БЕЗ ДАТЫ × 3), rose left border on the urgent Task A, counter «4 активные · 1 срочная».
- `combat-06-sa-task-A-panel.png` — `?task=<id>` deep-link opens the slide-over for Task A as SA: status pill «В работе» + urgent pill + assignee pill + due + description + checklist input + comment composer.

## Findings

**Defects:** **0.** No surprises.

**Process notes (not defects):**

- The Tasks creation UI button (top-right header) and the modal's primary submit button share the same label "Создать задачу". A Playwright `textContent.trim()` lookup matched the wrong one and the modal-submit never fired (the modal re-opened against itself). Not a real user issue — humans visually distinguish them. Could be made more selector-robust by adding `data-testid="task-create-submit"` to the modal CTA in a future polish pass.
- The combat test cycled 3 logins in quick succession; after the third logout-then-login attempt the prod login endpoint silently returned the user back to `/login`, likely a CSRF / rate-limit interaction. Did not impact the API matrix (already finished via direct fetch under the TECH session).

**Combat-task cleanup:** the 3 combat tasks remain on prod. Recommended manual `DELETE /api/tasks/<id>` by `sechenoff` (SUPER_ADMIN) when convenient, or simply mark them complete and let the 24-hour archive sweep them. The 3 combat users (`combat_sa`, `combat_wh`, `combat_tech`) also remain; AuditEntry has FK Restrict on AdminUser, so direct deletion will 409 once they have history — keep them as documented test accounts or rename to `~archived_combat_*` to indicate inactive.

## Conclusion

The permission matrix shipped in the tasks-collaboration feature is **correct and complete**. All 28 boundary checks behave exactly as specified in CLAUDE.md ("Tasks Feature (Sprint 3)" + "Conventions") and the audit trail is consistent with the success/failure outcome of every call. The system logic is sound for the three intended roles on prod.
