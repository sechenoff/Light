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
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold text-ink break-words">
            {auditActionLabel(entry.action)}
          </h3>
          <p className="text-xs text-ink-2 break-words">
            {entry.user && entry.userId !== "_system_" ? (
              <Link
                href={`/admin/audit?userId=${encodeURIComponent(entry.userId)}`}
                className="text-accent-bright hover:underline"
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
                <Link href={href} className="hover:underline">
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
          className="text-xs text-ink-3 mono-num"
        >
          {auditTimestamp(entry.createdAt)}
        </time>
      </div>
      {changes.length ? (
        <details open={changes.length <= 4}>
          <summary className="cursor-pointer min-h-8 text-xs font-medium text-accent-bright">
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
