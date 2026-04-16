"use client";

import type { DictionaryGroup } from "./types";
import { PhraseList } from "./PhraseList";

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
          "grid gap-3 px-4 py-2.5 border-t border-border cursor-pointer transition-colors items-center first:border-t-0",
          expanded
            ? "bg-accent-soft hover:bg-accent-soft"
            : "hover:bg-surface-muted",
        ].join(" ")}
        style={{ gridTemplateColumns: "minmax(0,1fr) 120px 80px 80px 36px" }}
      >
        <span
          className="text-[13.5px] font-medium text-ink overflow-hidden text-ellipsis whitespace-nowrap min-w-0"
          title={equipment.name}
        >
          {equipment.name}
        </span>
        <span className="text-[11.5px] text-ink-2 font-normal inline-flex px-2.5 py-0.5 rounded-full bg-surface-muted border border-border w-fit">
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
