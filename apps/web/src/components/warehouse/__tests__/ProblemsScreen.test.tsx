/**
 * ProblemsScreen — экран «Поломки» в киоске: причина потеряшки всегда словами.
 *
 * Ручные потеряшки и «Пропало» из инвентаризации приходят с причиной
 * NOT_ON_SHELF — раньше строка показывала сам код. Mocks: scanApi.getProblems.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const getProblems = vi.fn();
vi.mock("../api", () => ({
  scanApi: { getProblems: () => getProblems() },
}));

import { ProblemsScreen } from "../ProblemsScreen";

function problem(overrides: Record<string, unknown>) {
  return {
    id: "p-1",
    equipmentName: "Набор зарядок",
    quantity: 1,
    reason: "LOST",
    comment: "не нашли",
    status: "SEARCHING",
    expectedBackDate: null,
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    sourceProject: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProblemsScreen — причина потеряшки", () => {
  it("«Не нашли на складе» — словами, без кода", async () => {
    getProblems.mockResolvedValue({
      repairs: [],
      problems: [problem({ reason: "NOT_ON_SHELF", quantity: 2 })],
    });
    const { container } = render(<ProblemsScreen />);

    expect(await screen.findByText(/не нашли на складе/)).toBeInTheDocument();
    expect(screen.getByText("Набор зарядок ×2")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/NOT_ON_SHELF/);
  });

  it("неизвестная причина не протекает кодом в интерфейс", async () => {
    getProblems.mockResolvedValue({
      repairs: [],
      problems: [problem({ id: "p-2", reason: "SOMETHING_NEW" })],
    });
    const { container } = render(<ProblemsScreen />);

    expect(await screen.findByText(/причина не указана/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/SOMETHING_NEW/);
  });
});
