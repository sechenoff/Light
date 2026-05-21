import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AddonSearch } from "../AddonSearch";
import { scanApi } from "../api";
import type { AddonResult, ScanApiError } from "../types";

// Fake timers so the ≈300ms debounce is deterministic. `shouldAdvanceTime`
// keeps @testing-library's waitFor/findBy progressing (they poll on timers)
// while `advanceTimersByTime` still lets us jump the debounce explicitly.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function freeResult(over: Partial<AddonResult> = {}): AddonResult {
  return {
    equipmentId: "eq-free",
    name: "Dedolight DLED4",
    category: "Свет",
    availableQuantity: 3,
    availability: "AVAILABLE",
    conflict: null,
    ...over,
  };
}

function conflictedResult(over: Partial<AddonResult> = {}): AddonResult {
  return {
    equipmentId: "eq-busy",
    name: "Astera Titan Tube",
    category: "Свет",
    availableQuantity: 0,
    availability: "UNAVAILABLE",
    conflict: {
      bookingId: "b-1039",
      bookingNo: "#1039",
      projectName: "Клип Maxi",
      from: "2026-05-22T00:00:00.000Z",
      to: "2026-05-24T00:00:00.000Z",
      freeFrom: "2026-05-24T00:00:00.000Z",
    },
    ...over,
  };
}

