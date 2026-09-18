"use client";

/**
 * Счёт инвентаризации в киоске (`?tab=count`). Спека §7 «Киоск», мокап
 * docs/mockups/problem-items-v2/final-inventory.html — «Киоск · считаем полку».
 *
 * Не отдельная вкладка: вход — карточка на «Смене», в навигации подсвечена
 * «Смена». Два шага:
 *  1. участок — список категорий с прогрессом (StockCountCategoryList);
 *  2. строки участка — карточки StockCountLineCard, подвал «расхождений ·
 *     сошлось · Пауза». «Пауза» и «назад» возвращают к участкам.
 *
 * Киоск только считает: решения по расхождениям, завершение и отмена —
 * у руководителя на десктопе.
 */

import { useCallback, useState } from "react";
import {
  WorkstationShell,
  type WorkstationShellProps,
} from "./WorkstationShell";
import type { StockCountDetail } from "../inventory/types";
import { StockCountCategoryList } from "./StockCountCategoryList";
import { StockCountLineCard } from "./StockCountLineCard";
import { useStockCountKiosk, type StockCountKiosk } from "./StockCountKiosk";
import { summarizeLines } from "./StockCountFormat";

/** Общие для всех экранов киоска пропсы каркаса (навигация, работник, выход). */
export type StockCountShellProps = Pick<
  WorkstationShellProps,
  "tab" | "onTab" | "badges" | "workerName" | "onLogout"
>;

const SECTION_EYEBROW = "Склад · Инвентаризация";

function progressLabel(done: number, total: number): string {
  return `Посчитано ${done} из ${total}`;
}

function Skeleton() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-3 py-3 lg:px-5 lg:py-4" aria-busy="true">
      {[72, 96, 96, 72].map((h, i) => (
        <div
          key={i}
          className="animate-pulse rounded-lg bg-surface-subtle"
          style={{ height: h }}
        />
      ))}
      <span className="sr-only">Загрузка…</span>
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-center">
      <p role="alert" className="max-w-sm text-sm text-rose">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-[44px] rounded border border-border-strong bg-surface px-4 text-sm font-medium hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright"
      >
        Повторить
      </button>
    </div>
  );
}

function EndedPanel({ message, onExit }: { message: string; onExit: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12 text-center">
      <p role="alert" className="max-w-sm text-[14px] leading-snug text-ink">
        {message}
      </p>
      <button
        type="button"
        onClick={onExit}
        className="min-h-[44px] rounded bg-accent-bright px-5 text-sm font-semibold text-surface transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        Вернуться на «Смену»
      </button>
    </div>
  );
}

function CategoryLines({
  kiosk,
  activeLineId,
  onActivate,
  openIds,
  keepOpen,
  letClose,
  onPause,
}: {
  kiosk: StockCountKiosk;
  activeLineId: string | null;
  onActivate: (lineId: string | null) => void;
  /** Посчитанные карточки, которые остаются раскрытыми (правят степпером). */
  openIds: ReadonlySet<string>;
  keepOpen: (lineId: string) => void;
  letClose: (lineId: string) => void;
  onPause: () => void;
}) {
  const { lines, linesError } = kiosk;
  if (linesError) return <ErrorPanel message={linesError} onRetry={kiosk.reloadLines} />;
  if (!lines) return <Skeleton />;
  if (lines.length === 0) {
    return (
      <p className="px-4 py-12 text-center text-sm text-ink-3">
        На этом участке нечего считать.
      </p>
    );
  }

  const firstUncounted = lines.find((l) => l.countedQty == null)?.id ?? null;
  const currentId = activeLineId ?? firstUncounted;
  const s = summarizeLines(lines);
  const noDiff = s.shortageQty === 0 && s.surplusQty === 0;

  return (
    <div className="flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-2 px-2.5 py-2.5 lg:px-5 lg:py-4">
        {lines.map((line) => (
          <StockCountLineCard
            key={line.id}
            line={line}
            current={line.id === currentId}
            compact={line.countedQty != null && !openIds.has(line.id)}
            saving={kiosk.savingIds.has(line.id)}
            error={kiosk.lineErrors[line.id] ?? null}
            onCount={(qty, mode) => {
              // Карточка, которую правят степпером или вводом, остаётся раскрытой
              // до «Паузы» или до повторного входа в участок — касание по другой
              // строке не сворачивает её, и раскладка не прыгает под пальцем
              // (на iOS нет scroll anchoring). Большие кнопки сворачивают свою
              // карточку и подсвечивают следующую непосчитанную.
              if (mode === "debounced") {
                keepOpen(line.id);
                onActivate(line.id);
              } else {
                letClose(line.id);
                onActivate(null);
              }
              kiosk.count(line.id, qty, mode);
            }}
            onReset={() => {
              keepOpen(line.id);
              onActivate(line.id);
              kiosk.reset(line.id);
            }}
          />
        ))}
      </div>
      {/* Над нижним таб-баром на телефоне (52 px + safe area), у края на десктопе. */}
      <footer className="sticky bottom-[calc(52px_+_env(safe-area-inset-bottom))] z-20 border-t border-border bg-surface lg:bottom-0">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3 px-3.5 py-1.5 text-[12.5px] text-ink-2">
          <span>
            расхождений{" "}
            {noDiff ? (
              "нет"
            ) : (
              <>
                {s.shortageQty > 0 && (
                  <b className="mono-num text-rose">−{s.shortageQty}</b>
                )}
                {s.shortageQty > 0 && s.surplusQty > 0 && " / "}
                {s.surplusQty > 0 && (
                  <b className="mono-num text-emerald">+{s.surplusQty}</b>
                )}
              </>
            )}{" "}
            · сошлось <b className="mono-num text-ink">{s.matched}</b>
          </span>
          <button
            type="button"
            onClick={onPause}
            className="min-h-[44px] rounded px-3 font-semibold text-accent-bright hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright"
          >
            Пауза
          </button>
        </div>
      </footer>
    </div>
  );
}

