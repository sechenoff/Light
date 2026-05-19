"use client";

/**
 * ISSUE checklist — Task 5.2 placeholder.
 * Full implementation (per-unit check, «Выдать всё», добор) lands in Task 6.
 */

import { PlaceholderPanel } from "./PlaceholderPanel";

export function IssueChecklist({
  sessionId,
  projectName,
  onBack,
}: {
  sessionId: string;
  projectName: string;
  onBack: () => void;
}) {
  void sessionId;
  return (
    <PlaceholderPanel
      eyebrow="Выдача"
      title={projectName || "Чек-лист выдачи"}
      note="Чек-лист выдачи (поединичная отметка, «Выдать всё разом», добор по каталогу) появится здесь."
      onBack={onBack}
      backLabel="К списку броней"
    />
  );
}
