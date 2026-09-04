import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddonItemsModal } from "../AddonItemsModal";

const apiFetchMock = vi.fn();
vi.mock("../../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const FREE_ROW = {
  equipmentId: "eq-free",
  name: "Aputure 600d",
  category: "Свет",
  brand: "Aputure",
  model: "600d",
  stockTrackingMode: "COUNT",
  rentalRatePerShift: "1000",
  availableQuantity: 2,
  addCap: 2,
  alreadyInBooking: 1,
  availability: "AVAILABLE",
  conflict: null,
};

const BUSY_ROW = {
  equipmentId: "eq-busy",
  name: "Joker 800",
  category: "Свет",
  brand: null,
  model: null,
  stockTrackingMode: "COUNT",
  rentalRatePerShift: "500",
  availableQuantity: 0,
  addCap: 0,
  alreadyInBooking: 0,
  availability: "UNAVAILABLE",
  conflict: {
    bookingId: "b-other",
    bookingNo: "#A1B2C3",
    projectName: "Чужой проект",
    from: "2026-09-05T07:00:00.000Z",
    to: "2026-09-07T07:00:00.000Z",
    freeFrom: "2026-09-07T07:00:00.000Z",
  },
};

function mockSearch(rows: unknown[]) {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.includes("/addon-search")) return { results: rows };
    if (path.endsWith("/addon-items") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      return {
        mode: body.mode,
        added: body.items.map((it: { equipmentId: string; quantity: number }) => ({
          equipmentId: it.equipmentId,
          name: it.equipmentId,
          quantity: it.quantity,
          unitsIssued: 0,
          hadConflict: false,
        })),
        conflicts: [],
      };
    }
    throw new Error(`unexpected call ${path}`);
  });
}

function renderModal(overrides: Partial<React.ComponentProps<typeof AddonItemsModal>> = {}) {
  const onAdded = vi.fn();
  const onClose = vi.fn();
  render(
    <AddonItemsModal
      open
      bookingId="b1"
      shifts={2}
      discountPercent="50"
      hasManualFinalAmount={false}
      onClose={onClose}
      onAdded={onAdded}
      {...overrides}
    />,
  );
  return { onAdded, onClose };
}

describe("AddonItemsModal", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <AddonItemsModal open={false} bookingId="b1" shifts={1} discountPercent={null} hasManualFinalAmount={false} onClose={() => {}} onAdded={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("searches, adds a free row to the cart, clamps qty to addCap and posts mode ADDON", async () => {
    mockSearch([FREE_ROW]);
    const { onAdded } = renderModal();

    fireEvent.change(screen.getByLabelText("Поиск по каталогу"), { target: { value: "apu" } });
    expect(await screen.findByText("Aputure 600d")).toBeInTheDocument();
    expect(screen.getByText("свободно ×2")).toBeInTheDocument();
    expect(screen.getByText(/уже в брони ×1/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Добавить Aputure 600d" }));
    const plus = screen.getByRole("button", { name: "Больше: Aputure 600d" });
    fireEvent.click(plus);
    fireEvent.click(plus); // сверх addCap=2 не уходит
    expect(screen.getByLabelText("Количество Aputure 600d")).toHaveValue(2);
    expect(plus).toBeDisabled();

    // Оценка «до скидки»: 1000 × 2 смены × 2 шт.
    expect(screen.getByText(/до скидки/)).toHaveTextContent("4 000");

    fireEvent.click(screen.getByRole("button", { name: "Добавить доп-сметой" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    const post = apiFetchMock.mock.calls.find(([p, init]) => String(p).endsWith("/addon-items") && init?.method === "POST");
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post![1].body))).toEqual({
      items: [{ equipmentId: "eq-free", quantity: 2 }],
      mode: "ADDON",
      acknowledgedConflict: false,
    });
  });

  it("switches mode to MERGE via the radio group", async () => {
    mockSearch([FREE_ROW]);
    const { onAdded } = renderModal();
    fireEvent.change(screen.getByLabelText("Поиск по каталогу"), { target: { value: "apu" } });
    fireEvent.click(await screen.findByRole("button", { name: "Добавить Aputure 600d" }));
    fireEvent.click(screen.getByRole("radio", { name: /В основную смету/ }));
    fireEvent.click(screen.getByRole("button", { name: "Добавить в смету" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    const post = apiFetchMock.mock.calls.find(([p, init]) => String(p).endsWith("/addon-items") && init?.method === "POST");
    expect(JSON.parse(String(post![1].body)).mode).toBe("MERGE");
  });

  it("busy row shows the conflict card and submits «под ответственность»", async () => {
    mockSearch([BUSY_ROW]);
    const { onAdded } = renderModal();
    fireEvent.change(screen.getByLabelText("Поиск по каталогу"), { target: { value: "joker" } });
    expect(await screen.findByText("Joker 800")).toBeInTheDocument();
    expect(screen.getByText("занято")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Добавить Joker 800" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Чужой проект");
    const submit = screen.getByRole("button", { name: "Добавить под ответственность" });
    fireEvent.click(submit);
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    const post = apiFetchMock.mock.calls.find(([p, init]) => String(p).endsWith("/addon-items") && init?.method === "POST");
    expect(JSON.parse(String(post![1].body)).acknowledgedConflict).toBe(true);
  });

  it("409 ADDON_OVER_STOCK shows the server message and clamps the row to the returned cap", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes("/addon-search")) return { results: [{ ...FREE_ROW, addCap: 5, availableQuantity: 5 }] };
      if (init?.method === "POST") {
        throw Object.assign(new Error("«Aputure 600d»: не хватает на складе — можно добрать ещё 1"), {
          status: 409,
          code: "ADDON_OVER_STOCK",
          details: { equipmentId: "eq-free", addCap: 1, requested: 3, alreadyInBooking: 1 },
        });
      }
      throw new Error("unexpected");
    });
    const { onAdded } = renderModal();
    fireEvent.change(screen.getByLabelText("Поиск по каталогу"), { target: { value: "apu" } });
    fireEvent.click(await screen.findByRole("button", { name: "Добавить Aputure 600d" }));
    fireEvent.change(screen.getByLabelText("Количество Aputure 600d"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить доп-сметой" }));
    expect(await screen.findByRole("status")).toHaveTextContent("не хватает на складе");
    expect(screen.getByLabelText("Количество Aputure 600d")).toHaveValue(1);
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("Escape closes the dialog", () => {
    mockSearch([]);
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
