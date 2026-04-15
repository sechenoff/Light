import type { UserRole } from "./auth";

export type MenuItem = { href: string; label: string; icon?: string };

export const menuByRole: Record<UserRole, MenuItem[]> = {
  SUPER_ADMIN: [
    { href: "/day",       label: "Мой день",       icon: "home" },
    { href: "/bookings",  label: "Брони",          icon: "booking" },
    { href: "/equipment", label: "Оборудование",   icon: "gear" },
    { href: "/calendar",  label: "Календарь",      icon: "calendar" },
    { href: "/repair",    label: "Мастерская",     icon: "wrench" },
    { href: "/finance",   label: "Финансы",        icon: "money" },
    { href: "/admin",     label: "Админка",        icon: "settings" },
  ],
  WAREHOUSE: [
    { href: "/day",       label: "Мой день",     icon: "home" },
    { href: "/bookings",  label: "Брони",        icon: "booking" },
    { href: "/equipment", label: "Оборудование", icon: "gear" },
    { href: "/calendar",  label: "Календарь",    icon: "calendar" },
    { href: "/repair",    label: "Мастерская",   icon: "wrench" },
  ],
  TECHNICIAN: [
    { href: "/day",    label: "Мой день",   icon: "home" },
    { href: "/repair", label: "Мастерская", icon: "wrench" },
  ],
};
