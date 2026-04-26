"use client";

import { formatRub } from "../../lib/format";

interface ContactChipsProps {
  phone: string | null;
  email: string | null;
  clientName: string;
  outstanding: number;
}

/**
 * Маленькие чипы-ссылки для звонка и email клиенту.
 * Рендерятся только если есть хотя бы один контактный метод.
 */
export function ContactChips({ phone, email, clientName, outstanding }: ContactChipsProps) {
  if (!phone && !email) return null;

  const subject = encodeURIComponent(`Напоминание об оплате — ${clientName}`);
  const body = encodeURIComponent(
    `Здравствуйте!\n\nНапоминаем о наличии задолженности перед нашей компанией в размере ${formatRub(outstanding)} ₽.\n\nПросим произвести оплату в ближайшее время.\n\nС уважением, световой прокат`
  );

  return (
    <div className="inline-flex gap-1 items-center" onClick={(e) => e.stopPropagation()}>
      {phone && (
        <a
          href={`tel:${phone}`}
          aria-label="Позвонить клиенту"
          title={`Позвонить: ${phone}`}
          className="inline-flex items-center justify-center w-[28px] h-[28px] rounded border border-border bg-surface-subtle text-sm hover:bg-surface text-ink-2"
        >
          📞
        </a>
      )}
      {email && (
        <a
          href={`mailto:${email}?subject=${subject}&body=${body}`}
          aria-label="Написать клиенту"
          title={`Написать: ${email}`}
          className="inline-flex items-center justify-center w-[28px] h-[28px] rounded border border-border bg-surface-subtle text-sm hover:bg-surface text-ink-2"
        >
          ✉️
        </a>
      )}
    </div>
  );
}
