"use client";

/**
 * Reconciliation summary / complete — Task 5.2 placeholder.
 * Full implementation (расхождения, подтверждение, завершение) lands in Task 7/8.
 */

import { PlaceholderPanel } from "./PlaceholderPanel";

export function SummaryStep({
  sessionId,
  onBack,
}: {
  sessionId: string;
  onBack: () => void;
}) {
  void sessionId;
  return (
    <PlaceholderPanel
      eyebrow="Итог"
      title="Сверка и завершение"
      note="Сводка расхождений и подтверждение завершения сессии появятся здесь."
      onBack={onBack}
      backLabel="К чек-листу"
    />
  );
}
