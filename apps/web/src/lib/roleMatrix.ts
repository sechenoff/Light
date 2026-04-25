import type { UserRole } from "./auth";

export type MenuItem = { href: string; label: string; icon?: string };
export type MenuSection = { title: string; items: MenuItem[] };

export const menuByRole: Record<UserRole, MenuSection[]> = {
  SUPER_ADMIN: [
    {
      title: "Главное",
      items: [
        { href: "/day", label: "Мой день", icon: "home" },
      ],
    },
    {
      title: "Задачи",
      items: [
        { href: "/tasks", label: "Мои задачи", icon: "tasks" },
      ],
    },
    {
      title: "Склад",
      items: [
        { href: "/warehouse/scan", label: "Выдачи и возвраты", icon: "scan" },
      ],
    },
    {
      title: "Бронирование",
      items: [
        { href: "/bookings", label: "Список броней", icon: "booking" },
        { href: "/bookings/new", label: "Новая бронь", icon: "plus" },
        { href: "/calendar", label: "Календарь", icon: "calendar" },
      ],
    },
    {
      title: "Каталог",
      items: [
        { href: "/equipment", label: "Оборудование", icon: "gear" },
      ],
    },
    {
      title: "Мастерская",
      items: [
        { href: "/repair", label: "Ремонты", icon: "wrench" },
      ],
    },
    {
      title: "Финансы",
      items: [
        { href: "/finance", label: "Обзор", icon: "money" },
        { href: "/finance/invoices", label: "Счета", icon: "invoice" },
        { href: "/finance/payments", label: "Платежи", icon: "receipt" },
        { href: "/finance/debts", label: "Дебиторка", icon: "alert" },
        { href: "/finance/expenses", label: "Расходы", icon: "expense" },
      ],
    },
    {
      title: "Настройки",
      items: [
        { href: "/settings/organization", label: "Организация", icon: "settings" },
      ],
    },
    {
      title: "Система",
      items: [
        { href: "/admin", label: "Админка", icon: "settings" },
        { href: "/admin/clients", label: "Клиенты", icon: "people" },
        { href: "/crew-calculator", label: "Калькулятор", icon: "calc" },
      ],
    },
  ],
  WAREHOUSE: [
    {
      title: "Главное",
      items: [
        { href: "/day", label: "Мой день", icon: "home" },
      ],
    },
    {
      title: "Задачи",
      items: [
        { href: "/tasks", label: "Мои задачи", icon: "tasks" },
      ],
    },
    {
      title: "Склад",
      items: [
        { href: "/warehouse/scan", label: "Выдачи и возвраты", icon: "scan" },
      ],
    },
    {
      title: "Бронирование",
      items: [
        { href: "/bookings", label: "Список броней", icon: "booking" },
        { href: "/bookings/new", label: "Новая бронь", icon: "plus" },
        { href: "/calendar", label: "Календарь", icon: "calendar" },
      ],
    },
    {
      title: "Каталог",
      items: [
        { href: "/equipment", label: "Оборудование", icon: "gear" },
      ],
    },
    {
      title: "Мастерская",
      items: [
        { href: "/repair", label: "Ремонты", icon: "wrench" },
      ],
    },
    {
      // L1: WAREHOUSE видит счета в режиме read-only (без CTAs создания/выпуска/аннулирования)
      title: "Финансы",
      items: [
        { href: "/finance/invoices", label: "Счета", icon: "invoice" },
      ],
    },
  ],
  TECHNICIAN: [
    {
      title: "Главное",
      items: [
        { href: "/day", label: "Мой день", icon: "home" },
      ],
    },
    {
      title: "Задачи",
      items: [
        { href: "/tasks", label: "Мои задачи", icon: "tasks" },
      ],
    },
    {
      title: "Мастерская",
      items: [
        { href: "/repair", label: "Ремонты", icon: "wrench" },
      ],
    },
    {
      title: "Каталог",
      items: [
        { href: "/equipment", label: "Оборудование", icon: "gear" },
      ],
    },
  ],
};
