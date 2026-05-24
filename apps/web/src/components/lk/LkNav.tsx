"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/lk", label: "Дашборд" },
  { href: "/lk/bookings", label: "Заказы" },
  { href: "/lk/estimates", label: "Сметы" },
  { href: "/lk/debt", label: "Долг" },
  { href: "/lk/stats", label: "Статистика" },
  { href: "/lk/crew-calculator", label: "Команда" },
  { href: "/lk/tools", label: "Инструменты" },
];

export function LkNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap gap-x-1 gap-y-2 overflow-x-auto" aria-label="Меню кабинета">
      {items.map((it) => {
        const active =
          pathname === it.href ||
          (it.href !== "/lk" && pathname?.startsWith(it.href));
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
              active
                ? "bg-accent-bright text-surface"
                : "text-surface/80 hover:bg-surface/10"
            }`}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
