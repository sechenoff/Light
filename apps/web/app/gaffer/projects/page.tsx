"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  listProjects,
  type GafferProject,
} from "../../../src/lib/gafferApi";
import { formatRub, pluralize } from "../../../src/lib/format";
import {
  formatShootDate,
} from "../../../src/lib/gafferProjectUtils";

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
  const teamPlanTotal = project.teamPlanTotal ?? "0";

  const sumFrom = Number(project.clientPlanAmount) + Number(project.lightBudgetAmount ?? "0");

  return (
    <Link
      href={`/gaffer/projects/${project.id}`}
      className="block px-4 pt-3 pb-2.5 border-b border-border hover:bg-surface-2 transition-colors"
    >
      {/* Title + date */}
      <div className="flex items-start justify-between gap-2 mb-0.5">
        <h4 className="font-bold text-[13.5px] text-ink leading-snug flex-1 min-w-0">
          {project.title}
        </h4>
      </div>
      {/* Meta */}
      <p className="text-[11.5px] text-ink-3 mb-2 truncate">
        {project.client?.name && <span>{project.client.name} · </span>}
        {formatShootDate(project.shootDate)}
        {sumFrom > 0 && (
          <span> · {formatRub(sumFrom)}</span>
        )}
      </p>

      {/* Metrics 3-col */}
      <div className="grid grid-cols-3 border border-border rounded overflow-hidden mb-2 text-center">
        <div className="py-1.5 px-1 border-r border-border">
          <p className="text-[9.5px] text-ink-3 uppercase tracking-wider"
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
            От клиента
          </p>
          <p className="text-[12px] font-semibold text-ink mono-num">
            {formatRub(clientTotal)}
          </p>
        </div>
        <div className="py-1.5 px-1 border-r border-border">
          <p className="text-[9.5px] text-rose uppercase tracking-wider"
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
            Должны мне
          </p>
          <p className={`text-[12px] font-semibold mono-num ${clientRem > 0 ? "text-rose" : "text-ink-3"}`}>
            {clientRem > 0 ? formatRub(clientRem) : "—"}
          </p>
        </div>
        <div className="py-1.5 px-1">
          <p className="text-[9.5px] text-indigo uppercase tracking-wider"
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
            Должен я
          </p>
          <p className={`text-[12px] font-semibold mono-num ${teamRem > 0 ? "text-indigo" : "text-ink-3"}`}>
            {teamRem > 0 ? formatRub(teamRem) : "—"}
          </p>
        </div>
      </div>

      {/* Status tags */}
      <div className="flex flex-wrap gap-1.5">
        <StatusPill status={project.status} />
        {clientRem > 0 && (
          <DebtTag
            label={`долг клиента: ${formatRub(clientRem)}`}
            colorClass="bg-rose-soft text-rose border-rose-border"
          />
        )}
        {teamRem > 0 && (
          <DebtTag
            label={`команде: ${formatRub(Number(teamPlanTotal) > 0 ? teamRem : 0)}`}
            colorClass="bg-indigo-soft text-indigo border-indigo-border"
          />
        )}
      </div>
    </Link>
  );
}

function SkeletonCard() {
  return (
    <div className="px-4 py-3 border-b border-border animate-pulse">
      <div className="flex items-center justify-between mb-1.5">
        <div className="h-3.5 bg-border rounded w-2/5" />
        <div className="h-3 bg-border rounded w-1/5" />
      </div>
      <div className="h-3 bg-border rounded w-1/3 mb-2" />
      <div className="grid grid-cols-3 gap-1 mb-2">
        <div className="h-8 bg-border rounded" />
        <div className="h-8 bg-border rounded" />
        <div className="h-8 bg-border rounded" />
      </div>
      <div className="flex gap-1.5">
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
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <h1 className="text-[17px] font-semibold text-ink tracking-tight">Проекты</h1>
        <Link
          href="/gaffer/projects/new"
          className="bg-accent-bright hover:bg-accent text-white text-[13px] font-medium rounded px-3 py-[7px] transition-colors"
        >
          + Создать
        </Link>
      </div>

      {/* Search */}
      <div className="px-4 pb-2">
        <div className="relative">
          <span className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[14px] opacity-60">🔎</span>
          <input
            type="search"
            placeholder="Поиск по названию…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
          />
        </div>
      </div>

      {/* Chips */}
      <div className="flex gap-2 px-4 py-2 border-b border-border overflow-x-auto bg-surface-2">
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

      {/* List */}
      <div className="pb-24">
        {isLoading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : projects === null || projects.length === 0 ? (
          <div className="text-center text-ink-3 py-10 px-4 text-[13px]">
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

      {/* FAB */}
      <Link
        href="/gaffer/projects/new"
        className="fixed bottom-20 right-4 w-12 h-12 bg-accent-bright text-white rounded-full flex items-center justify-center text-xl shadow-lg hover:bg-accent transition-colors z-30 md:hidden"
        aria-label="Создать проект"
      >
        +
      </Link>

      {/* Counts for projects */}
      {!isLoading && projects !== null && projects.length > 0 && (
        <div className="pb-2 text-center text-[11px] text-ink-3">
          {pluralize(projects.length, "проект", "проекта", "проектов")}: {projects.length}
        </div>
      )}
    </div>
  );
}
