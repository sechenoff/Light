import type { UserRole } from "../lib/auth";

type BadgeStyle = { bg: string; text: string; border: string; label: string };

const STYLES: Record<UserRole, BadgeStyle> = {
  SUPER_ADMIN: { bg: "bg-indigo-soft", text: "text-indigo", border: "border-indigo-border", label: "Руководитель" },
  WAREHOUSE:   { bg: "bg-teal-soft",   text: "text-teal",   border: "border-teal-border",   label: "Кладовщик"   },
  TECHNICIAN:  { bg: "bg-amber-soft",  text: "text-amber",  border: "border-amber-border",  label: "Техник"      },
};

export function RoleBadge({ role }: { role: UserRole }) {
  const s = STYLES[role];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-cond font-semibold uppercase tracking-wider ${s.bg} ${s.text} border ${s.border}`}
    >
      {s.label}
    </span>
  );
}
