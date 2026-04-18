"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  listContactsWithAggregates,
  getContactsSummary,
  type GafferContactWithAggregates,
  type GafferContactsSummary,
} from "../../../src/lib/gafferApi";
import { formatRub, pluralize } from "../../../src/lib/format";

// ── Types ─────────────────────────────────────────────────────────────────────

type FilterChip = "all" | "clients" | "team" | "with-debt" | "archive";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

type AvatarVariant = "archive" | "both" | "client" | "team";

function getAvatarVariant(c: GafferContactWithAggregates): AvatarVariant {
  if (c.isArchived) return "archive";
  if (c.asClientCount > 0 && c.asMemberCount > 0) return "both";
  if (c.asClientCount > 0) return "client";
  if (c.asMemberCount > 0) return "team";
  // fallback by type
  return c.type === "CLIENT" ? "client" : "team";
}

const AVATAR_CLASSES: Record<AvatarVariant, string> = {
  archive: "bg-slate-soft text-slate border-slate-border",
  both: "bg-accent-soft text-accent border-accent-border",
  client: "bg-indigo-soft text-indigo border-indigo-border",
  team: "bg-teal-soft text-teal border-teal-border",
};

// ── Contact card ──────────────────────────────────────────────────────────────

function ContactCard({ contact }: { contact: GafferContactWithAggregates }) {
  const initials = getInitials(contact.name);
  const avatarVariant = getAvatarVariant(contact);
  const avatarClass = AVATAR_CLASSES[avatarVariant];
  const isArchived = contact.isArchived;

  const remainingToMe = Number(contact.remainingToMe);
  const remainingFromMe = Number(contact.remainingFromMe);
  const hasDebt = remainingToMe > 0 || remainingFromMe > 0;

  return (
    <Link
      href={`/gaffer/contacts/${contact.id}`}
      className={`flex gap-[10px] py-3 border-b border-border items-start hover:bg-surface-2 transition-colors px-4 ${isArchived ? "opacity-60" : ""}`}
    >
      {/* Avatar */}
      <div
        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 border text-[12px] font-semibold ${avatarClass}`}
        style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif", letterSpacing: "0.4px" }}
      >
        {initials}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-semibold text-[13.5px] text-ink truncate">{contact.name}</span>
          {/* Debt amount (right side) */}
          <div className="shrink-0 text-right">
            {remainingToMe > 0 && (
              <span className="text-[12px] font-semibold text-rose mono-num">
                ↑ {formatRub(remainingToMe)}
              </span>
            )}
            {remainingFromMe > 0 && remainingToMe === 0 && (
              <span className="text-[12px] font-semibold text-indigo mono-num">
                ↓ {formatRub(remainingFromMe)}
              </span>
            )}
            {!hasDebt && contact.projectCount > 0 && (
              <span className="text-[11px] text-ink-3">сведён</span>
            )}
          </div>
        </div>

        {/* Pills */}
        <div className="flex flex-wrap gap-1 mt-1">
          {/* Type pills */}
          {!isArchived && contact.asClientCount > 0 && (
            <span
              className="inline-flex items-center rounded-full border px-[7px] py-[1px] text-[10px] font-semibold bg-indigo-soft text-indigo border-indigo-border"
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
            >
              заказчик
            </span>
          )}
          {!isArchived && contact.asMemberCount > 0 && (
            <span
              className="inline-flex items-center rounded-full border px-[7px] py-[1px] text-[10px] font-semibold bg-teal-soft text-teal border-teal-border"
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
            >
              команда
            </span>
          )}
          {!isArchived && contact.asClientCount === 0 && contact.asMemberCount === 0 && (
            <span
              className={`inline-flex items-center rounded-full border px-[7px] py-[1px] text-[10px] font-semibold ${
                contact.type === "CLIENT"
                  ? "bg-indigo-soft text-indigo border-indigo-border"
                  : "bg-teal-soft text-teal border-teal-border"
              }`}
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
            >
              {contact.type === "CLIENT" ? "заказчик" : "команда"}
            </span>
          )}
          {isArchived && (
            <span
              className="inline-flex items-center rounded-full border px-[7px] py-[1px] text-[10px] font-semibold bg-slate-soft text-slate border-slate-border"
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
            >
              В архиве
            </span>
          )}
          {contact.projectCount > 0 && (
            <span
              className="inline-flex items-center rounded-full border px-[7px] py-[1px] text-[10px] font-semibold bg-slate-soft text-slate border-slate-border"
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
            >
              {contact.projectCount} {pluralize(contact.projectCount, "проект", "проекта", "проектов")}
            </span>
          )}
        </div>

        {/* Meta line */}
        {(contact.phone || contact.telegram) && (
          <div className="mt-1 text-[11px] text-ink-3 flex gap-1.5 flex-wrap">
            {contact.phone && <span>{contact.phone}</span>}
            {contact.phone && contact.telegram && <span className="text-border">·</span>}
            {contact.telegram && <span>{contact.telegram}</span>}
          </div>
        )}
      </div>
    </Link>
  );
}

function SkeletonCard() {
  return (
    <div className="flex gap-[10px] py-3 border-b border-border items-start px-4 animate-pulse">
      <div className="w-9 h-9 rounded-full bg-border shrink-0" />
      <div className="flex-1 space-y-2 pt-1">
        <div className="h-3.5 bg-border rounded w-1/2" />
        <div className="h-3 bg-border rounded w-1/3" />
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function GafferContactsPage() {
  const [chip, setChip] = useState<FilterChip>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [allContacts, setAllContacts] = useState<GafferContactWithAggregates[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<GafferContactsSummary | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  // Load summary once (chips counts come from this)
  useEffect(() => {
    getContactsSummary().then(setSummary).catch(() => {});
  }, []);

  // Fetch all contacts (both archived and non-archived) with aggregates
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await listContactsWithAggregates({
          isArchived: "all",
          search: debouncedSearch || undefined,
        });
        if (!cancelled) setAllContacts(res.items);
      } catch {
        if (!cancelled) setAllContacts([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [debouncedSearch]);

  // Apply chip filter client-side
  const getFiltered = (): GafferContactWithAggregates[] => {
    if (!allContacts) return [];
    switch (chip) {
      case "clients":
        return allContacts.filter((c) => c.type === "CLIENT" && !c.isArchived);
      case "team":
        return allContacts.filter((c) => c.type === "TEAM_MEMBER" && !c.isArchived);
      case "with-debt":
        return allContacts.filter(
          (c) => !c.isArchived && (Number(c.remainingToMe) > 0 || Number(c.remainingFromMe) > 0),
        );
      case "archive":
        return allContacts.filter((c) => c.isArchived);
      default:
        return allContacts.filter((c) => !c.isArchived);
    }
  };

  const contacts = getFiltered();

  // Chip counts from summary
  const counts = summary?.counts;
  const CHIPS: { key: FilterChip; label: string }[] = [
    { key: "all", label: counts ? `Все · ${counts.all}` : "Все" },
    { key: "clients", label: counts ? `Заказчики · ${counts.clients}` : "Заказчики" },
    { key: "team", label: counts ? `Команда · ${counts.team}` : "Команда" },
    { key: "with-debt", label: counts ? `С долгом · ${counts.withDebt}` : "С долгом" },
    { key: "archive", label: "Архив" },
  ];

  const totals = summary?.totals;

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <h1 className="text-[17px] font-semibold text-ink tracking-tight">Контакты</h1>
        <Link
          href="/gaffer/contacts/new"
          className="bg-accent-bright hover:bg-accent text-white text-[13px] font-medium rounded px-3 py-[7px] transition-colors"
        >
          + Добавить
        </Link>
      </div>

      {/* Summary strip */}
      {totals && (Number(totals.owedToMe) > 0 || Number(totals.iOwe) > 0) && (
        <div className="grid grid-cols-2 border-y border-border">
          <div className="py-2.5 px-4 border-r border-border">
            <p className="text-[10px] text-ink-3 uppercase tracking-wider"
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
              🟢 Мне должны
            </p>
            <p className="text-[14px] font-bold text-rose mono-num">{formatRub(totals.owedToMe)}</p>
          </div>
          <div className="py-2.5 px-4">
            <p className="text-[10px] text-ink-3 uppercase tracking-wider"
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
              🔴 Я должен
            </p>
            <p className="text-[14px] font-bold text-indigo mono-num">{formatRub(totals.iOwe)}</p>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="px-4 py-2">
        <div className="relative">
          <span className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[14px] opacity-60">🔎</span>
          <input
            type="search"
            placeholder="Поиск по имени, телефону…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
          />
        </div>
      </div>

      {/* Chips filter */}
      <div className="flex gap-2 px-4 py-2 border-b border-border overflow-x-auto bg-surface-2">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            onClick={() => setChip(c.key)}
            className={`text-[12px] font-medium px-[11px] py-[6px] rounded-full border whitespace-nowrap transition-colors ${
              chip === c.key
                ? "bg-accent text-white border-accent"
                : "bg-surface border-border text-ink-2 hover:border-accent-border"
            }`}
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div>
        {loading && allContacts === null ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : contacts.length === 0 ? (
          <div className="text-center text-ink-3 py-10 px-4 text-[13px]">
            <div className="text-4xl mb-3">☺</div>
            <p className="mb-4">
              {chip === "archive" ? "Архивных контактов нет" :
               chip === "with-debt" ? "Нет контактов с долгом" :
               "Контактов пока нет"}
            </p>
            {chip === "all" && (
              <Link
                href="/gaffer/contacts/new"
                className="bg-accent-bright hover:bg-accent text-white text-[13px] font-medium rounded px-4 py-2.5 transition-colors inline-block"
              >
                + Добавить первый
              </Link>
            )}
          </div>
        ) : (
          contacts.map((c) => <ContactCard key={c.id} contact={c} />)
        )}
      </div>

      {/* Footer meta */}
      {!loading && contacts.length > 0 && (
        <div className="px-4 pt-3 pb-6 text-center text-[11px] text-ink-3">
          показано {contacts.length} из {allContacts?.length ?? contacts.length}
        </div>
      )}
    </div>
  );
}