export function StockCountScreen({
  shell,
  workerName,
  initial,
  onExit,
  onUnauth,
}: {
  shell: StockCountShellProps;
  /** Кто считает — в шапке «Инвентаризация № N · Иван». */
  workerName: string;
  /** Инвентаризация, уже загруженная для «Смены», — чтобы не мигать загрузкой. */
  initial?: StockCountDetail | null;
  /** Назад на «Смену». */
  onExit: () => void;
  /** 401 — снова вход по PIN. */
  onUnauth: () => void;
}) {
  const kiosk = useStockCountKiosk({ initial, onUnauth });
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  // Раскрытость посчитанной карточки не привязана к activeLineId: иначе касание
  // степпера на следующей строке сворачивало бы предыдущую (≈70 px) прямо над ней.
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const keepOpen = useCallback((id: string) => {
    setOpenIds((p) => (p.has(id) ? p : new Set(p).add(id)));
  }, []);
  const letClose = useCallback((id: string) => {
    setOpenIds((p) => {
      if (!p.has(id)) return p;
      const next = new Set(p);
      next.delete(id);
      return next;
    });
  }, []);

  if (kiosk.ended) {
    return (
      <WorkstationShell
        {...shell}
        eyebrow={SECTION_EYEBROW}
        title="Инвентаризация"
        onBack={onExit}
        detail={<EndedPanel message={kiosk.ended} onExit={onExit} />}
      />
    );
  }

  const detail = kiosk.detail;
  if (!detail) {
    return (
      <WorkstationShell
        {...shell}
        eyebrow={SECTION_EYEBROW}
        title="Инвентаризация"
        onBack={onExit}
        detail={
          kiosk.detailError ? (
            <ErrorPanel message={kiosk.detailError} onRetry={kiosk.reloadDetail} />
          ) : (
            <Skeleton />
          )
        }
      />
    );
  }

  // ── Шаг 1: участки ─────────────────────────────────────────────────────────
  if (!kiosk.category) {
    const { counted, lines } = detail.totals;
    return (
      <WorkstationShell
        {...shell}
        eyebrow={SECTION_EYEBROW}
        title={`Инвентаризация № ${detail.number}`}
        titleTag={`${counted} / ${lines}`}
        headerProgress={{ done: counted, total: lines, label: progressLabel(counted, lines) }}
        onBack={onExit}
        detail={
          <StockCountCategoryList
            detail={detail}
            onOpen={(category) => {
              setActiveLineId(null);
              setOpenIds(new Set());
              kiosk.openCategory(category);
            }}
          />
        }
      />
    );
  }

  // ── Шаг 2: строки участка ──────────────────────────────────────────────────
  const pause = () => {
    setActiveLineId(null);
    setOpenIds(new Set());
    kiosk.closeCategory();
  };
  // Пока строки грузятся — прогресс участка из сводки инвентаризации.
  const fromDetail = detail.categoryProgress.find((c) => c.category === kiosk.category);
  const live = kiosk.lines ? summarizeLines(kiosk.lines) : null;
  const done = live?.counted ?? fromDetail?.counted ?? 0;
  const total = live?.lines ?? fromDetail?.lines ?? 0;

  return (
    <WorkstationShell
      {...shell}
      eyebrow={`Инвентаризация № ${detail.number} · ${workerName}`}
      title={kiosk.category}
      titleTag={`${done} / ${total}`}
      headerProgress={{ done, total, label: progressLabel(done, total) }}
      onBack={pause}
      detail={
        <CategoryLines
          kiosk={kiosk}
          activeLineId={activeLineId}
          onActivate={setActiveLineId}
          openIds={openIds}
          keepOpen={keepOpen}
          letClose={letClose}
          onPause={pause}
        />
      }
    />
  );
}
