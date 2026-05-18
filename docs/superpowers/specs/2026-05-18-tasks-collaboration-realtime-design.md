# Tasks Collaboration & Realtime — Design Spec

**Date:** 2026-05-18
**Status:** Approved (design phase)
**Scope:** Enhance the existing `/tasks` feature with a task detail surface, comments, checklist/subtasks, and near-realtime sync for a 3–5 person rental-house team.

---

## 1. Context

The Tasks feature (Sprint 3) is shipped and stable: CRUD with optimistic updates, Moscow date-only `dueDate`, 3 scope filters, bucketed grouping, archive page with stats, `/day` widget, full audit trail, role-based edit permissions. Files live under `apps/web/src/components/tasks/` and `apps/api/src/{routes,services}/task*`.

Today a task is a flat inline card with inline-title edit and a small edit modal. There is **no detail surface**, **no collaboration** (comments/checklist), and the shared list is **stale until manual reload** — a real problem for a multi-person team where one person assigns and another executes.

This spec adds, in **one coherent v1 iteration**:

1. **Comments** — a chronological discussion thread per task.
2. **Checklist / subtasks** — ordered check items with progress.
3. **Realtime sync** — the list and open detail stay fresh without reload.

All three live behind a new **slide-over detail panel** deep-linked via `?task=<id>`.

### 1.1 Decisions locked during brainstorming

| Decision | Choice | Rationale |
|---|---|---|
| Direction | Collaboration depth + UX/realtime | User priority; not system-integration or recurring/bulk |
| v1 feature set | Comments + Checklist + Realtime | Photo attachments, comment editing, @mentions deferred |
| Detail surface | Right slide-over panel, `?task=id` deep-link | Fast triage — keep list context; avoids accordion (v2 mockup rejected accordion) |
| Realtime mechanism | Smart polling | Zero infra, no nginx change, robust under PM2 restarts; SSE documented as v2 path |

### 1.2 Out of scope (v1)

Photo/file attachments, comment editing, @mentions/notifications, SSE/WebSockets, recurring tasks, bulk actions, multiple assignees/watchers, due **time** (date-only stays), drag-and-drop bucket reordering.

---

## 2. Architecture (Approach A — consolidated fetch + unified smart-polling)

- `GET /api/tasks/:id` is extended to return the task **plus** its `comments` (user-enriched) and `checklist` in a single response. Opening the panel = one fetch.
- `GET /api/tasks` list items gain lightweight aggregates (`commentCount`, `checklist {done,total}`) via Prisma relation `_count` — **no N+1**.
- Comment and checklist mutations are **separate** REST endpoints, each optimistic with snapshot→apply→reconcile→rollback (the existing `useTasksQuery` pattern).
- Realtime = two polling controllers: the list (12 s) and the open panel (8 s), both paused when the tab is hidden and force-refetched after the user's own mutation.

Rejected alternatives: **B** (per-section endpoints + per-section polling — 3 fetches/timers per open panel, over-engineered for 3–5 users); **C** (SSE event bus — needs nginx `proxy_buffering off` + connection lifecycle under PM2; deferred as documented v2 upgrade).

---

## 3. Data model (Prisma)

Two new models with a real FK + cascade to `Task` (parent-child ownership — follows the `Repair → RepairWorkLog` relation convention; user references stay FK-less per the `Task.createdBy` convention). A `comments`/`checklist` back-relation is added to `Task` to enable `_count`.

```prisma
model Task {
  // ... existing fields unchanged ...
  comments  TaskComment[]
  checklist TaskChecklistItem[]
}

model TaskComment {
  id        String   @id @default(cuid())
  taskId    String
  task      Task     @relation(fields: [taskId], references: [id], onDelete: Cascade)
  authorId  String   // AdminUser.id — no FK, enriched manually
  body      String
  createdAt DateTime @default(now())

  @@index([taskId, createdAt])
}

model TaskChecklistItem {
  id          String    @id @default(cuid())
  taskId      String
  task        Task      @relation(fields: [taskId], references: [id], onDelete: Cascade)
  text        String
  done        Boolean   @default(false)
  position    Int       // 0-based ordering within the task
  completedAt DateTime?
  completedBy String?   // AdminUser.id — no FK
  createdAt   DateTime  @default(now())

  @@index([taskId, position])
}
```

Migration applied via `prisma db push --accept-data-loss` (deploy.sh convention) — additive only, no data loss for existing tables. DB is backed up by deploy.sh before push.

### 3.1 Audit

