/**
 * Тесты ClientPortalAccessCard:
 *  - ошибки API читаются из body.message (централизованный error-handler кладёт
 *    русское сообщение HttpError туда; body.error — только легаси-фолбэк);
 *  - «На другой адрес…» в resend-потоке шлёт { newEmail } и обновляет карточку.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClientPortalAccessCard } from "../ClientPortalAccessCard";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

type Account = {
  id: string;
  email: string;
  status: "PENDING" | "ACTIVE" | "DISABLED";
  invitedAt: string | null;
  acceptedAt: string | null;
  lastLoginAt: string | null;
};

const PENDING_ACCOUNT: Account = {
  id: "acc1",
  email: "typo@test.ru",
  status: "PENDING",
  invitedAt: "2026-06-01T10:00:00Z",
  acceptedAt: null,
  lastLoginAt: null,
};

function mockJsonOnce(body: unknown, ok = true, status = 200) {
  (global.fetch as any).mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  });
}

describe("ClientPortalAccessCard — ошибки API", () => {
  it("invite: показывает body.message (EMAIL_TAKEN), а не общий текст", async () => {
    // initial GET portal-account → нет аккаунта
    mockJsonOnce({ account: null });

    render(<ClientPortalAccessCard clientId="c1" defaultEmail="a@b.ru" />);
    await screen.findByText("Дать доступ в кабинет");

    // POST portal-invite → 409 с русским message
    mockJsonOnce(
      { message: "Email уже используется другим клиентом", code: "EMAIL_TAKEN" },
      false,
      409,
    );

    fireEvent.click(screen.getByText("Дать доступ в кабинет"));

    await waitFor(() =>
      expect(
        screen.getByText("Email уже используется другим клиентом"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("Ошибка при отправке приглашения"),
    ).not.toBeInTheDocument();
  });

  it("resend: показывает body.message (ACCOUNT_DISABLED)", async () => {
    mockJsonOnce({ account: PENDING_ACCOUNT });

    render(<ClientPortalAccessCard clientId="c1" defaultEmail={null} />);
    await screen.findByText("Переслать ссылку");

    mockJsonOnce(
      {
        message: "Нельзя переслать приглашение заблокированному аккаунту",
        code: "ACCOUNT_DISABLED",
      },
      false,
      409,
    );

    fireEvent.click(screen.getByText("Переслать ссылку"));

    await waitFor(() =>
      expect(
        screen.getByText("Нельзя переслать приглашение заблокированному аккаунту"),
      ).toBeInTheDocument(),
    );
  });

  it("фолбэк на body.error, когда message отсутствует", async () => {
    mockJsonOnce({ account: PENDING_ACCOUNT });

    render(<ClientPortalAccessCard clientId="c1" defaultEmail={null} />);
    await screen.findByText("Переслать ссылку");

    mockJsonOnce({ error: "Легаси-ошибка" }, false, 500);

    fireEvent.click(screen.getByText("Переслать ссылку"));

    await waitFor(() =>
      expect(screen.getByText("Легаси-ошибка")).toBeInTheDocument(),
    );
  });
});

describe("ClientPortalAccessCard — отправка на другой адрес", () => {
  it("«На другой адрес…» шлёт POST resend с { newEmail } и показывает успех", async () => {
    mockJsonOnce({ account: PENDING_ACCOUNT });

    render(<ClientPortalAccessCard clientId="c1" defaultEmail={null} />);
    await screen.findByText("На другой адрес…");

    fireEvent.click(screen.getByText("На другой адрес…"));

    const input = screen.getByLabelText(
      "Новый email для доступа в кабинет",
    ) as HTMLInputElement;
    // предзаполнен текущим адресом аккаунта
    expect(input.value).toBe("typo@test.ru");
    fireEvent.change(input, { target: { value: "Fixed@Test.RU" } });

    // POST resend → успех, затем refresh GET
    mockJsonOnce({
      email: "fixed@test.ru",
      emailSent: true,
      inviteUrl: "http://localhost:3000/lk/verify?token=x",
    });
    mockJsonOnce({ account: { ...PENDING_ACCOUNT, email: "fixed@test.ru" } });

    fireEvent.click(screen.getByText("Отправить"));

    await waitFor(() =>
      expect(
        screen.getByText("Email обновлён, ссылка отправлена"),
      ).toBeInTheDocument(),
    );

    // проверяем сам запрос: URL + нормализованный newEmail в body
    const calls = (global.fetch as any).mock.calls;
    const resendCall = calls.find(([url]: [string]) =>
      String(url).endsWith("/portal-account/resend"),
    );
    expect(resendCall).toBeTruthy();
    expect(JSON.parse(resendCall[1].body)).toEqual({ newEmail: "fixed@test.ru" });

    // карточка обновилась на новый email
    await waitFor(() =>
      expect(screen.getByText("fixed@test.ru")).toBeInTheDocument(),
    );
  });
});
