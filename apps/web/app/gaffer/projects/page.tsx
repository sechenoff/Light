"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  listProjects,
  type GafferProject,
} from "../../../src/lib/gafferApi";
import { formatRub, pluralize } from "../../../src/lib/format";

// Короткая дата для карточки проекта: «15 апреля» (без года, если текущий).
function formatCardDate(date: string | null | undefined): string {
  if (!date) return "";
  const d = new Date(date.includes("T") ? date : `${date}T00:00:00`);
  if (isNaN(d.getTime())) return "";
  const currentYear = new Date().getFullYear();
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === currentYear
    ? { day: "numeric", month: "long" }
    : { day: "numeric", month: "long", year: "numeric" };
  return new Intl.DateTimeFormat("ru-RU", opts).format(d);
}

// ── Chip types ────────────────────────────────────────────────────────────────

type ChipKey = "all" | "client-debt" | "team-debt" | "archive";

// ── Project card ──────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: "OPEN" | "ARCHIVED" }) {
  if (status === "OPEN") {
    return (
      <span
        className="inline-flex items-center rounded-full border px-[7px] py-[2px] text-[10px] font-semibold bg-amber-soft text-amber border-amber-border"
        style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
      >
        открыт
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full border px-[7px] py-[2px] text-[10px] font-semibold bg-slate-soft text-slate border-slate-border"
      style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
    >
      закрыт
    </span>
  );
}

