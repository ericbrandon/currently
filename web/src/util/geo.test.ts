import { describe, it, expect } from "vitest";
import { pointInRing, polygonIntersectsRect, type Ring } from "./geo";

const square: Ring = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];

// Thin diagonal band, like a coastal forecast zone: from (0,0) to (10,10),
// width ~1. Its bbox is the whole 10×10 square.
const band: Ring = [
  [0, 1],
  [9, 10],
  [10, 9],
  [1, 0],
  [0, 1],
];

describe("pointInRing", () => {
  it("classifies inside and outside", () => {
    expect(pointInRing(5, 5, square)).toBe(true);
    expect(pointInRing(15, 5, square)).toBe(false);
    expect(pointInRing(5, 5, band)).toBe(true); // on the band's diagonal
    expect(pointInRing(9, 1, band)).toBe(false); // in bbox, off the band
  });
});

describe("polygonIntersectsRect", () => {
  it("detects plain overlap and containment", () => {
    expect(polygonIntersectsRect(square, [5, 5, 15, 15])).toBe(true);
    // rect fully inside polygon (no vertices exchanged)
    expect(polygonIntersectsRect(square, [4, 4, 6, 6])).toBe(true);
    // polygon fully inside rect
    expect(polygonIntersectsRect(square, [-5, -5, 15, 15])).toBe(true);
    expect(polygonIntersectsRect(square, [11, 11, 20, 20])).toBe(false);
  });

  it("band crossing a rect with no vertices inside either way", () => {
    // Small rect straddling the band's middle: no band vertex inside it,
    // no rect corner inside the band — only edges cross.
    expect(polygonIntersectsRect(band, [4.4, 4.6, 4.6, 5.6])).toBe(true);
  });

  it("rejects a rect inside the polygon's bbox but off the polygon", () => {
    // This is exactly the false-positive the Weather alert dot had: the
    // viewport sat in WCVI South's bounding box corner while the actual
    // warned zone (diagonal band) was nowhere in view.
    expect(polygonIntersectsRect(band, [7.5, 0.2, 9.5, 1.2])).toBe(false);
    expect(polygonIntersectsRect(band, [0.2, 7.5, 1.2, 9.5])).toBe(false);
  });
});
