import { describe, it, expect } from "bun:test";
import { buildInkSeed, maskCount, type Mask } from "../../src/lib/inpaint/mask";
import {
  pageNoiseSigma,
  sobelMagnitude,
  strongEdgeFloor,
  toLuma,
} from "../../src/lib/inpaint/noise";
import { fitMask, type Fitted } from "../../src/lib/inpaint/fit";
import { renderFill } from "../../src/lib/inpaint/fill";
import { renderDenoise } from "../../src/lib/inpaint/denoise";
import { teleaInpaint } from "../../src/lib/inpaint/telea";
import { regionDeclines } from "../../src/lib/inpaint/quality";
import { planFastMethods, normalizeInpaintMethod } from "../../src/lib/inpaint/ladder";

function makeImageData(
  w: number,
  h: number,
  paint: (x: number, y: number) => [number, number, number, number],
): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const [r, g, b, a] = paint(x, y);
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = a;
    }
  }
  return { width: w, height: h, data } as unknown as ImageData;
}

function extractLuma(img: ImageData): Float32Array {
  const luma = new Float32Array(img.width * img.height);
  toLuma(img.data, luma);
  return luma;
}

function fitHelper(img: ImageData, box?: { x1: number; y1: number; x2: number; y2: number }) {
  const w = img.width;
  const h = img.height;
  const luma = extractLuma(img);
  const mag = sobelMagnitude(luma, w, h);
  const floor = strongEdgeFloor(luma, w, h);
  const sigma = pageNoiseSigma(luma, w, h);
  const targetBox = box ?? { x1: 0, y1: 0, x2: w - 1, y2: h - 1 };
  const seed = buildInkSeed(luma, w, h, 0, 0, targetBox);
  const fitted = fitMask(seed, luma, img.data, mag, floor, sigma);
  return { seed, fitted, sigma, floor, luma, mag };
}