function DebtTag({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-[7px] py-[2px] text-[10px] font-semibold ${colorClass}`}
      style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
    >
      {label}
    </span>
  );
}

function ProjectCard({ project }: { project: GafferProject }) {
  const clientRem = Number(project.clientRemaining ?? "0");
  const teamRem = Number(project.teamRemaining ?? "0");
  const clientTotal = project.clientTotal ?? project.clientPlanAmount ?? "0";

  const sumFrom = Number(project.clientPlanAmount) + Number(project.lightBudgetAmount ?? "0");
  const clientName = project.client?.name ?? "без клиента";

  return (
    <Link
      href={`/gaffer/projects/${project.id}`}
      className="block rounded-lg border border-border bg-surface shadow-xs px-[14px] py-3 hover:border-accent-border transition-colors"
    >
      {/* Title */}
      <h4 className="font-semibold text-[14px] text-ink leading-snug">
        {project.title}
      </h4>
      {/* Meta: client · date · sum */}
      <p className="text-[11.5px] text-ink-2 mt-0.5 truncate">
        <span>{clientName}</span>
        <span> · {formatCardDate(project.shootDate)}</span>
        {sumFrom > 0 && (
          <span> · <span className="mono-num">{formatRub(sumFrom)}</span></span>
        )}
      </p>

      {/* Metrics: 3 columns with dashed top border, no outer box */}
      <div className="flex gap-[14px] mt-2.5 pt-2.5 border-t border-dashed border-border text-[12px]">
        <div className="flex flex-col">
          <span
            className="text-[10.5px] text-ink-3 uppercase tracking-wider"
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
          >
            От клиента
          </span>
          <span className="mono-num font-semibold text-ink">
            {formatRub(clientTotal).replace(" ₽", "")}
          </span>
        </div>
        <div className="flex flex-col">
          <span
            className="text-[10.5px] text-ink-3 uppercase tracking-wider"
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
          >
            Должны мне
          </span>
          <span className={`mono-num font-semibold ${clientRem > 0 ? "text-rose" : "text-ink"}`}>
            {clientRem > 0 ? formatRub(clientRem).replace(" ₽", "") : "0"}
          </span>
        </div>
        <div className="flex flex-col">
          <span
            className="text-[10.5px] text-ink-3 uppercase tracking-wider"
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
          >
            Должен я
          </span>
          <span className={`mono-num font-semibold ${teamRem > 0 ? "text-indigo" : "text-ink"}`}>
            {teamRem > 0 ? formatRub(teamRem).replace(" ₽", "") : "0"}
          </span>
        </div>
      </div>

      {/* Status pills: solid top border separator */}
      <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pt-2.5 border-t border-border">
        <StatusPill status={project.status} />
        {clientRem > 0 && (
          <DebtTag
            label="долг клиента"
            colorClass="bg-rose-soft text-rose border-rose-border"
          />
        )}
        {teamRem > 0 && (
          <DebtTag
            label="долг команде"
            colorClass="bg-indigo-soft text-indigo border-indigo-border"
          />
        )}
      </div>
    </Link>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-lg border border-border bg-surface shadow-xs px-[14px] py-3 animate-pulse">
      <div className="h-3.5 bg-border rounded w-2/5 mb-1.5" />
      <div className="h-3 bg-border rounded w-1/2 mb-2.5" />
      <div className="flex gap-[14px] pt-2.5 border-t border-dashed border-border mb-2.5">
        <div className="h-8 bg-border rounded flex-1" />
        <div className="h-8 bg-border rounded flex-1" />
        <div className="h-8 bg-border rounded flex-1" />
      </div>
      <div className="flex gap-1.5 pt-2.5 border-t border-border">
        <div className="h-4 bg-border rounded-full w-16" />
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function GafferProjectsPage() {
  const [chip, setChip] = useState<ChipKey>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [openProjects, setOpenProjects] = useState<GafferProject[] | null>(null);
  const [archivedProjects, setArchivedProjects] = useState<GafferProject[] | null>(null);
  const [loadingOpen, setLoadingOpen] = useState(true);
  const [loadingArchive, setLoadingArchive] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  // Load OPEN projects
  useEffect(() => {
    let cancelled = false;
    setLoadingOpen(true);
    (async () => {
      try {
        const res = await listProjects({ status: "OPEN", search: debouncedSearch || undefined });
        if (!cancelled) setOpenProjects(res.items);
      } catch {
        if (!cancelled) setOpenProjects([]);
      } finally {
        if (!cancelled) setLoadingOpen(false);
      }
    })();
    return () => { cancelled = true; };
  }, [debouncedSearch]);

  // Load ARCHIVED when needed
  useEffect(() => {
    if (chip !== "archive") return;
    if (archivedProjects !== null) return;
    let cancelled = false;
    setLoadingArchive(true);
    (async () => {
      try {
        const res = await listProjects({ status: "ARCHIVED", search: debouncedSearch || undefined });
        if (!cancelled) setArchivedProjects(res.items);
      } catch {
        if (!cancelled) setArchivedProjects([]);
      } finally {
        if (!cancelled) setLoadingArchive(false);
      }
    })();
    return () => { cancelled = true; };
  }, [chip, archivedProjects, debouncedSearch]);

  // Re-fetch archive on search change
  useEffect(() => {
    setArchivedProjects(null);
  }, [debouncedSearch]);

  // Filtered projects per chip
  const getProjects = (): GafferProject[] | null => {
    if (chip === "archive") return archivedProjects;
    if (openProjects === null) return null;
    if (chip === "client-debt") return openProjects.filter((p) => Number(p.clientRemaining ?? 0) > 0);
    if (chip === "team-debt") return openProjects.filter((p) => Number(p.teamRemaining ?? 0) > 0);
    return openProjects;
  };

  const projects = getProjects();
  const isLoading = chip === "archive" ? loadingArchive && archivedProjects === null : loadingOpen;

  // Chip counts
  const allCount = openProjects?.length ?? 0;
  const clientDebtCount = openProjects?.filter((p) => Number(p.clientRemaining ?? 0) > 0).length ?? 0;
  const teamDebtCount = openProjects?.filter((p) => Number(p.teamRemaining ?? 0) > 0).length ?? 0;

  const CHIPS: { key: ChipKey; label: string }[] = [
    { key: "all", label: `Все · ${allCount}` },
    { key: "client-debt", label: `С долгом клиента · ${clientDebtCount}` },
    { key: "team-debt", label: `С долгом команде · ${teamDebtCount}` },
    { key: "archive", label: "Архив" },
  ];

  const handleChipClick = (key: ChipKey) => {
    setChip(key);
  };

  return (
    <div className="min-h-screen bg-surface">
      {/* Header — desktop only (mobile follows canon: straight into search) */}
      <div className="hidden md:flex items-center justify-between px-4 pt-4 pb-3">
        <h1 className="text-[17px] font-semibold text-ink tracking-tight">Проекты</h1>
        <Link
          href="/gaffer/projects/new"
          className="inline-flex bg-accent-bright hover:bg-accent text-white text-[13px] font-medium rounded px-3 py-[7px] transition-colors"
        >
          + Создать
        </Link>
      </div>

      {/* Search */}
      <div className="px-4 pt-4 md:pt-0 pb-2">
        <div className="relative">
          <span className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[14px] opacity-60">🔎</span>
          <input
            type="search"
            placeholder="Поиск по проекту, клиенту…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
          />
        </div>
      </div>

      {/* Chips — wrap on mobile so «Архив» не уезжает за край */}
      <div className="flex flex-wrap gap-2 px-4 py-2 border-b border-border bg-surface-2">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            onClick={() => handleChipClick(c.key)}
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

      {/* List — discrete cards with gutter */}
      <div className="px-4 pt-4 pb-[112px] md:pb-8 space-y-2.5">
        {isLoading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : projects === null || projects.length === 0 ? (
          <div className="text-center text-ink-3 py-10 text-[13px]">
            <div className="text-4xl mb-3">▤</div>
            <p className="mb-4">
              {chip === "archive" ? "Архивных проектов нет" :
               chip === "client-debt" ? "Нет проектов с долгом заказчика" :
               chip === "team-debt" ? "Нет проектов с долгом команде" :
               "Проектов пока нет"}
            </p>
            {chip === "all" && (
              <Link
                href="/gaffer/projects/new"
                className="bg-accent-bright hover:bg-accent text-white text-[13px] font-medium rounded px-4 py-2.5 transition-colors inline-block"
              >
                + Создать первый проект
              </Link>
            )}
          </div>
        ) : (
          projects.map((p) => <ProjectCard key={p.id} project={p} />)
        )}
      </div>

      {/* Counts for projects */}
      {!isLoading && projects !== null && projects.length > 0 && (
        <div className="pb-2 text-center text-[11px] text-ink-3 md:block hidden">
          {pluralize(projects.length, "проект", "проекта", "проектов")}: {projects.length}
        </div>
      )}

      {/* Bottom CTA — mobile only, above tabbar (replaces FAB, matches canon) */}
      <div className="md:hidden fixed bottom-[54px] left-0 right-0 max-w-[480px] mx-auto px-4 py-3 bg-surface border-t border-border z-30">
        <Link
          href="/gaffer/projects/new"
          className="flex items-center justify-center w-full bg-accent-bright hover:bg-accent text-white text-[14px] font-medium rounded py-3 transition-colors"
        >
          + Новый проект
        </Link>
      </div>
    </div>
  );
}
