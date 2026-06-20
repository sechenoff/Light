import { describe, it, expect } from "vitest";
import { matchEquipmentName, EquipmentMatchInput } from "./equipmentMatcher";

const catalog: EquipmentMatchInput[] = [
  { id: "eq-lantern", name: "Lantern 120", importKey: "lantern_120", aliases: [{ phrase: "лантерн 120" }] },
  { id: "eq-lightdome", name: "Lightdome 150", importKey: null, aliases: [{ phrase: "лайтдом 150" }] },
  { id: "eq-sdl", name: "SDL 8", importKey: "sdl_8", aliases: [] },
];

describe("matchEquipmentName", () => {
  it("matches via importKey (exact)", () => {
    expect(matchEquipmentName("lantern_120", catalog).equipmentId).toBe("eq-lantern");
  });
  it("matches via alias (case/ё-insensitive)", () => {
    expect(matchEquipmentName("Лантерн 120", catalog).equipmentId).toBe("eq-lantern");
  });
  it("matches via name fuzzy ≥ 0.7", () => {
    const r = matchEquipmentName("SDL 8 шт.", catalog);
    expect(r.equipmentId).toBe("eq-sdl");
    expect(r.method).toBe("similarity");
    expect(r.score).toBeGreaterThan(0.7);
  });
  it("returns null when no match", () => {
    const r = matchEquipmentName("совершенно неизвестный предмет", catalog);
    expect(r.equipmentId).toBeNull();
  });
});
