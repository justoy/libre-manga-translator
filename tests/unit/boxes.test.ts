import { describe, it, expect } from "bun:test";
import {
  mergeCentreInBox,
  overlapsEnough,
  medianBoxArea,
  sizeVerdict,
  refineDetections,
} from "../../src/lib/detections/boxes";

const createBox = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  confidence = 0.8,
): Bbox => ({ x1, y1, x2, y2, confidence });

describe("mergeCentreInBox", () => {
  it("merges box whose center falls inside another box and takes max confidence", () => {
    // Outer box: [0, 0] to [100, 100] (center [50, 50])
    // Inner box: [40, 40] to [60, 60] (center [50, 50] inside outer)
    const b1 = createBox(0, 0, 100, 100, 0.6);
    const b2 = createBox(40, 40, 60, 60, 0.95);

    const merged = mergeCentreInBox([b1, b2]);
    expect(merged.length).toBe(1);
    expect(merged[0].confidence).toBe(0.95);
    expect(merged[0].x1).toBe(0);
    expect(merged[0].y1).toBe(0);
    expect(merged[0].x2).toBe(100);
    expect(merged[0].y2).toBe(100);
  });

  it("leaves disjoint boxes untouched", () => {
    const b1 = createBox(0, 0, 50, 50, 0.8);
    const b2 = createBox(100, 100, 150, 150, 0.8);

    const merged = mergeCentreInBox([b1, b2]);
    expect(merged.length).toBe(2);
  });
});

describe("overlapsEnough", () => {
  it("returns true when overlap exceeds 20% of smaller box area", () => {
    // Box 1: 100x100 = 10000 area
    // Box 2: [50, 0] to [150, 100] = 100x100 = 10000 area
    // Overlap: [50, 0] to [100, 100] = 50x100 = 5000 (50% of smaller)
    const b1 = createBox(0, 0, 100, 100);
    const b2 = createBox(50, 0, 150, 100);
    expect(overlapsEnough(b1, b2)).toBe(true);
  });

  it("returns false for minimal overlap <= 20%", () => {
    // Box 1: 0..100 -> area 10000
    // Box 2: 90..190 -> area 10000
    // Overlap: 90..100 = 10x100 = 1000 (10% of 10000 <= 20%)
    const b1 = createBox(0, 0, 100, 100);
    const b2 = createBox(90, 0, 190, 100);
    expect(overlapsEnough(b1, b2)).toBe(false);
  });

  it("returns false for non-overlapping boxes", () => {
    const b1 = createBox(0, 0, 50, 50);
    const b2 = createBox(100, 100, 150, 150);
    expect(overlapsEnough(b1, b2)).toBe(false);
  });
});

describe("medianBoxArea & sizeVerdict", () => {
  it("calculates median area accurately", () => {
    const boxes = [
      createBox(0, 0, 10, 10), // area 100
      createBox(0, 0, 20, 20), // area 400
      createBox(0, 0, 30, 30), // area 900
    ];
    expect(medianBoxArea(boxes)).toBe(400);
  });

  it("drops tiny speckle with low confidence", () => {
    const verdict = sizeVerdict(10, 1000, 5, 1000, 0.4);
    expect(verdict).toBe("drop");
  });

  it("keeps tiny box if detector is confident (SIZE_DROP_MAX_CONFIDENCE = 0.7)", () => {
    const verdict = sizeVerdict(10, 1000, 5, 1000, 0.85);
    expect(verdict).toBe("keep");
  });

  it("flags overly large boxes exceeding 25% page height", () => {
    const verdict = sizeVerdict(500, 500, 300, 1000, 0.9);
    expect(verdict).toBe("flag-large");
  });
});

describe("refineDetections pipeline", () => {
  it("runs full refinement and returns refined boxes", () => {
    const input = [
      createBox(10, 10, 100, 100, 0.9),
      createBox(20, 20, 90, 90, 0.7), // inside first
      createBox(500, 500, 502, 502, 0.3), // tiny speckle
    ];

    const result = refineDetections(input, 1000, 1000);
    expect(result.boxes.length).toBe(1);
    expect(result.dropped).toBeGreaterThanOrEqual(1);
  });
});
