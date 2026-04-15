import type { UserRole } from "./auth";

export type MenuItem = { href: string; label: string; icon?: string };

export const menuByRole: Record<UserRole, MenuItem[]> = {
  SUPER_ADMIN: [
    { href: "/day",       label: "Мой день",       icon: "home" },
    { href: "/bookings",  label: "Брони",          icon: "booking" },
    { href: "/equipment", label: "Оборудование",   icon: "gear" },
    { href: "/repair",    label: "Мастерская",     icon: "wrench" },
    { href: "/clients",   label: "Клиенты",        icon: "users" },
    { href: "/finance",   label: "Финансы",        icon: "money" },
    { href: "/admin",     label: "Админка",        icon: "settings" },
  ],
  WAREHOUSE: [
    { href: "/day",       label: "Мой день",     icon: "home" },
    { href: "/bookings",  label: "Брони",        icon: "booking" },
    { href: "/equipment", label: "Оборудование", icon: "gear" },
    { href: "/clients",   label: "Клиенты",      icon: "users" },
  ],
  TECHNICIAN: [
    { href: "/day",    label: "Мой день",   icon: "home" },
    { href: "/repair", label: "Мастерская", icon: "wrench" },
  ],
};
