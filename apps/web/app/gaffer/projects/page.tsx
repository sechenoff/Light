"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  listProjects,
  type GafferProject,
} from "../../../src/lib/gafferApi";
import {
  clientDebtVariant,
  teamDebtVariant,
  formatShootDate,
} from "../../../src/lib/gafferProjectUtils";

type StatusChip = "OPEN" | "ARCHIVED";

const CHIPS: { key: StatusChip; label: string }[] = [
  { key: "OPEN", label: "Активные" },
  { key: "ARCHIVED", label: "В архиве" },
];

function DebtPill({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-[8px] py-[2px] text-[10.5px] font-semibold ${colorClass}`}
      style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
    >
      {label}
    </span>
  );
}

function ProjectCard({ project }: { project: GafferProject }) {
  const clientPill = clientDebtVariant(
    project.clientTotal ?? project.clientPlanAmount ?? "0",
    project.clientRemaining ?? "0",
  );
  const teamPill = teamDebtVariant(
    project.teamPlanTotal ?? "0",
    project.teamRemaining ?? "0",
  );

  return (
    <Link
      href={`/gaffer/projects/${project.id}`}
      className="block px-4 py-3 border-b border-border hover:bg-[#fafafa] transition-colors"
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className="font-semibold text-[13.5px] text-ink leading-snug flex-1 min-w-0 truncate">
          {project.title}
        </span>
        <span className="text-[11.5px] text-ink-3 shrink-0 mt-0.5">
          {formatShootDate(project.shootDate)}
        </span>
      </div>
      {project.client && (
        <p className="text-[12px] text-ink-2 mb-2 truncate">
          {project.client.name}
        </p>
      )}
      {(clientPill || teamPill) && (
        <div className="flex flex-wrap gap-1.5">
          {clientPill && <DebtPill {...clientPill} />}
          {teamPill && <DebtPill {...teamPill} />}
        </div>
      )}
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
      <div className="flex gap-1.5">
        <div className="h-4 bg-border rounded-full w-24" />
        <div className="h-4 bg-border rounded-full w-20" />
      </div>
    </div>
  );
}

export default function GafferProjectsPage() {
  const [chip, setChip] = useState<StatusChip>("OPEN");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [projects, setProjects] = useState<GafferProject[] | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listProjects({
          status: chip,
          search: debouncedSearch || undefined,
        });
        if (!cancelled) setProjects(res.items);
      } catch {
        if (!cancelled) setProjects([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chip, debouncedSearch]);

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
      <div className="flex gap-2 px-4 py-2 border-b border-border overflow-x-auto bg-[#fafafa]">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            onClick={() => { setChip(c.key); setProjects(null); }}
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
        {projects === null ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : projects.length === 0 ? (
          <div className="text-center text-ink-3 py-10 px-4 text-[13px]">
            <div className="text-4xl mb-3">▤</div>
            <p className="mb-4">
              {chip === "ARCHIVED" ? "Архивных проектов нет" : "Проектов пока нет"}
            </p>
            {chip === "OPEN" && (
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

      {/* FAB (mobile) */}
      <Link
        href="/gaffer/projects/new"
        className="fixed bottom-20 right-4 w-12 h-12 bg-accent-bright text-white rounded-full flex items-center justify-center text-xl shadow-lg hover:bg-accent transition-colors z-30 md:hidden"
        aria-label="Создать проект"
      >
        +
      </Link>
    </div>
  );
}
