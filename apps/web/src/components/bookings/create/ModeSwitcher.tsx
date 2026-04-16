"use client";

import type { InputMode } from "./types";

type ModeSwitcherProps = {
  mode: InputMode;
  onModeChange: (mode: InputMode) => void;
};

export function ModeSwitcher({ mode, onModeChange }: ModeSwitcherProps) {
  return (
    <div className="mx-5 mt-3">
      <div className="flex rounded-[7px] bg-surface-muted p-[3px]">
        <button
          type="button"
          onClick={() => onModeChange("ai")}
          className={
            mode === "ai"
              ? "flex-1 rounded-[5px] bg-surface py-1.5 text-center text-xs font-semibold text-ink shadow-xs"
              : "flex-1 rounded-[5px] py-1.5 text-center text-xs text-ink-3 hover:text-ink-2"
          }
        >
          🤖 AI ввод
        </button>
        <button
          type="button"
          onClick={() => onModeChange("catalog")}
          className={
            mode === "catalog"
              ? "flex-1 rounded-[5px] bg-surface py-1.5 text-center text-xs font-semibold text-ink shadow-xs"
              : "flex-1 rounded-[5px] py-1.5 text-center text-xs text-ink-3 hover:text-ink-2"
          }
        >
          📋 Каталог
        </button>
      </div>
    </div>
  );
}
