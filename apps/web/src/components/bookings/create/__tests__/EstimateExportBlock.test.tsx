import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EstimateExportBlock } from "../EstimateExportBlock";

const downloadEstimate = vi.fn(async () => {});
const printEstimate = vi.fn(async () => {});

vi.mock("../../../../lib/estimateExport", () => ({
  downloadEstimate: (...a: unknown[]) => downloadEstimate(...(a as [])),
  printEstimate: (...a: unknown[]) => printEstimate(...(a as [])),
  fullEstimatePath: (id: string, format: string) =>
    `/api/bookings/${id}/full-estimate/export/${format}`,
}));

beforeEach(() => {
  downloadEstimate.mockClear();
  printEstimate.mockClear();
});

describe("EstimateExportBlock", () => {
  // Расчёт «с экрана» (POST /quote/export) транспорт молча теряет: на брони с
  // двумя машинами PDF был бы валидным, но с заниженным итогом. Поэтому все
  // три кнопки обязаны бить в полную смету брони.
  it.each([
    ["Печать", "pdf", "print"],
    ["PDF", "pdf", "download"],
    ["Excel", "xlsx", "download"],
  ])("«%s» берёт полную смету брони (%s)", (label, format, kind) => {
    render(<EstimateExportBlock bookingId="b-1" hasUnsavedChanges={false} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    const path = `/api/bookings/b-1/full-estimate/export/${format}`;
    if (kind === "print") {
      expect(printEstimate).toHaveBeenCalledWith(path);
    } else {
      expect(downloadEstimate).toHaveBeenCalledWith(path, expect.stringContaining("b-1"));
    }
  });

  it("при несохранённых правках честно предупреждает, но не блокирует печать", () => {
    // Печатается серверный снапшот, то есть последнее сохранённое состояние.
    // Молчать об этом нельзя — человек решит, что печатает то, что видит.
    render(<EstimateExportBlock bookingId="b-1" hasUnsavedChanges />);
    expect(screen.getByText(/последнее сохранённое состояние/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Печать" })).not.toBeDisabled();
  });

  it("без несохранённых правок предупреждения нет", () => {
    render(<EstimateExportBlock bookingId="b-1" hasUnsavedChanges={false} />);
    expect(screen.queryByText(/последнее сохранённое состояние/i)).toBeNull();
  });

  it("во время выгрузки соседние кнопки заблокированы — второй клик это дубль", async () => {
    let release: (() => void) | undefined;
    downloadEstimate.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    render(<EstimateExportBlock bookingId="b-1" hasUnsavedChanges={false} />);

    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Печать" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Excel" }));
    expect(downloadEstimate).toHaveBeenCalledTimes(1);

    release?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Печать" })).not.toBeDisabled());
  });
});
