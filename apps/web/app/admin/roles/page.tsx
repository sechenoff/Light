"use client";

import Link from "next/link";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { StatusPill } from "../../../src/components/StatusPill";
import {
  ROLE_DESCRIPTIONS,
  LEGEND_ITEMS,
  MATRIX_SECTIONS,
  EDGE_CASES,
  TECH_NOTES,
  type MatrixRow,
} from "../../../src/lib/rolesMatrix";

const ROLE_KEYS = ["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as const;

/** Цвет-акцент сверху колонки роли — индиго/тил/эмбер по токенам. */
const ROLE_STRIPE: Record<(typeof ROLE_KEYS)[number], string> = {
  SUPER_ADMIN: "bg-indigo",
  WAREHOUSE:   "bg-teal",
  TECHNICIAN:  "bg-amber",
};

const ROLE_TAG_CLS: Record<(typeof ROLE_KEYS)[number], string> = {
  SUPER_ADMIN: "bg-indigo-soft text-indigo border-indigo-border",
  WAREHOUSE:   "bg-teal-soft text-teal border-teal-border",
  TECHNICIAN:  "bg-amber-soft text-amber border-amber-border",
};

/** Почти-прозрачная заливка ячейки по роли (вместо `color-mix` из мокапа). */
const ROLE_CELL_BG: Record<(typeof ROLE_KEYS)[number], string> = {
  SUPER_ADMIN: "bg-indigo-soft/40",
  WAREHOUSE:   "bg-teal-soft/40",
  TECHNICIAN:  "bg-amber-soft/40",
};

/**
 * Минимальный inline-рендер markdown-подобной разметки из edge-case body / tech-note text.
 * Поддерживает только `**bold**` и `` `code` `` — без ссылок, без вложенности.
 */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Разбиваем по токенам **...** и `...`
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push(text.slice(lastIndex, m.index));
    }
    const token = m[0];
    if (token.startsWith("**")) {
      parts.push(<strong key={key++} className="font-semibold text-ink">{token.slice(2, -2)}</strong>);
    } else {
      parts.push(
        <code key={key++} className="font-mono text-xs bg-surface border border-border rounded px-1 py-0.5 text-ink">
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

export default function AdminRolesPage() {
  const { authorized, loading } = useRequireRole(["SUPER_ADMIN"]);
  if (loading || !authorized) return null;

  return (
    <div className="p-6 max-w-[1280px] mx-auto space-y-6 pb-16">
      {/* Хлебные крошки + заголовок */}
      <div>
        <Link href="/admin" className="eyebrow hover:text-accent transition-colors">
          ← Админка
        </Link>
        <h1 className="text-2xl font-semibold text-ink mt-2">Матрица прав</h1>
      </div>

      {/* Intro-блок */}
      <div className="bg-indigo-soft border border-indigo-border rounded-lg p-5">
        <p className="text-sm text-ink mb-2">
          Три роли: <strong className="font-semibold">Руководитель</strong>, <strong className="font-semibold">Кладовщик</strong>, <strong className="font-semibold">Техник</strong>. Логика — каждый видит ровно столько, сколько нужно для его ежедневной работы. Минимум опций в боковом меню → меньше когнитивной нагрузки + проще обучать новых сотрудников.
        </p>
        <p className="text-sm text-ink-2">
          Ниже полная матрица по разделам + легенда + обсуждение спорных мест.
        </p>
      </div>

      {/* Шапка трёх ролей */}
      <div className="grid grid-cols-[260px_1fr_1fr_1fr] bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
        <div className="p-5 bg-slate-soft border-r border-border flex items-end eyebrow">
          Раздел / Роль
        </div>
        {ROLE_KEYS.map((key) => {
          const d = ROLE_DESCRIPTIONS[key];
          return (
            <div key={key} className="relative p-5 border-r border-border last:border-r-0">
              <div className={`absolute top-0 left-0 right-0 h-[3px] ${ROLE_STRIPE[key]}`} />
              <span className={`inline-block text-[10.5px] font-cond font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${ROLE_TAG_CLS[key]} mb-2.5`}>
                {d.tag}
              </span>
              <div className="text-lg font-semibold text-ink leading-tight">{d.title}</div>
              <div className="text-[11px] font-cond font-semibold uppercase tracking-wide text-ink-3 mt-0.5 mb-2">
                {d.subtitle}
              </div>
              <p className="text-[12.5px] text-ink-2 leading-relaxed">{d.desc}</p>
              <p className="mono-num text-[11px] text-ink-3 mt-2.5">{d.count}</p>
            </div>
          );
        })}
      </div>

      {/* Легенда */}
      <div className="bg-surface border border-border rounded-lg shadow-xs px-5 py-3.5 flex flex-wrap gap-5 items-center">
        <span className="eyebrow mr-3">Обозначения</span>
        {LEGEND_ITEMS.map((item) => (
          <span key={item.level} className="inline-flex items-center gap-2 text-xs text-ink-2">
            <StatusPill variant={item.level} label={item.label} />
            {item.hint}
          </span>
        ))}
      </div>

      {/* Матрица */}
      <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
        <table className="w-full text-sm">
          <colgroup>
            <col style={{ width: "260px" }} />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th className="px-5 py-3 text-left bg-slate-soft border-b border-border eyebrow">Функция</th>
              {ROLE_KEYS.map((key) => {
                const d = ROLE_DESCRIPTIONS[key];
                const colCls =
                  key === "SUPER_ADMIN" ? "text-indigo"
                : key === "WAREHOUSE"   ? "text-teal"
                                        : "text-amber";
                return (
                  <th key={key} className={`px-5 py-3 text-center bg-slate-soft border-b border-border eyebrow ${colCls} border-r border-border last:border-r-0`}>
                    {d.title}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {MATRIX_SECTIONS.map((section) => (
              <SectionRows key={section.title} section={section} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Спорные места */}
      <div className="bg-surface border border-border rounded-lg shadow-xs p-6">
        <h2 className="text-base font-semibold text-ink mb-4">Спорные места — где важно договориться на берегу</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {EDGE_CASES.map((c) => (
            <div key={c.scenario} className="border border-border rounded p-4 bg-surface">
              <div className="eyebrow text-accent mb-1.5">{c.scenario}</div>
              <div className="text-sm font-semibold text-ink mb-1">{c.title}</div>
              <div className="text-[12.5px] text-ink-2 leading-relaxed">{renderInline(c.body)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Тех-заметки */}
      <div className="bg-slate-soft border border-border rounded-lg p-5 text-[12.5px] text-ink-2 leading-relaxed">
        <h3 className="text-sm font-semibold text-ink mb-2.5">Техническая реализация</h3>
        <ul className="list-disc ml-5 space-y-1.5">
          {TECH_NOTES.map((note, i) => (
            <li key={i}>{renderInline(note.text)}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Одна секция: заголовок + строки. Вынесено ради удобства. */
function SectionRows({ section }: { section: typeof MATRIX_SECTIONS[number] }) {
  return (
    <>
      <tr>
        <td colSpan={4} className="bg-slate-soft/60 border-y border-border px-5 py-2.5 eyebrow text-ink">
          {section.title}
          {section.hint && (
            <span className="font-sans font-normal normal-case tracking-normal text-[11.5px] text-ink-2 ml-3">
              {section.hint}
            </span>
          )}
        </td>
      </tr>
      {section.rows.map((row, i) => (
        <MatrixTableRow key={`${section.title}-${i}`} row={row} />
      ))}
    </>
  );
}

function MatrixTableRow({ row }: { row: MatrixRow }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="px-5 py-3 align-middle">
        <div className="text-sm font-medium text-ink">{row.capability}</div>
        {row.hint && <div className="text-[11.5px] text-ink-3 mt-0.5">{row.hint}</div>}
      </td>
      {ROLE_KEYS.map((key) => {
        const roleKey = key === "SUPER_ADMIN" ? "super" : key === "WAREHOUSE" ? "warehouse" : "technician";
        const cell = row[roleKey];
        return (
          <td key={key} className={`px-5 py-3 text-center align-middle border-l border-border last:border-r-0 ${ROLE_CELL_BG[key]}`}>
            <StatusPill variant={cell.level} label={cell.label} />
          </td>
        );
      })}
    </tr>
  );
}
