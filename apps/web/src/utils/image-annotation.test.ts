import { describe, expect, it } from "vitest";
import { annotationCanvasSize, annotationDistance, arrowHeadPoints } from "./image-annotation";

describe("image annotation geometry", () => {
  it("keeps ordinary images at native resolution and constrains huge images", () => {
    expect(annotationCanvasSize(1200, 800)).toEqual({ width: 1200, height: 800 });
    expect(annotationCanvasSize(8000, 4000)).toEqual({ width: 4096, height: 2048 });
  });

  it("creates a symmetric arrow head", () => {
    const [left, right] = arrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 20);
    expect(left.x).toBeCloseTo(right.x);
    expect(left.y).toBeCloseTo(-right.y);
  });

  it("measures structured and freehand strokes", () => {
    expect(
      annotationDistance({
        kind: "rect",
        color: "#f00",
        start: { x: 0, y: 0 },
        end: { x: 3, y: 4 },
      }),
    ).toBe(5);
    expect(
      annotationDistance({
        kind: "pen",
        color: "#f00",
        points: [
          { x: 2, y: 1 },
          { x: 8, y: 9 },
        ],
      }),
    ).toBe(10);
  });
});