`AuditEntry.action` is a free-form `string` (no Prisma enum) and `"Task"` is already in the `AuditEntityType` TS union — **no type/schema change for audit**. Comment/checklist audit rows use `entityType: "Task"`, `entityId: <taskId>` so they surface in the task's existing audit timeline.

New action strings, written in the **same `$transaction`** as the mutation (existing convention):

- `TASK_COMMENT_ADD`, `TASK_COMMENT_DELETE`
- `TASK_CHECKLIST_ADD`, `TASK_CHECKLIST_DELETE`

**Checklist toggles are intentionally NOT audited** — they are high-frequency and self-evident in the item state; auditing every toggle would flood `AuditEntry`. Structural changes (add/delete item) and all comment activity are audited.

---

## 4. API

### 4.1 Extended existing endpoints

- `GET /api/tasks/:id` → `{ ...task, createdByUser, assignedToUser, completedByUser, comments: TaskCommentDTO[], checklist: TaskChecklistItemDTO[] }`. `comments` ordered `createdAt asc`, each enriched with `authorUser {id, username}`. `checklist` ordered `position asc`.
- `GET /api/tasks` list items += `commentCount: number`, `checklist: { done: number; total: number }` via `prisma.task.findMany({ ..., include: { _count: { select: { comments: true } }, checklist: { select: { done: true } } } })` (or an aggregate) — bounded, no N+1. Existing serializer/enrichment unchanged otherwise.

### 4.2 New endpoints (all under existing `rolesGuard(["SUPER_ADMIN","WAREHOUSE","TECHNICIAN"])`)

| Method | Route | Permission | Behavior |
|---|---|---|---|
| `POST` | `/api/tasks/:id/comments` | any role that can see the task | Add comment. Zod `body: string.trim().min(1).max(5000)`. Audit `TASK_COMMENT_ADD`. |
| `DELETE` | `/api/tasks/:id/comments/:commentId` | author **or** SUPER_ADMIN | Delete comment. 403 `TASK_COMMENT_DELETE_FORBIDDEN` otherwise. Audit `TASK_COMMENT_DELETE`. |
| `POST` | `/api/tasks/:id/checklist` | creator/SA (assignee may add too — see §4.3) | Add item at `position = max+1`. Zod `text: string.trim().min(1).max(500)`. Audit `TASK_CHECKLIST_ADD`. |
| `PATCH` | `/api/tasks/:id/checklist/:itemId` | toggle `done`: creator/assignee/SA · `text`/`position`: creator/SA | Partial: `{ done? , text? , position? }`. Toggling sets/clears `completedAt`/`completedBy`. Idempotent on `done`. **No audit row emitted for any PATCH** (toggle/text/position) — see §3.1. |
| `DELETE` | `/api/tasks/:id/checklist/:itemId` | creator **or** SA | Remove item. Audit `TASK_CHECKLIST_DELETE`. |

All mutations wrapped in `prisma.$transaction` with the audit write (existing `taskService` convention). 404 `TASK_NOT_FOUND` / `TASK_COMMENT_NOT_FOUND` / `TASK_CHECKLIST_ITEM_NOT_FOUND` as appropriate. Service functions added to `apps/api/src/services/taskService.ts` (or a new `taskCollabService.ts` if `taskService.ts` approaches the 800-line limit — decide at implementation time).

### 4.3 Permission model (consistent with existing `updateTask`)

- **Comments:** any of the 3 roles who can list the task may comment. Delete = author or SA.
- **Checklist:** edit-content permission mirrors `updateTask` — creator or SA may add/edit-text/delete/reorder; the **assignee may toggle `done`** (parallels "assignee may toggle `urgent`"). Violation → 403 `TASK_EDIT_FORBIDDEN`.

---

## 5. Realtime — smart polling

No new infra. Two controllers, both honoring `document.visibilityState`:

- **List** (`useTasksQuery`): `setInterval` refetch every **12 s**; cleared when `document.hidden`, re-armed + immediate refetch on `visibilitychange→visible`; immediate refetch after any successful own mutation. Poll replaces `tasks` state — safe because `TaskCard` already syncs its title draft only when `!editingTitle`, so an in-progress inline edit is never clobbered.
- **Panel** (`useTaskDetail`, only while a panel is open): poll `GET /api/tasks/:id` every **8 s**, same hidden-pause. Reconcile merges server truth into panel state while preserving **unsent local drafts** (comment composer text, checklist add-input). If the poll returns 404 (task deleted by someone else) → close panel + `toast.info("Задача была удалена")`.

