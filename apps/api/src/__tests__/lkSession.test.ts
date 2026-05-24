import { signLkSession, verifyLkSession, LK_COOKIE_NAME } from "../services/clientPortal/session";

describe("clientPortal/session", () => {
  beforeAll(() => {
    process.env.CLIENT_PORTAL_SESSION_SECRET = "test-secret-at-least-sixteen-chars-long";
  });

  test("sign + verify roundtrip", () => {
    const token = signLkSession({ accountId: "acc1", clientId: "cli1", email: "a@b.ru" });
    const decoded = verifyLkSession(token);
    expect(decoded).toEqual(expect.objectContaining({ accountId: "acc1", clientId: "cli1", email: "a@b.ru" }));
  });

  test("rejects invalid signature", () => {
    expect(verifyLkSession("bogus")).toBeNull();
  });

  test("cookie name is lk_session", () => {
    expect(LK_COOKIE_NAME).toBe("lk_session");
  });
});
