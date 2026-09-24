"use client";
import Link from "next/link";
import { entityHref } from "@/lib/auditLabels";
import {
  auditActionLabel,
  auditActorLabel,
  auditChanges,
  auditEntityLabel,
  auditTimestamp,
  type AuditRecord,
} from "@/lib/auditFormat";

export function AuditEntryCard({
  entry,
  showEntity = true,
}: {
  entry: AuditRecord;
  showEntity?: boolean;
}) {
  const changes = auditChanges(entry);
  const href = entityHref(entry.entityType, entry.entityId);
  const entity = entry.entityLabel || auditEntityLabel(entry.entityType);
  return (
    <article className="min-w-0 rounded-lg border border-border bg-surface p-3 sm:p-4 space-y-3">
      {/* basis-48 + grow: время уходит под автора по ширине карточки, а не по
          длине заголовка — во всём списке оно стоит одинаково. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 basis-48 grow space-y-1">
          <h3 className="text-sm font-semibold text-ink break-words">
            {auditActionLabel(entry.action)}
          </h3>
          <p className="text-xs text-ink-2 break-words">
            {entry.user && entry.userId !== "_system_" ? (
              <Link
                href={`/admin/audit?userId=${encodeURIComponent(entry.userId)}`}
                className="inline-block py-1 -my-1 text-accent-bright hover:underline"
              >
                {auditActorLabel(entry)}
              </Link>
            ) : (
              auditActorLabel(entry)
            )}
          </p>
          {showEntity && (
            <p className="text-xs text-ink-3 break-words">
              {href ? (
                <Link href={href} className="inline-block py-1 -my-1 hover:underline">
                  {entity}
                </Link>
              ) : (
                entity
              )}
            </p>
          )}
        </div>
        <time
          dateTime={entry.createdAt}
          className="shrink-0 whitespace-nowrap text-xs text-ink-3 mono-num"
        >
          {auditTimestamp(entry.createdAt)}
        </time>
      </div>
      {changes.length ? (
        <details open={changes.length <= 4}>
          {/* py-2 -my-2: зона нажатия 32 px без пустой полосы под строкой. */}
          <summary className="cursor-pointer py-2 -my-2 text-xs font-medium text-accent-bright">
            Что изменилось · {changes.length}
          </summary>
          <div className="space-y-2 mt-2">
            {changes.map((change) => (
              <div
                key={change.key}
                className="rounded border border-border p-2 text-xs min-w-0"
              >
                <p className="font-medium text-ink break-words mb-1">
                  {change.label}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <p className="min-w-0 whitespace-pre-wrap break-words text-ink-3">
                    <span className="font-medium">Было: </span>
                    {change.before}
                  </p>
                  <p className="min-w-0 whitespace-pre-wrap break-words text-ink">
                    <span className="font-medium">Стало: </span>
                    {change.after}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : (
        <p className="text-xs text-ink-3">
          Подробности изменения не сохранены.
        </p>
      )}
    </article>
  );
}
