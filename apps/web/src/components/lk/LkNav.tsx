"use client";
import { useEffect, useRef } from "react";
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
  const navRef = useRef<HTMLElement>(null);

  // На телефоне меню — прокручиваемая лента: правые пункты за краем, поэтому
  // активный пункт, если он не виден целиком, докручиваем в видимую область.
  // Именно scrollLeft, а не scrollIntoView — страница не прыгает по вертикали.
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
    const hidden = active.offsetLeft + active.offsetWidth > nav.scrollLeft + nav.clientWidth;
    if (hidden || active.offsetLeft < nav.scrollLeft) nav.scrollLeft = active.offsetLeft - 16;
  }, [pathname]);

  return (
    <nav
      ref={navRef}
      className="relative -mx-4 px-4 flex gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible"
      aria-label="Меню кабинета"
    >
      {items.map((it) => {
        const active =
          pathname === it.href ||
          (it.href !== "/lk" && pathname?.startsWith(it.href));
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 inline-flex items-center h-10 sm:h-8 px-3 rounded text-sm transition-colors ${
              active
                ? "bg-accent-bright text-surface"
                : "text-on-inverse/80 hover:bg-on-inverse/10 hover:text-on-inverse"
            }`}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
