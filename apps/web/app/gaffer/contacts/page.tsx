"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  listContacts,
  type GafferContact,
} from "../../../src/lib/gafferApi";

type FilterChip = "all" | "clients" | "team" | "archive";

const CHIPS: { key: FilterChip; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "clients", label: "Заказчики" },
  { key: "team", label: "Команда" },
  { key: "archive", label: "Архив" },
];

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function ContactCard({ contact }: { contact: GafferContact }) {
  const initials = getInitials(contact.name);
  const isArchived = contact.isArchived;
  const avatarClass =
    isArchived
      ? "bg-slate-soft text-slate border-slate-border"
      : contact.type === "CLIENT"
        ? "bg-indigo-soft text-indigo border-indigo-border"
        : "bg-teal-soft text-teal border-teal-border";
  const typePillVariant =
    contact.type === "CLIENT"
      ? { bg: "bg-indigo-soft text-indigo border-indigo-border", label: "Заказчик" }
      : { bg: "bg-teal-soft text-teal border-teal-border", label: "Команда" };

  return (
    <Link
      href={`/gaffer/contacts/${contact.id}`}
      className={`flex gap-[10px] py-3 border-b border-border items-start hover:bg-[#fafafa] transition-colors px-4 ${isArchived ? "opacity-60" : ""}`}
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
          <div className="flex gap-1 shrink-0">
            <span
              className={`inline-flex items-center rounded-full border px-[7px] py-[2px] text-[10px] font-semibold ${typePillVariant.bg}`}
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
            >
              {typePillVariant.label}
            </span>
            {isArchived && (
              <span
                className="inline-flex items-center rounded-full border px-[7px] py-[2px] text-[10px] font-semibold bg-slate-soft text-slate border-slate-border"
                style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
              >
                В архиве
              </span>
            )}
          </div>
        </div>
        {(contact.phone || contact.telegram) && (
          <div className="mt-1.5 text-[11.5px] text-ink-3 flex gap-1.5 flex-wrap">
            {contact.phone && <span>📞 {contact.phone}</span>}
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

export default function GafferContactsPage() {
  const [chip, setChip] = useState<FilterChip>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [contacts, setContacts] = useState<GafferContact[]>([]);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    let cancelled = false;
    try {
      const params: Parameters<typeof listContacts>[0] = {};
      if (chip === "clients") { params.type = "CLIENT"; params.isArchived = false; }
      else if (chip === "team") { params.type = "TEAM_MEMBER"; params.isArchived = false; }
      else if (chip === "archive") { params.isArchived = true; }
      else { params.isArchived = false; }
      if (debouncedSearch) params.search = debouncedSearch;
      const res = await listContacts(params);
      if (!cancelled) setContacts(res.items);
    } catch {
      if (!cancelled) setContacts([]);
    } finally {
      if (!cancelled) setLoading(false);
    }
    return () => { cancelled = true; };
  }, [chip, debouncedSearch]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

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

      {/* Search */}
      <div className="px-4 pb-2">
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
      <div className="flex gap-2 px-4 py-2 border-b border-border overflow-x-auto bg-[#fafafa]">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            onClick={() => setChip(c.key)}
            className={`text-[12px] font-medium px-[11px] py-[6px] rounded-full border whitespace-nowrap transition-colors ${
              chip === c.key
                ? "bg-accent text-white border-accent"
                : "bg-surface border-border text-ink-2 hover:border-accent-border"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div>
        {loading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : contacts.length === 0 ? (
          <div className="text-center text-ink-3 py-10 px-4 text-[13px]">
            <div className="text-4xl mb-3">☺</div>
            <p className="mb-4">Контактов пока нет</p>
            <Link
              href="/gaffer/contacts/new"
              className="bg-accent-bright hover:bg-accent text-white text-[13px] font-medium rounded px-4 py-2.5 transition-colors inline-block"
            >
              + Добавить первый
            </Link>
          </div>
        ) : (
          contacts.map((c) => <ContactCard key={c.id} contact={c} />)
        )}
      </div>
    </div>
  );
}