Conflict handling reuses the established optimistic pattern: snapshot → optimistic apply → reconcile from server → rollback + `toast.error` on failure, with a per-id `useRef<Set<string>>` in-flight guard against double-submits.

Load math: ≤5 clients × (list/12 s + maybe panel/8 s) against SQLite = trivial; well within current capacity.

---

## 6. Web components

| File | Responsibility |
|---|---|
| `apps/web/src/components/tasks/TaskDetailPanel.tsx` | Right slide-over: backdrop, `Esc`-close, focus trap, restores focus on close. Sections: header (status/assignee/due/urgent — reuse `useTasksQuery` mutations), description, **checklist**, **comments**, audit/meta footer. |
| `apps/web/src/components/tasks/TaskChecklist.tsx` | Ordered items, add-input (`Enter` to add), toggle, delete, progress bar (`done/total`). Optimistic. |
| `apps/web/src/components/tasks/TaskComments.tsx` | Chronological thread + composer (textarea, `⌘/Ctrl+Enter` to send, `Esc` blur). Optimistic append, rollback+toast on failure. Delete affordance on own comments (and for SA). |
| `apps/web/src/components/tasks/useTaskDetail.ts` | Consolidated `GET /api/tasks/:id` fetch + 8 s panel polling + optimistic comment/checklist mutations with rollback. |
| `apps/web/src/components/tasks/TaskCard.tsx` | Add `💬 N` and `☑ done·total` chips (hidden when zero). Clicking the card body (NOT the checkbox, NOT inline-title edit, NOT the `⋯` menu) opens the panel via `?task=id`. |
| `apps/web/src/components/tasks/TasksPage.tsx` | Read `?task=` search param → render `TaskDetailPanel`; thread list polling through `useTasksQuery`. |
| `apps/web/src/components/tasks/useTasksQuery.ts` | Add the 12 s visibility-aware list poller; expose nothing new to callers. |

Design language: IBM Plex canon + semantic tokens (`ink/surface/border/accent/rose/...`), consistent with existing task components and `RejectBookingModal` / `TaskCreateModal` slide/modal patterns. No new deps.

---

## 7. Error handling

- All new mutations: explicit try/catch → `next(err)` (API) and snapshot rollback + `toast.error` (web).
- Empty/whitespace comment or checklist text rejected client-side **and** server-side (Zod `.trim().min(1)`).
- Stale panel (task deleted via poll) → graceful close + info toast, never a crash.
- 403/404 surfaced as Russian user-facing messages; detailed context logged server-side.

---

## 8. Testing

**API integration** (new `apps/api/src/__tests__/taskCollab.test.ts`, following the isolated-SQLite `tasks.test.ts`/`approval.test.ts` harness with `signSession()` tokens):
- Comment create/list/delete; delete-forbidden for non-author non-SA → 403.
- Checklist add/toggle/edit/reorder/delete; assignee-can-toggle, assignee-cannot-edit-text; toggle idempotency.
- Audit rows: `TASK_COMMENT_ADD/DELETE`, `TASK_CHECKLIST_ADD/DELETE` written in-transaction; **no** audit row on checklist toggle.
- `GET /api/tasks` `_count` correctness (no N+1 — assert query count or shape).
- `GET /api/tasks/:id` returns enriched comments + ordered checklist.

**Web** (vitest + jsdom, existing harness):
- `useTaskDetail` optimistic add/rollback for comment and checklist.
- `TaskDetailPanel` deep-link open/close via `?task=`, `Esc` close, focus restore.
- Poll does not clobber an in-progress comment composer draft.

Target ≥80% on new logic per repo testing rule.

---

## 9. Documentation & conventions

- `CLAUDE.md` "Tasks Feature" section updated: new models, endpoints, audit actions, polling convention, slide-over panel, `?task=` deep-link.
- New Key Files rows for `TaskDetailPanel.tsx`, `TaskChecklist.tsx`, `TaskComments.tsx`, `useTaskDetail.ts`.
- Conventions addendum: "Checklist toggles are not audited (high-frequency); comment + structural checklist changes are." and "Smart-polling: list 12 s / panel 8 s, visibility-paused, force-refetch after own mutation."

---

## 10. v2 upgrade path (documented, not built)

If polling latency becomes a felt problem at higher concurrency: replace the two pollers with an SSE stream `GET /api/tasks/events` emitting `task.updated | comment.added | checklist.changed`, clients invalidate/refetch on event. Requires nginx `proxy_buffering off` on that route and connection-lifecycle handling under PM2 restarts. The polling hooks are deliberately structured so the swap is contained to `useTasksQuery`/`useTaskDetail`.
