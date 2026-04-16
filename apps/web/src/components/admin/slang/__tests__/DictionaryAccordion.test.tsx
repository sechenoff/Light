import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { DictionaryAccordion } from "../DictionaryAccordion";
import type { DictionaryGroup } from "../types";

const GROUPS: DictionaryGroup[] = [
  {
    equipment: { id: "eq1", name: "Aputure NOVA P300C", category: "Led Panel" },
    aliases: [
      {
        id: "a1",
        phraseNormalized: "nova p300",
        phraseOriginal: "nova p300",
        equipmentId: "eq1",
        confidence: 1,
        source: "SEED",
        createdAt: "2026-01-01T00:00:00Z",
        usageCount: 12,
        lastUsedAt: "2026-04-01T00:00:00Z",
        equipment: { name: "Aputure NOVA P300C", category: "Led Panel" },
      },
      {
        id: "a2",
        phraseNormalized: "p300c авто",
        phraseOriginal: "p300c авто",
        equipmentId: "eq1",
        confidence: 0.9,
        source: "AUTO_LEARNED",
        createdAt: "2026-02-01T00:00:00Z",
        usageCount: 5,
        lastUsedAt: "2026-04-01T00:00:00Z",
        equipment: { name: "Aputure NOVA P300C", category: "Led Panel" },
      },
    ],
    aliasCount: 2,
  },
  {
    equipment: { id: "eq2", name: "Nanlite PavoSlim 240", category: "COB Light" },
    aliases: [
      {
        id: "a3",
        phraseNormalized: "павослим",
        phraseOriginal: "Павослим",
        equipmentId: "eq2",
        confidence: 1,
        source: "MANUAL_ADMIN",
        createdAt: "2026-01-15T00:00:00Z",
        usageCount: 3,
        lastUsedAt: "2026-03-01T00:00:00Z",
        equipment: { name: "Nanlite PavoSlim 240", category: "COB Light" },
      },
    ],
    aliasCount: 1,
  },
];

const noop = vi.fn();

describe("DictionaryAccordion", () => {
  it("renders equipment rows for each group", () => {
    render(<DictionaryAccordion groups={GROUPS} onDelete={noop} onRebind={noop} onExport={noop} />);
    expect(screen.getByText("Aputure NOVA P300C")).toBeInTheDocument();
    expect(screen.getByText("Nanlite PavoSlim 240")).toBeInTheDocument();
  });

  it("expands a row on click and shows phrases", () => {
    render(<DictionaryAccordion groups={GROUPS} onDelete={noop} onRebind={noop} onExport={noop} />);
    // Click the expand button on the first equipment row
    const expandButtons = screen.getAllByRole("button", { name: /раскрыть/i });
    fireEvent.click(expandButtons[0]);
    // Phrases appear in the expanded section
    expect(screen.getByText("nova p300")).toBeInTheDocument();
    expect(screen.getByText("p300c авто")).toBeInTheDocument();
  });

  it("filters by equipment name search", () => {
    render(<DictionaryAccordion groups={GROUPS} onDelete={noop} onRebind={noop} onExport={noop} />);
    const searchInput = screen.getByPlaceholderText(/поиск/i);
    fireEvent.change(searchInput, { target: { value: "nanlite" } });
    expect(screen.queryByText("Aputure NOVA P300C")).not.toBeInTheDocument();
    expect(screen.getByText("Nanlite PavoSlim 240")).toBeInTheDocument();
  });

  it("filters by source — auto shows only groups with at least one AUTO_LEARNED alias", () => {
    render(<DictionaryAccordion groups={GROUPS} onDelete={noop} onRebind={noop} onExport={noop} />);
    // Click "Авто" filter button
    const autoButton = screen.getByRole("button", { name: /авто/i });
    fireEvent.click(autoButton);
    // Only the group with AUTO_LEARNED alias should remain
    expect(screen.getByText("Aputure NOVA P300C")).toBeInTheDocument();
    expect(screen.queryByText("Nanlite PavoSlim 240")).not.toBeInTheDocument();
  });
});
