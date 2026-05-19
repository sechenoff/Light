"use client";

/**
 * RETURN checklist — Task 5.2 placeholder.
 * Full implementation (per-unit check, поломка/утеря, фото) lands in Task 7.
 */

import { PlaceholderPanel } from "./PlaceholderPanel";

export function ReturnChecklist({
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
      eyebrow="Возврат"
      title={projectName || "Чек-лист возврата"}
      note="Чек-лист возврата (поединичная приёмка, регистрация поломки/утери, фото) появится здесь."
      onBack={onBack}
      backLabel="К списку броней"
    />
  );
}
