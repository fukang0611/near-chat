import { describe, expect, it } from "vitest";
import {
  DESKTOP_ISLAND_HEIGHT,
  DESKTOP_ISLAND_WIDTH,
  normalizeIslandPreferences,
  resolveIslandBounds,
} from "./island-state";

describe("desktop island state", () => {
  it("normalizes damaged preferences", () => {
    expect(normalizeIslandPreferences({ enabled: true, x: 12.6, y: "bad" })).toEqual({
      enabled: true,
      x: 13,
      y: null,
    });
    expect(normalizeIslandPreferences(null)).toEqual({ enabled: false, x: null, y: null });
  });

  it("restores a useful saved position", () => {
    expect(
      resolveIslandBounds({ enabled: true, x: 900, y: 120 }, [
        { x: 0, y: 0, width: 1440, height: 900 },
      ]),
    ).toEqual({ x: 900, y: 120, width: DESKTOP_ISLAND_WIDTH, height: DESKTOP_ISLAND_HEIGHT });
  });

  it("returns to the primary display when the saved display disappeared", () => {
    expect(
      resolveIslandBounds({ enabled: true, x: 3000, y: 120 }, [
        { x: 0, y: 0, width: 1440, height: 900 },
      ]),
    ).toEqual({
      x: 1440 - DESKTOP_ISLAND_WIDTH - 18,
      y: 900 - DESKTOP_ISLAND_HEIGHT - 18,
      width: DESKTOP_ISLAND_WIDTH,
      height: DESKTOP_ISLAND_HEIGHT,
    });
  });
});
