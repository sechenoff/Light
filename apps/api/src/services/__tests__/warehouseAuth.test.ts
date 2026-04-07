import { describe, it, expect, beforeAll } from "vitest";

// Set WAREHOUSE_SECRET before any imports
beforeAll(() => {
  process.env.WAREHOUSE_SECRET = "test-warehouse-secret";
});

// Dynamic import after env is set
const getModule = () =>
  import("../warehouseAuth").then((m) => m);

describe("warehouseAuth", () => {
  describe("hashPin / verifyPin", () => {
    it("should produce a hash that verifies correctly", async () => {
      const { hashPin, verifyPin } = await getModule();
      const hash = await hashPin("1234");
      const valid = await verifyPin("1234", hash);
      expect(valid).toBe(true);
    });

    it("should reject wrong PIN", async () => {
      const { hashPin, verifyPin } = await getModule();
      const hash = await hashPin("1234");
      const valid = await verifyPin("9999", hash);
      expect(valid).toBe(false);
    });
  });

  describe("generateToken / verifyToken", () => {
    it("should generate a token that verifies and returns the name", async () => {
      process.env.WAREHOUSE_SECRET = "test-warehouse-secret";
      const { generateToken, verifyToken } = await getModule();
      const token = generateToken("Иван");
      const result = verifyToken(token);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Иван");
    });

    it("should reject a token with tampered HMAC", async () => {
      process.env.WAREHOUSE_SECRET = "test-warehouse-secret";
      const { generateToken, verifyToken } = await getModule();
      const token = generateToken("Иван");
      // Tamper with HMAC part
      const [payload] = token.split(":");
      const tamperedToken = `${payload}:badhmac123456`;
      const result = verifyToken(tamperedToken);
      expect(result).toBeNull();
    });

    it("should reject an expired token", async () => {
      process.env.WAREHOUSE_SECRET = "test-warehouse-secret";
      const { verifyToken } = await getModule();
      // Manually build an expired token
      const { createHmac } = await import("crypto");
      const payload = { name: "Иван", exp: Date.now() - 1000 }; // expired 1s ago
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
      const hmac = createHmac("sha256", "test-warehouse-secret")
        .update(payloadB64)
        .digest("hex");
      const token = `${payloadB64}:${hmac}`;
      const result = verifyToken(token);
      expect(result).toBeNull();
    });

    it("should reject a token with bad format", async () => {
      process.env.WAREHOUSE_SECRET = "test-warehouse-secret";
      const { verifyToken } = await getModule();
      expect(verifyToken("notavalidtoken")).toBeNull();
    });
  });
});
