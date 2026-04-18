"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import type { GafferContact } from "../../lib/gafferApi";

interface Props {
  returnTo: string | null;
  returnLabel: string | null;
  contactId: string;
  contactType: GafferContact["type"];
  isArchived: boolean;
}

/** Shown on the contact detail page when the user arrived via the project-creation
 *  "create new contact" link. Offers a one-click way to return to project creation
 *  with this contact pre-selected as the client. */
export function ReturnToProjectBanner({ returnTo, returnLabel, contactId, contactType, isArchived }: Props) {
  const router = useRouter();

  // Only show for active CLIENT contacts with a valid gaffer-scoped returnTo
  if (!returnTo) return null;
  if (!returnTo.startsWith("/gaffer/")) return null;
  if (contactType !== "CLIENT") return null;
  if (isArchived) return null;

  const label = returnLabel || "создание проекта";

  function handleUse() {
    router.push(`${returnTo}?clientId=${contactId}`);
  }

  // Strip returnTo/returnLabel from current URL for the cancel link
  const cancelHref = `/gaffer/contacts/${contactId}`;

  return (
    <div className="mx-4 mt-3 border border-accent-border bg-accent-soft rounded-lg p-4 mb-1">
      <p className="text-[12px] text-ink-2 mb-2">
        Вернуться к{" "}
        <span className="font-medium text-ink">{label}</span>
      </p>
      <div className="flex gap-2">
        <button
          onClick={handleUse}
          className="flex-1 bg-accent-bright hover:bg-accent text-white font-medium rounded px-3 py-2 text-[13px] transition-colors"
        >
          ✓ Использовать как заказчика
        </button>
        <Link
          href={cancelHref}
          className="px-3 py-2 border border-border bg-surface text-ink-2 rounded text-[13px] hover:bg-[#fafafa] transition-colors"
        >
          Отмена
        </Link>
      </div>
    </div>
  );
}
