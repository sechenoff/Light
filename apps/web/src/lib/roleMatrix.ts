import type { UserRole } from "./auth";

export type MenuItem = { href: string; label: string; icon?: string };

/**
 * Куда вести роль «по умолчанию»: у всех это «Мой день», а у взыскания —
 * сам реестр долгов. Сотруднику, у которого одна задача, промежуточный экран
 * не нужен, а `/day` для него просто пуст.
 */
export function homeForRole(role: UserRole): string {
  return role === "COLLECTOR" ? "/finance/debts" : "/day";
}
export type MenuSection = { title: string; items: MenuItem[] };

export const menuByRole: Record<UserRole, MenuSection[]> = {
  // MD-3: 9 секций (5 из них — по одному пункту) слиты в 6, чтобы меню
  // помещалось на экран ноутбука. «Клиенты» подняты в рабочую зону
  // «Бронирование» (базовая сущность менеджера, а не служебный инструмент).
  // «Архив» — нейтральная иконка документа вместо тревожного alert.
  SUPER_ADMIN: [
    {
      title: "Главное",
      items: [
        { href: "/day", label: "Мой день", icon: "home" },
        { href: "/tasks?filter=my", label: "Мои задачи", icon: "tasks" },
        { href: "/tasks/archive", label: "Архив задач", icon: "invoice" },
      ],
    },
    {
      title: "Склад",
      items: [
        { href: "/warehouse/scan", label: "Выдачи и возвраты", icon: "scan" },
        { href: "/warehouse/problems", label: "Потеряшки", icon: "alert" },
        { href: "/warehouse/inventory", label: "Инвентаризация", icon: "tasks" },
      ],
    },
    {
      title: "Бронирование",
      items: [
        { href: "/bookings", label: "Список броней", icon: "booking" },
        { href: "/bookings/new", label: "Новая бронь", icon: "plus" },
        { href: "/calendar", label: "Календарь", icon: "calendar" },
        { href: "/admin/clients", label: "Клиенты", icon: "people" },
        { href: "/equipment", label: "Оборудование", icon: "gear" },
        { href: "/bookings/archive", label: "Архив", icon: "invoice" },
      ],
    },
    {
      title: "Мастерская",
      items: [
        { href: "/repair", label: "Ремонты", icon: "wrench" },
        { href: "/vehicles", label: "Автопарк", icon: "truck" },
      ],
    },
    {
      title: "Финансы",
      items: [
        { href: "/finance", label: "Обзор", icon: "money" },
        { href: "/finance/invoices", label: "Счета по броням", icon: "invoice" },
        { href: "/finance/bills", label: "Счета на оплату", icon: "invoice" },
        { href: "/finance/payments", label: "Платежи", icon: "receipt" },
        { href: "/finance/debts", label: "Долги", icon: "alert" },
        { href: "/finance/expenses", label: "Расходы", icon: "expense" },
      ],
    },
    {
      title: "Система",
      items: [
        { href: "/admin/equipment-stats", label: "Статистика техники", icon: "chart" },
        { href: "/settings/organization", label: "Организация", icon: "settings" },
        { href: "/admin", label: "Админка", icon: "settings" },
        { href: "/crew-calculator", label: "Калькулятор", icon: "calc" },
        { href: "/feedback", label: "Обратная связь", icon: "feedback" },
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
        { href: "/tasks?filter=my", label: "Мои задачи", icon: "tasks" },
        { href: "/tasks/archive", label: "Архив задач", icon: "invoice" },
      ],
    },
    {
      title: "Склад",
      items: [
        { href: "/warehouse/scan", label: "Выдачи и возвраты", icon: "scan" },
        { href: "/warehouse/problems", label: "Потеряшки", icon: "alert" },
        { href: "/warehouse/inventory", label: "Инвентаризация", icon: "tasks" },
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
        { href: "/vehicles", label: "Автопарк", icon: "truck" },
      ],
    },
    {
      // L1: WAREHOUSE видит счета в режиме read-only (без CTAs создания/выпуска/аннулирования)
      title: "Финансы",
      items: [
        { href: "/finance/invoices", label: "Счета по броням", icon: "invoice" },
      ],
    },
    {
      title: "Система",
      items: [
        { href: "/feedback", label: "Обратная связь", icon: "feedback" },
      ],
    },
  ],
  // Взыскание долгов: одна задача — один раздел. Всё остальное этой роли
  // не просто не нужно, а противопоказано: у неё на руках контакты клиентов.
  COLLECTOR: [
    {
      title: "Взыскание",
      items: [
        { href: "/finance/debts", label: "Реестр долгов", icon: "alert" },
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
        { href: "/tasks?filter=my", label: "Мои задачи", icon: "tasks" },
        { href: "/tasks/archive", label: "Архив задач", icon: "invoice" },
      ],
    },
    {
      title: "Мастерская",
      items: [
        { href: "/repair", label: "Ремонты", icon: "wrench" },
        { href: "/vehicles", label: "Автопарк", icon: "truck" },
      ],
    },
    {
      title: "Каталог",
      items: [
        { href: "/equipment", label: "Оборудование", icon: "gear" },
      ],
    },
    {
      title: "Система",
      items: [
        { href: "/feedback", label: "Обратная связь", icon: "feedback" },
      ],
    },
  ],
};