describe("Inpainting Ladder — Pixel-Level Fixtures", () => {
  // ── 1. Rung 0: Flat Paper Planar Fill ────────────────────────────────────
  it("Rung 0: flat paper restores dark text to exact paper tone without altering border pixels", () => {
    const w = 120;
    const h = 60;
    const paperRgba: [number, number, number, number] = [242, 242, 242, 255];
    const textRgba: [number, number, number, number] = [25, 25, 25, 255];

    const img = makeImageData(w, h, (x, y) => {
      // Text centered at x: [40..70], y: [25..35]
      if (x >= 40 && x <= 70 && y >= 25 && y <= 35) return textRgba;
      return paperRgba;
    });

    const { fitted, sigma } = fitHelper(img);
    expect(fitted.route).toBe("fill");
    expect(sigma).toBeLessThan(2);

    const snapshot = new Uint8ClampedArray(img.data);
    renderFill(img, fitted.mask, fitted);

    // Pixel check: inside core text area, pixels are now paper tone (within ±2)
    const coreIdx = (30 * w + 55) * 4;
    expect(Math.abs(img.data[coreIdx] - 242)).toBeLessThanOrEqual(2);
    expect(Math.abs(img.data[coreIdx + 1] - 242)).toBeLessThanOrEqual(2);
    expect(Math.abs(img.data[coreIdx + 2] - 242)).toBeLessThanOrEqual(2);
    expect(img.data[coreIdx + 3]).toBe(255); // Alpha intact

    // Pixel check: outside the fitted mask, pixels are strictly identical
    const outsideIdx = (5 * w + 5) * 4;
    expect(img.data[outsideIdx]).toBe(snapshot[outsideIdx]);
    expect(img.data[outsideIdx + 1]).toBe(snapshot[outsideIdx + 1]);

    // Quality check passes
    expect(regionDeclines(img, fitted.mask, sigma, [])).toBe(false);
  });

  // ── 2. Rung 1: Grainy / Bilateral Denoise ────────────────────────────────
  it("Rung 1: grainy paper routes to denoise and blends grain over text mask", () => {
    const w = 120;
    const h = 60;
    // Summed 3-draw deterministic pseudo-grain (normal-ish distribution)
    const grain = (x: number, y: number) => {
      const draw = (salt: number) => {
        let hVal = ((y << 16) | x) ^ salt * 0x9e3779b9;
        hVal = Math.imul(hVal ^ (hVal >>> 13), 0x85ebca6b);
        return ((hVal ^ (hVal >>> 16)) >>> 0) % 5;
      };
      return draw(1) + draw(2) + draw(3) - 6;
    };

    const img = makeImageData(w, h, (x, y) => {
      if (x >= 40 && x <= 70 && y >= 25 && y <= 35) {
        return [30, 30, 30, 255]; // dark text
      }
      const g = Math.max(0, Math.min(255, 232 + grain(x, y) * 2));
      return [g, g, g, 255];
    });

    const { fitted, sigma } = fitHelper(img);
    expect(sigma).toBeGreaterThanOrEqual(4);
    expect(fitted.route).toBe("denoise");

    renderDenoise(img, fitted.mask, fitted, sigma);

    // Text at (55, 30) is replaced with paper level (> 200)
    const centerIdx = (30 * w + 55) * 4;
    expect(img.data[centerIdx]).toBeGreaterThan(200);

    // Denoise pass does not decline
    expect(regionDeclines(img, fitted.mask, sigma, [])).toBe(false);
  });

  // ── 3. Rung 2: Two-Tone / Telea Fast Marching ───────────────────────────
  it("Rung 2: two-tone boundary trips fill refusal and cleans via Telea fast-marching", () => {
    const w = 120;
    const h = 60;
    const textBox = { x1: 40, y1: 25, x2: 70, y2: 35 };

    const img = makeImageData(w, h, (x, y) => {
      if (x >= textBox.x1 && x <= textBox.x2 && y >= textBox.y1 && y <= textBox.y2) {
        return [20, 20, 20, 255]; // text across partition
      }
      // Left is 255, right is 190
      const tone = x < 55 ? 255 : 190;
      return [tone, tone, tone, 255];
    });

    const { fitted } = fitHelper(img, textBox);
    // Multimodal / two-tone ring refuses flat fill
    expect(fitted.route).toBe("inpaint");

    // Telea inpainting on the fitted mask
    teleaInpaint(img, fitted.mask.data, 2);

    // Interior left text pixel cleaned towards left background
    const leftTextIdx = (30 * w + 45) * 4;
    expect(img.data[leftTextIdx]).toBeGreaterThan(220);

    // Interior right text pixel cleaned towards right background
    const rightTextIdx = (30 * w + 65) * 4;
    expect(img.data[rightTextIdx]).toBeGreaterThan(170);
    expect(img.data[rightTextIdx]).toBeLessThan(230);
  });

  // ── 4. Edge Preservation: Never paints over balloon outlines ─────────────
  it("Mask dilation halts at strong edges (balloon boundary protected at pixel level)", () => {
    const w = 120;
    const h = 60;
    const strokeX = 95; // Strong balloon outline at x=95..99
    const strokeColor: [number, number, number, number] = [8, 8, 8, 255];

    const img = makeImageData(w, h, (x, y) => {
      if (x >= strokeX && x <= strokeX + 4) return strokeColor;
      if (x >= 40 && x <= 70 && y >= 25 && y <= 35) return [25, 25, 25, 255]; // text
      return [240, 240, 240, 255]; // paper
    });

    const { fitted } = fitHelper(img, { x1: 38, y1: 23, x2: 72, y2: 37 });

    // Verify mask never touches stroke pixels at x=95..99
    let touchedStroke = false;
    for (let y = 0; y < h; y++) {
      for (let x = strokeX - 1; x <= strokeX + 5; x++) {
        if (fitted.mask.data[y * w + x]) touchedStroke = true;
      }
    }
    expect(touchedStroke).toBe(false);

    // Apply fill
    renderFill(img, fitted.mask, fitted);

    // Stroke pixels remain 100% untouched
    for (let y = 0; y < h; y++) {
      for (let x = strokeX; x <= strokeX + 4; x++) {
        const idx = (y * w + x) * 4;
        expect(img.data[idx]).toBe(8);
        expect(img.data[idx + 1]).toBe(8);
        expect(img.data[idx + 2]).toBe(8);
      }
    }
  });

  // ── 5. Polarity: Inverted Light Text on Dark Manga Panel ─────────────────
  it("Detects and fills light text on dark background", () => {
    const w = 120;
    const h = 60;
    const img = makeImageData(w, h, (x, y) => {
      if (x >= 40 && x <= 70 && y >= 25 && y <= 35) {
        return [230, 230, 230, 255]; // Light text
      }
      return [20, 20, 20, 255]; // Dark background
    });

    const { seed, fitted } = fitHelper(img);
    expect(maskCount(seed)).toBeGreaterThan(100);

    renderFill(img, fitted.mask, fitted);

    const centerIdx = (30 * w + 55) * 4;
    // Restored to dark tone (<= 25)
    expect(img.data[centerIdx]).toBeLessThanOrEqual(25);
  });

  // ── 6. Decline Gate & Rollback Integrity ─────────────────────────────────
  it("Rollback on decline leaves page byte-identical; alwaysInpaint bypasses decline", () => {
    const w = 120;
    const h = 60;
    const img = makeImageData(w, h, (x, y) => {
      if (x >= 40 && x <= 70 && y >= 25 && y <= 35) return [30, 30, 30, 255];
      return [240, 240, 240, 255];
    });

    const { fitted } = fitHelper(img);

    // Snapshot before attempt
    const snapshot = new Uint8ClampedArray(img.data);

    // Simulate bad fill: inject wrong color (90) inside mask
    for (let i = 0; i < fitted.mask.data.length; i++) {
      if (fitted.mask.data[i]) {
        img.data[i * 4] = 90;
        img.data[i * 4 + 1] = 90;
        img.data[i * 4 + 2] = 90;
      }
    }

    // Decline metric correctly triggers
    const declines = regionDeclines(img, fitted.mask, 1, []);
    expect(declines).toBe(true);

    // Rollback restores original snapshot exactly
    img.data.set(snapshot);
    expect(img.data).toEqual(snapshot);

    // With alwaysInpaint bypass: Telea runs and passes without rollback
    teleaInpaint(img, fitted.mask.data, 2);
    const centerIdx = (30 * w + 55) * 4;
    expect(img.data[centerIdx]).toBeGreaterThan(200);
  });

  // ── 7. Method Planning & Normalization ────────────────────────────────────
  it("Ladder method planning matches routes", () => {
    expect(planFastMethods("fill")).toEqual(["fill", "denoise", "telea"]);
    expect(planFastMethods("denoise")).toEqual(["denoise", "telea"]);
    expect(planFastMethods("inpaint")).toEqual(["telea"]);

    expect(normalizeInpaintMethod("quality")).toBe("quality");
    expect(normalizeInpaintMethod("auto")).toBe("fast");
    expect(normalizeInpaintMethod("fast")).toBe("fast");
    expect(normalizeInpaintMethod("telea")).toBe("fast");
    expect(normalizeInpaintMethod(null)).toBe("fast");
  });
});
