import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RepairPanel } from "../RepairPanel";
import { scanApi } from "../api";
import type { ScanApiError } from "../types";

// jsdom has no URL.createObjectURL / revokeObjectURL — stub them and assert
// the lifecycle (mint on capture, revoke on unmount / delete).
let urlCounter = 0;
const createSpy = vi.fn(() => `blob:mock-${++urlCounter}`);
const revokeSpy = vi.fn();

beforeEach(() => {
  urlCounter = 0;
  vi.restoreAllMocks();
  createSpy.mockClear();
  revokeSpy.mockClear();
  // jsdom in this setup leaves these as no-op stubs; override so we can
  // assert the object-URL lifecycle (mint on capture, revoke on cleanup).
  URL.createObjectURL = createSpy;
  URL.revokeObjectURL = revokeSpy;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeFile(name = "broken.jpg"): File {
  return new File(["x"], name, { type: "image/jpeg" });
}

describe("RepairPanel", () => {
  it("renders an amber canon panel with the comment textarea + note", async () => {
    vi.spyOn(scanApi, "listPhotos").mockResolvedValue({ photos: [] });
    const { container } = render(
      <RepairPanel
        sessionId="s1"
        unitId="u1"
        comment=""
        onCommentChange={() => {}}
      />,
    );

    const panel = container.querySelector(
      '[aria-label="Ремонт — комментарий и фото поломки"]',
    );
    expect(panel).toBeInTheDocument();
    expect(panel?.className).toMatch(/bg-amber-soft/);
    expect(panel?.className).toMatch(/border-amber-border/);

    expect(
      screen.getByPlaceholderText("Что сломалось?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "→ создаст карточку ремонта, фото видны руководителю",
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(scanApi.listPhotos).toHaveBeenCalledWith("s1", "u1"),
    );
  });

  it("typing in the textarea fires onCommentChange", async () => {
    vi.spyOn(scanApi, "listPhotos").mockResolvedValue({ photos: [] });
    const onCommentChange = vi.fn();
    render(
      <RepairPanel
        sessionId="s1"
        unitId="u1"
        comment=""
        onCommentChange={onCommentChange}
      />,
    );

    const ta = screen.getByPlaceholderText("Что сломалось?");
    fireEvent.change(ta, { target: { value: "Разбит байонет" } });
    expect(onCommentChange).toHaveBeenCalledWith("Разбит байонет");
  });

  it("calls listPhotos on mount and renders staged photos as placeholders", async () => {
    vi.spyOn(scanApi, "listPhotos").mockResolvedValue({
      photos: ["scan-sessions/s1/u1/old-1.jpg"],
    });
    render(
      <RepairPanel
        sessionId="s1"
        unitId="u1"
        comment=""
        onCommentChange={() => {}}
      />,
    );

    // Re-opened panel: no in-memory blob → placeholder thumb with filename,
    // NO fabricated <img> stream URL.
    expect(
      await screen.findByText("scan-sessions/s1/u1/old-1.jpg"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("selecting files uploads each one and renders an <img> thumbnail", async () => {
    vi.spyOn(scanApi, "listPhotos").mockResolvedValue({ photos: [] });
    const uploadSpy = vi
      .spyOn(scanApi, "uploadPhoto")
      .mockResolvedValueOnce({ photos: ["p-1.jpg"] })
      .mockResolvedValueOnce({ photos: ["p-1.jpg", "p-2.jpg"] });

    const { container } = render(
      <RepairPanel
        sessionId="s1"
        unitId="u1"
        comment=""
        onCommentChange={() => {}}
      />,
    );

    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const f1 = makeFile("a.jpg");
    const f2 = makeFile("b.jpg");

    await act(async () => {
      fireEvent.change(input, { target: { files: [f1, f2] } });
    });

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(2));
    expect(uploadSpy).toHaveBeenNthCalledWith(1, "s1", "u1", f1);
    expect(uploadSpy).toHaveBeenNthCalledWith(2, "s1", "u1", f2);

    // Two object URLs minted (one per captured file).
    expect(createSpy).toHaveBeenCalledTimes(2);
    const imgs = await screen.findAllByRole("img");
    expect(imgs.length).toBe(2);
  });

  it("deleting a photo calls deletePhoto and refreshes the list", async () => {
    vi.spyOn(scanApi, "listPhotos").mockResolvedValue({ photos: [] });
    vi.spyOn(scanApi, "uploadPhoto").mockResolvedValue({
      photos: ["only.jpg"],
    });
    const deleteSpy = vi
      .spyOn(scanApi, "deletePhoto")
      .mockResolvedValue({ photos: [] });

    const { container } = render(
      <RepairPanel
        sessionId="s1"
        unitId="u1"
        comment=""
        onCommentChange={() => {}}
      />,
    );

    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile()] } });
    });
    const del = await screen.findByRole("button", {
      name: "Удалить фото only.jpg",
    });

    await act(async () => {
      del.click();
    });

    await waitFor(() =>
      expect(deleteSpy).toHaveBeenCalledWith("s1", "u1", "only.jpg"),
    );
    // Object URL for the removed photo gets revoked.
    expect(revokeSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("img")).not.toBeInTheDocument(),
    );
  });

  it("upload error shows a canon Russian alert", async () => {
    vi.spyOn(scanApi, "listPhotos").mockResolvedValue({ photos: [] });
    const err: ScanApiError = {
      status: 413,
      code: "FILE_TOO_LARGE",
      message: "Файл слишком большой",
      details: null,
    };
    vi.spyOn(scanApi, "uploadPhoto").mockRejectedValue(err);

    const { container } = render(
      <RepairPanel
        sessionId="s1"
        unitId="u1"
        comment=""
        onCommentChange={() => {}}
      />,
    );
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile()] } });
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Файл слишком большой");
    expect(alert.className).toMatch(/bg-rose-soft/);
  });

  it("revokes all minted object URLs on unmount", async () => {
    vi.spyOn(scanApi, "listPhotos").mockResolvedValue({ photos: [] });
    vi.spyOn(scanApi, "uploadPhoto").mockResolvedValue({
      photos: ["x.jpg"],
    });
    const { container, unmount } = render(
      <RepairPanel
        sessionId="s1"
        unitId="u1"
        comment=""
        onCommentChange={() => {}}
      />,
    );
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile()] } });
    });
    await screen.findByRole("img");

    revokeSpy.mockClear();
    unmount();
    expect(revokeSpy).toHaveBeenCalledTimes(1);
  });

  it("renders NO barcode anywhere", async () => {
    vi.spyOn(scanApi, "listPhotos").mockResolvedValue({ photos: [] });
    const { container } = render(
      <RepairPanel
        sessionId="s1"
        unitId="u1"
        comment="Сломан"
        onCommentChange={() => {}}
      />,
    );
    await waitFor(() => expect(scanApi.listPhotos).toHaveBeenCalled());
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);
  });

  it("disables the camera button and textarea when disabled", async () => {
    vi.spyOn(scanApi, "listPhotos").mockResolvedValue({ photos: [] });
    render(
      <RepairPanel
        sessionId="s1"
        unitId="u1"
        comment=""
        onCommentChange={() => {}}
        disabled
      />,
    );
    expect(screen.getByPlaceholderText("Что сломалось?")).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Сфотографировать поломку камерой",
      }),
    ).toBeDisabled();
  });
});