/** Advance past the debounce and flush the search promise microtasks. */
async function settleSearch() {
  await act(async () => {
    vi.advanceTimersByTime(350);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function type(value: string) {
  const input = screen.getByLabelText("Поиск артикула по каталогу");
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

describe("AddonSearch", () => {
  it("debounces input and calls addonSearch once with the trimmed query", async () => {
    const searchSpy = vi
      .spyOn(scanApi, "addonSearch")
      .mockResolvedValue([freeResult()]);

    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );

    await type("ded");
    await type("dedo");
    await type("dedolight");
    // Not called yet — still within the debounce window.
    expect(searchSpy).not.toHaveBeenCalled();

    await settleSearch();

    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledWith("s1", "dedolight");
    expect(
      await screen.findByText("Dedolight DLED4"),
    ).toBeInTheDocument();
  });

  it("shows empty state when nothing is found", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([]);
    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );
    await type("zzz");
    await settleSearch();
    expect(screen.getByText("Ничего не найдено")).toBeInTheDocument();
  });

  it("available row → opens qty picker; confirming with default qty=1 fires addItem(qty=1)", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([freeResult()]);
    const addSpy = vi
      .spyOn(scanApi, "addItem")
      .mockResolvedValue({ bookingItemId: "bi-9" });
    const onAdded = vi.fn();

    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={onAdded}
        onClose={() => {}}
      />,
    );
    await type("dedo");
    await settleSearch();

    // Tap free row → picker opens (NOT immediate add).
    const row = screen.getByRole("button", {
      name: /Dedolight DLED4 — свободно, выбрать количество и добавить/,
    });
    await act(async () => {
      row.click();
      await Promise.resolve();
    });
    expect(addSpy).not.toHaveBeenCalled();
    expect(
      screen.getByRole("spinbutton", { name: /Количество для добавления/ }),
    ).toBeInTheDocument();

    // Confirm with default qty=1.
    await act(async () => {
      screen
        .getByRole("button", { name: /Добавить 1 шт Dedolight/ })
        .click();
      await Promise.resolve();
    });

    expect(addSpy).toHaveBeenCalledWith("s1", "eq-free", 1, undefined);
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("bi-9", false));
    expect(
      await screen.findByText(/Dedolight DLED4 добавлен в выдачу/),
    ).toBeInTheDocument();
  });

  it("success-line after add shows «Открыть PDF доб-сметы →» link with bookingId-based URL", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([freeResult()]);
    vi.spyOn(scanApi, "addItem").mockResolvedValue({ bookingItemId: "bi-9" });

    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );
    await type("dedo");
    await settleSearch();

    // Open qty picker + confirm with qty=1
    await act(async () => {
      screen
        .getByRole("button", { name: /свободно, выбрать количество/ })
        .click();
      await Promise.resolve();
    });
    await act(async () => {
      screen.getByRole("button", { name: /Добавить 1 шт/ }).click();
      await Promise.resolve();
    });

    // PDF link visible
    const pdfLink = await screen.findByRole("link", { name: /Открыть PDF/ });
    expect(pdfLink).toBeInTheDocument();
    expect(pdfLink.getAttribute("href")).toBe(
      "/api/addon-estimates/b-test/export/pdf",
    );
    expect(pdfLink.getAttribute("target")).toBe("_blank");
  });

  it("qty picker: +/+ steppers bump count, «Добавить N» POSTs with chosen N", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([
      freeResult({ availableQuantity: 19 }),
    ]);
    const addSpy = vi
      .spyOn(scanApi, "addItem")
      .mockResolvedValue({ bookingItemId: "bi-10x" });
    const onAdded = vi.fn();

    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={onAdded}
        onClose={() => {}}
      />,
    );
    await type("dedo");
    await settleSearch();

    await act(async () => {
      screen
        .getByRole("button", { name: /свободно, выбрать количество/ })
        .click();
      await Promise.resolve();
    });

    const plus = screen.getByRole("button", { name: /Увеличить количество/ });
    // 1 → 10 (nine +).
    for (let i = 0; i < 9; i++) {
      await act(async () => {
        plus.click();
        await Promise.resolve();
      });
    }
    expect(
      screen.getByRole("spinbutton", { name: /Количество для добавления/ }),
    ).toHaveValue(10);

    await act(async () => {
      screen.getByRole("button", { name: /Добавить 10 шт Dedolight/ }).click();
      await Promise.resolve();
    });
    expect(addSpy).toHaveBeenCalledWith("s1", "eq-free", 10, undefined);
    await waitFor(() =>
      expect(onAdded).toHaveBeenCalledWith("bi-10x", false),
    );
    // Success line includes «×10» for clarity.
    expect(
      await screen.findByText(/Dedolight DLED4 ×10 добавлен в выдачу/),
    ).toBeInTheDocument();
  });

  it("qty picker clamps to availableMax and never below 1", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([
      freeResult({ availableQuantity: 2 }),
    ]);
    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );
    await type("dedo");
    await settleSearch();

    await act(async () => {
      screen
        .getByRole("button", { name: /свободно, выбрать количество/ })
        .click();
      await Promise.resolve();
    });

    const input = screen.getByRole("spinbutton", {
      name: /Количество для добавления/,
    });
    const plus = screen.getByRole("button", { name: /Увеличить количество/ });
    const minus = screen.getByRole("button", { name: /Уменьшить количество/ });

    // Press + three times — clamp to availableMax = 2.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        plus.click();
        await Promise.resolve();
      });
    }
    expect(input).toHaveValue(2);
    // + is disabled at max.
    expect(plus).toBeDisabled();

    // Press − to go back to 1; − becomes disabled at floor.
    await act(async () => {
      minus.click();
      await Promise.resolve();
    });
    expect(input).toHaveValue(1);
    expect(minus).toBeDisabled();
  });

  it("qty picker «Отмена» (×) closes the picker without POSTing", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([freeResult()]);
    const addSpy = vi.spyOn(scanApi, "addItem");
    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );
    await type("dedo");
    await settleSearch();

    await act(async () => {
      screen
        .getByRole("button", { name: /свободно, выбрать количество/ })
        .click();
      await Promise.resolve();
    });
    expect(
      screen.getByRole("spinbutton", { name: /Количество для добавления/ }),
    ).toBeInTheDocument();

    await act(async () => {
      screen.getByRole("button", { name: /Отмена — закрыть выбор/ }).click();
      await Promise.resolve();
    });
    expect(
      screen.queryByRole("spinbutton", { name: /Количество для добавления/ }),
    ).not.toBeInTheDocument();
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("renders availability pills: «свободно ×K» emerald and «занято» rose", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([
      freeResult(),
      conflictedResult(),
    ]);
    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );
    await type("a");
    await settleSearch();

    const free = screen.getByText("свободно ×3");
    expect(free).toBeInTheDocument();
    expect(free.className).toMatch(/bg-emerald-soft/);
    expect(free.className).toMatch(/text-emerald/);

    const busy = screen.getByText("занято");
    expect(busy).toBeInTheDocument();
    expect(busy.className).toMatch(/bg-rose-soft/);
    expect(busy.className).toMatch(/text-rose/);
  });

  it("conflicted row shows the warn card and does NOT add until «Выдать под ответственность»", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([conflictedResult()]);
    const addSpy = vi
      .spyOn(scanApi, "addItem")
      .mockResolvedValue({ bookingItemId: "bi-x" });
    const onAdded = vi.fn();

    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={onAdded}
        onClose={() => {}}
      />,
    );
    await type("astera");
    await settleSearch();

    const row = screen.getByRole("button", {
      name: /Astera Titan Tube — занят, открыть предупреждение/,
    });
    await act(async () => {
      row.click();
      await Promise.resolve();
    });

    // Warn card content: title, booking no, project, dates, free-from.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByText(/Astera Titan Tube занят/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Бронь #1039 «Клип Maxi» · 22\.05–24\.05/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Свободно с 24\.05/)).toBeInTheDocument();
    expect(
      screen.getByText("Конфликт зафиксируется в аудите"),
    ).toBeInTheDocument();
    // NOT added yet.
    expect(addSpy).not.toHaveBeenCalled();

    const force = screen.getByRole("button", {
      name: /Выдать Astera Titan Tube под ответственность/,
    });
    await act(async () => {
      force.click();
      await Promise.resolve();
    });

    expect(addSpy).toHaveBeenCalledWith("s1", "eq-busy", 1, true);
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("bi-x", true));
  });

  it("«Отмена» dismisses the warn card without adding", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([conflictedResult()]);
    const addSpy = vi.spyOn(scanApi, "addItem");

    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );
    await type("astera");
    await settleSearch();

    await act(async () => {
      screen
        .getByRole("button", { name: /занят, открыть предупреждение/ })
        .click();
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await act(async () => {
      screen
        .getByRole("button", { name: /Отмена — не добавлять/ })
        .click();
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("409 ADDON_CONFLICT on confirm-with-qty surfaces warn card, preserves qty for force-add", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([
      freeResult({ availableQuantity: 5 }),
    ]);
    const raceErr: ScanApiError = {
      status: 409,
      code: "ADDON_CONFLICT",
      message: "busy",
      details: {
        bookingId: "b-2",
        bookingNo: "#1050",
        projectName: "Сериал Дом",
        from: "2026-05-21T00:00:00.000Z",
        to: "2026-05-23T00:00:00.000Z",
        freeFrom: "2026-05-23T00:00:00.000Z",
      },
    };
    const addSpy = vi
      .spyOn(scanApi, "addItem")
      .mockRejectedValueOnce(raceErr)
      .mockResolvedValueOnce({ bookingItemId: "bi-after-ack" });
    const onAdded = vi.fn();

    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={onAdded}
        onClose={() => {}}
      />,
    );
    await type("dedo");
    await settleSearch();

    // Tap free row → picker.
    await act(async () => {
      screen
        .getByRole("button", { name: /свободно, выбрать количество/ })
        .click();
      await Promise.resolve();
    });
    // Bump to qty=3.
    const plus = screen.getByRole("button", { name: /Увеличить количество/ });
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        plus.click();
        await Promise.resolve();
      });
    }
    // Confirm → POST attempts qty=3 → 409 race → warn card appears, picker
    // transitions away, qty=3 is preserved on the conflict state.
    await act(async () => {
      screen.getByRole("button", { name: /Добавить 3 шт Dedolight/ }).click();
      await Promise.resolve();
    });

    expect(addSpy).toHaveBeenNthCalledWith(1, "s1", "eq-free", 3, undefined);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByText(/Бронь #1050 «Сериал Дом» · 21\.05–23\.05/),
    ).toBeInTheDocument();
    // The force-add button reflects qty (preserved across picker → warn).
    expect(
      screen.getByRole("button", {
        name: /Выдать 3 шт Dedolight DLED4 под ответственность/,
      }),
    ).toBeInTheDocument();
    expect(onAdded).not.toHaveBeenCalled();

    // Press «Выдать N под ответственность» — retries with qty=3 AND ack=true.
    await act(async () => {
      screen
        .getByRole("button", { name: /под ответственность/ })
        .click();
      await Promise.resolve();
    });
    expect(addSpy).toHaveBeenLastCalledWith("s1", "eq-free", 3, true);
    await waitFor(() =>
      expect(onAdded).toHaveBeenCalledWith("bi-after-ack", true),
    );
  });

  it("renders NO barcode anywhere", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([
      freeResult(),
      conflictedResult(),
    ]);
    const { container } = render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );
    await type("a");
    await settleSearch();
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);
  });

  it("calls onClose from the scrim and the header close button", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([]);
    const onClose = vi.fn();
    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={onClose}
      />,
    );
    const closers = screen.getAllByRole("button", {
      name: /Закрыть поиск добора/,
    });
    expect(closers.length).toBeGreaterThanOrEqual(2);
    closers[0].click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc closes the sheet (calls onClose)", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([]);
    const onClose = vi.fn();
    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={onClose}
      />,
    );
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves initial focus to the search input on mount", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([]);
    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );
    // Focus is scheduled on a 50ms timer (sibling overlay pattern).
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    expect(screen.getByLabelText("Поиск артикула по каталогу")).toHaveFocus();
  });

  it("returns focus to the triggering element on close (unmount)", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([]);
    // A real trigger that is focused before the sheet opens.
    const trigger = document.createElement("button");
    trigger.textContent = "Добор";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { unmount } = render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    expect(screen.getByLabelText("Поиск артикула по каталогу")).toHaveFocus();

    // Closing the sheet (unmount) must restore focus to the trigger.
    await act(async () => {
      unmount();
    });
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("traps Tab/Shift+Tab within the sheet (last↔first wrap)", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([]);
    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(60);
    });

    const sheet = screen.getByRole("region", {
      name: /Добор — поиск по каталогу/,
    });
    const focusables = Array.from(
      sheet.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    // Tab from the last focusable wraps to the first.
    last.focus();
    expect(last).toHaveFocus();
    fireEvent.keyDown(sheet, { key: "Tab" });
    expect(first).toHaveFocus();

    // Shift+Tab from the first focusable wraps to the last.
    first.focus();
    expect(first).toHaveFocus();
    fireEvent.keyDown(sheet, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("locks body scroll while the mobile sheet is open and restores it on close", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([]);
    document.body.style.overflow = "auto";

    const { unmount } = render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );
    // jsdom has no matchMedia → treated as the mobile sheet → lock engaged.
    expect(document.body.style.overflow).toBe("hidden");

    await act(async () => {
      unmount();
    });
    expect(document.body.style.overflow).toBe("auto");
  });

  it("renders the mobile sheet with the vertical slide-up animation (not horizontal)", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([]);
    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );
    const sheet = screen.getByRole("region", {
      name: /Добор — поиск по каталогу/,
    });
    // Bottom sheet must rise UP, never slide sideways.
    expect(sheet.className).toMatch(/motion-safe:animate-slideup/);
    expect(sheet.className).not.toMatch(/animate-slidein/);
  });
});
