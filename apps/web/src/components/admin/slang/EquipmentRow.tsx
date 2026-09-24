"use client";

import type { DictionaryGroup } from "./types";
import { PhraseList } from "./PhraseList";

/**
 * Общая сетка шапки словаря и строк приборов. На телефоне колонки «Категория» нет —
 * категория печатается строкой под названием, чтобы числа и шеврон помещались в экран.
 */
export const DICTIONARY_GRID =
  "grid grid-cols-[minmax(0,1fr)_40px_48px_28px] gap-2 px-4 sm:grid-cols-[minmax(0,1fr)_180px_64px_64px_36px] sm:gap-3";

type Props = {
  group: DictionaryGroup;
  expanded: boolean;
  onToggle: () => void;
  onDeletePhrase: (aliasId: string) => void;
  onRebindPhrase: (oldId: string, newEqId: string, newEqName: string) => void;
};

export function EquipmentRow({ group, expanded, onToggle, onDeletePhrase, onRebindPhrase }: Props) {
  const { equipment, aliases } = group;
  const totalUsage = aliases.reduce((sum, a) => sum + a.usageCount, 0);
  const phraseCount = aliases.length;

  return (
    <>
      {/* Equipment row */}
      <div
        onClick={onToggle}
        className={[
          DICTIONARY_GRID,
          "py-2.5 border-t border-border cursor-pointer transition-colors items-center first:border-t-0",
          expanded
            ? "bg-accent-soft hover:bg-accent-soft"
            : "hover:bg-surface-muted",
        ].join(" ")}
      >
        <div className="min-w-0">
          <span className="block truncate text-[13.5px] font-medium text-ink" title={equipment.name}>
            {equipment.name}
          </span>
          <span className="block truncate text-[11.5px] text-ink-3 sm:hidden">{equipment.category}</span>
        </div>
        {/* Одна строка с многоточием: пилюля не разваливается в многострочный овал */}
        <span
          className="hidden sm:block w-fit max-w-full truncate whitespace-nowrap text-[11.5px] text-ink-2 px-2 py-0.5 rounded bg-surface-muted border border-border"
          title={equipment.category}
        >
          {equipment.category}
        </span>
        <span
          className={[
            "font-mono text-[12px] text-right",
            phraseCount >= 10 ? "text-ink font-semibold" : "text-ink-2 font-medium",
          ].join(" ")}
        >
          {phraseCount}
        </span>
        <span className="font-mono text-[12px] text-ink-2 font-medium text-right">
          {totalUsage}
        </span>
        <button
          aria-label={expanded ? "Свернуть" : "Раскрыть"}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          className={[
            "w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:bg-surface-muted hover:text-ink transition-all duration-150 text-[11px] justify-self-end",
            expanded ? "text-accent rotate-90" : "",
          ].join(" ")}
        >
          ❯
        </button>
      </div>

      {/* Expanded accordion */}
      {expanded && (
        <PhraseList
          aliases={aliases}
          equipmentId={equipment.id}
          onDelete={onDeletePhrase}
          onRebind={onRebindPhrase}
        />
      )}
    </>
  );
}
