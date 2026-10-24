/**
 * Assert-based self-check for the Beta4 inpaint ladder core
 * (mask/noise/ring/fit/fill/quality). No test framework - run with:
 *
 *   bun scripts/inpaint-selfcheck.ts
 *
 * Exercises the pure typed-array path only (fit takes crop luma/rgb, no DOM).
 * Golden-image verification of renderDenoise/telea still happens in the
 * offscreen doc per update-phase.md P4.
 */
import {
  buildInkSeed,
  buildSegmentationSeed,
  maskCount,
  type Mask,
} from "../src/lib/inpaint/mask";
import {
  pageNoiseSigma,
  sobelMagnitude,
  strongEdgeFloor,
  toLuma,
} from "../src/lib/inpaint/noise";
import { fitMask } from "../src/lib/inpaint/fit";
import { renderFill } from "../src/lib/inpaint/fill";
import { regionDeclines } from "../src/lib/inpaint/quality";
import { AlphaRamp, planTiles, tileOrigins } from "../src/lib/inpaint/lama";
import { normalizeInpaintMethod, planFastMethods } from "../src/lib/inpaint/ladder";
import { isModelWebGpuCapable } from "../src/lib/hardware";

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (!cond) {
    failures++;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
};

// deterministic pseudo-grain: 3 draws summed ~ normal-ish (normality matters;
// a uniform draw is bimodal by the multimodal test and trips the fill refusal)
const grain = (x: number, y: number) => {
  const draw = (salt: number) => {
    let h = ((y << 16) | x) ^ salt * 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 13), 0x85ebca6b);
    return ((h ^ (h >>> 16)) >>> 0) % 5;
  };
  return draw(1) + draw(2) + draw(3) - 6;
};

function page(
  w: number,
  h: number,
  f: (x: number, y: number) => number,
): Float32Array {
  const luma = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) luma[y * w + x] = f(x, y);
  return luma;
}

const lumaToRgb = (luma: Float32Array): Uint8ClampedArray => {
  const rgb = new Uint8ClampedArray(luma.length * 4);
  for (let i = 0; i < luma.length; i++) {
    rgb[i * 4] = luma[i];
    rgb[i * 4 + 1] = luma[i];
    rgb[i * 4 + 2] = luma[i];
    rgb[i * 4 + 3] = 255;
  }
  return rgb;
};

function fitCase(
  luma: Float32Array,
  w: number,
  h: number,
  rect?: { x1: number; y1: number; x2: number; y2: number },
) {
  const rgb = lumaToRgb(luma);
  const mag = sobelMagnitude(luma, w, h);
  const floor = strongEdgeFloor(luma, w, h);
  const sigma = pageNoiseSigma(luma, w, h);
  const seed = buildInkSeed(luma, w, h, 0, 0, rect ?? { x1: 0, y1: 0, x2: w - 1, y2: h - 1 });
  const fitted = fitMask(seed, luma, rgb, mag, floor, sigma);
  return { seed, fitted, sigma, floor };
}

// --- 1. flat paper with dark text: fit succeeds, routes to fill -----------
{
  const w = 120,
    h = 60;
  const { seed, fitted, sigma } = fitCase(
    page(w, h, (x, y) =>
      x >= 40 && x <= 70 && y >= 25 && y <= 35 ? 30 : 240,
    ),
    w,
    h,
  );
  check("flat: ink seed covers the text", maskCount(seed) >= 31 * 11 * 0.9);
  check("flat: noise sigma ~ 0", sigma < 2);
  check("flat: routes to fill", fitted.route === "fill");
  check("flat: ring deviation under floor", fitted.ring.deviation < 1);
  check(
    "flat: mask grows past the glyph edge (swallows AA fringe)",
    maskCount(fitted.mask) > maskCount(seed),
  );
}

// --- 2. growth stops at a strong stroke, never paints over it --------------
{
  const w = 120,
    h = 60;
  const { fitted } = fitCase(
    page(w, h, (x, y) => {
      if (x >= 95 && x <= 99) return 8; // balloon stroke, right of text
      return x >= 40 && x <= 70 && y >= 25 && y <= 35 ? 30 : 240;
    }),
    w,
    h,
    { x1: 38, y1: 23, x2: 72, y2: 37 }, // detected box around the text only
  );
  const { mask } = fitted;
  let touchedStroke = false;
  for (let y = 0; y < mask.h; y++) {
    for (let x = 94; x <= 100; x++) {
      if (mask.data[y * mask.w + x]) touchedStroke = true;
    }
  }
  check("stroke: growth never crosses the outline", !touchedStroke);
}

// --- 3. two-tone paper: multimodal / unfit ring refuses flat fill ---------
{
  const w = 120,
    h = 60;
  const { fitted } = fitCase(
    page(w, h, (x, y) => {
      if (x >= 40 && x <= 70 && y >= 25 && y <= 35) return 30;
      return x < 78 ? 255 : 200;
    }),
    w,
    h,
  );
  check("two-tone: refuses the fill rung", fitted.route === "inpaint");
}

// --- 4. grainy paper: noise floor routes to denoise -----------------------
{
  const w = 120,
    h = 60;
  const { fitted, sigma } = fitCase(
    page(w, h, (x, y) =>
      x >= 40 && x <= 70 && y >= 25 && y <= 35
        ? 30
        : Math.max(0, Math.min(255, 232 + grain(x, y) * 2)),
    ),
    w,
    h,
  );
  check("grain: noise sigma >= denoise floor", sigma >= 4);
  check("grain: routes to denoise", fitted.route === "denoise");
}

// --- 5. polarity: light ink on dark paper still seeds ---------------------
{
  const w = 120,
    h = 60;
  const luma = page(w, h, (x, y) =>
    x >= 40 && x <= 70 && y >= 25 && y <= 35 ? 230 : 20,
  );
  const seed: Mask = buildInkSeed(luma, w, h, 0, 0);
  check("inverted: seed catches light ink", maskCount(seed) > 100);
}

// --- 6. fill writes plane through the mask, alpha untouched ----------------
{
  const w = 120,
    h = 60;
  const luma = page(w, h, (x, y) =>
    x >= 40 && x <= 70 && y >= 25 && y <= 35 ? 30 : 240,
  );
  const rgb = lumaToRgb(luma);
  const mag = sobelMagnitude(luma, w, h);
  const seed = buildInkSeed(luma, w, h, 0, 0);
  const fitted = fitMask(seed, luma, rgb, mag, strongEdgeFloor(luma, w, h), 1);

  const pageData = new Uint8ClampedArray(rgb); // RGBA copy
  for (let i = 3; i < pageData.length; i += 4) pageData[i] = 200;
  const fake = { data: pageData, width: w, height: h } as unknown as ImageData;
  renderFill(fake, fitted.mask, fitted);

  const mid = (28 * w + 55) * 4; // inside grown mask
  check("fill: interior becomes paper tone", pageData[mid] > 235);
  check("fill: alpha copied", pageData[mid + 3] === 200);
  const far = (5 * w + 5) * 4; // outside
  check("fill: outside untouched", pageData[far] === 240);

  // decline metric: a correct fill passes, a wrong-tone patch declines
  check(
    "quality: good fill passes",
    !regionDeclines(fake, fitted.mask, 1, []),
  );
  const wrong = new Uint8ClampedArray(rgb);
  for (let idx = 0; idx < fitted.mask.data.length; idx++) {
    if (fitted.mask.data[idx]) {
      wrong[idx * 4] = 90;
      wrong[idx * 4 + 1] = 90;
      wrong[idx * 4 + 2] = 90;
    }
  }
  const fake2 = { data: wrong, width: w, height: h } as unknown as ImageData;
  check(
    "quality: wrong-tone interior declines",
    regionDeclines(fake2, fitted.mask, 1, []),
  );

  // --- Tier 3 checks: segmentation seed & LaMa tiling ---
  const fakeSeg = new Uint8Array(w * h);
  // Mark center 5x5 as text (level 200 >= threshold 76)
  for (let dy = 28; dy < 33; dy++) {
    for (let dx = 28; dx < 33; dx++) {
      fakeSeg[dy * w + dx] = 200;
    }
  }
  const segSeed = buildSegmentationSeed(fakeSeg, w, h, w, h, 0, 0, {
    x1: 20,
    y1: 20,
    x2: 40,
    y2: 40,
  });
  check("segmentation: seed marks text pixels", maskCount(segSeed) === 25);

  // LaMa tiling: <= 512 px single centered tile
  const originsSingle = tileOrigins(100, 200);
  check("lama: <= 512 extent is single tile", originsSingle.length === 1);
  check("lama: single tile centered", originsSingle[0] === 100 + 100 - 256);

  // LaMa tiling: > 512 px tiled with overlap
  const originsMulti = tileOrigins(0, 800);
  check("lama: > 512 extent creates multiple tiles", originsMulti.length >= 2);
  const tiles = planTiles({ x: 0, y: 0, w: 800, h: 400 });
  check("lama: planTiles generates valid tiles", tiles.length >= 2);

  // AlphaRamp values along glyph boundary
  const ramp = new AlphaRamp(fitted);
  // Inside center where ink is located (x=55, y=28)
  check("lama: alpha ramp 1.0 in core", ramp.at(fitted.ink.ox + 55, fitted.ink.oy + 28) === 1.0);
  // Outside far away
  check("lama: alpha ramp 0.0 outside", ramp.at(fitted.ink.ox + 5, fitted.ink.oy + 5) === 0.0);
}

// --- Fast vs Quality planning (no DOM needed) ---
{
  const eq = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, idx) => v === b[idx]);

  // Fast ladder never carries the LaMa rung, whatever the route
  check("fast: fill route plans fill, denoise, telea", eq(planFastMethods("fill"), ["fill", "denoise", "telea"]));
  check("fast: denoise route plans denoise, telea", eq(planFastMethods("denoise"), ["denoise", "telea"]));
  check("fast: inpaint route plans telea only", eq(planFastMethods("inpaint"), ["telea"]));

  // Quality = LaMa first, then the Fast plan for that route (fallback)
  for (const route of ["fill", "denoise", "inpaint"] as const) {
    const qualityPlan = ["lama", ...planFastMethods(route)];
    check(
      `quality: ${route} route plans lama first with fast fallback`,
      qualityPlan[0] === "lama" && !qualityPlan.slice(1).includes("lama"),
    );
  }

  // WebGPU capability allowlist: LaMa FFC complex-Add and ceil_mode=1
  // models (RT-DETR, Chinese OCR) stay WASM; the rest run WebGPU
  check("ep: static lama-manga is wasm-only (FFC Add has no JSEP kernel)", !isModelWebGpuCapable("lama-manga.onnx"));
  check("ep: dynamic lama-manga is wasm-only (FFC Add has no JSEP kernel)", !isModelWebGpuCapable("lama-manga-dynamic.onnx"));
  check("ep: comictextdetector is webgpu-capable", isModelWebGpuCapable("comictextdetector.pt.onnx"));
  check("ep: rtdetr is wasm-only", !isModelWebGpuCapable("detector-v4-s_int8.onnx"));
  check("ep: chinese ocr is wasm-only", !isModelWebGpuCapable("languages/chinese/rec.onnx"));
  check("ep: latin ocr is webgpu-capable", isModelWebGpuCapable("languages/latin/rec.onnx"));

  // Stored method values normalize forward; legacy values all read as Fast
  check("method: quality stays quality", normalizeInpaintMethod("quality") === "quality");
  check("method: missing reads as fast", normalizeInpaintMethod(undefined) === "fast");
  for (const legacy of ["auto", "telea", "fast", null, 42]) {
    check(
      `method: legacy ${JSON.stringify(legacy)} reads as fast`,
      normalizeInpaintMethod(legacy) === "fast",
    );
  }
}

// LMT-014 structural guard — the Quality path must report measured,
// per-cluster truth and must never re-derive a half-painted page from the
// original scan. Behaviour lives behind canvas/ONNX, so assert on the wiring.
{
  const { readFileSync } = await import("node:fs");
  const ladderSrc = readFileSync(
    new URL("../src/lib/inpaint/ladder.ts", import.meta.url),
    "utf8",
  );
  const lamaSrc = readFileSync(
    new URL("../src/lib/inpaint/lama.ts", import.meta.url),
    "utf8",
  );

  check(
    "quality: per-region ms is never a page total divided by box count",
    !/totalMs\s*\/\s*bboxes\.length/.test(ladderSrc),
  );
  check(
    "quality: regions come from the LaMa records, not from bboxes.map",
    /mergeQualityRegions\(/.test(ladderSrc) &&
      !/bboxes\.map\(\(_, i\) => \(\{\s*index: i,\s*method: "lama"/.test(ladderSrc),
  );
  // The Quality body, sliced so the guards below cannot be satisfied by the
  // Fast path's own openPage/getImageData calls elsewhere in the file.
  const qStart = ladderSrc.indexOf("export async function inpaintImageQuality");
  const qEnd = ladderSrc.indexOf("async function runRung", qStart);
  const qualitySrc = qStart >= 0 && qEnd > qStart ? ladderSrc.slice(qStart, qEnd) : "";
  check("quality: inpaintImageQuality body located for structural guards", qualitySrc.length > 0);
  check(
    "quality: opens the page without holding a pixel copy across LaMa",
    /openCanvas\(/.test(qualitySrc) && !/openPage\(/.test(qualitySrc),
  );
  check(
    "quality: fallback paints only the uncovered regions of the working page",
    /paintFastRegions\(working, bboxes, lama\.uncovered/.test(qualitySrc),
  );
  {
    const lamaAt = qualitySrc.indexOf("renderLamaPatches(");
    const readAt = qualitySrc.indexOf("ctx.getImageData(0, 0, canvas.width, canvas.height)");
    check(
      "quality: the fallback reads the canvas AFTER LaMa (painted patches survive)",
      lamaAt >= 0 && readAt > lamaAt,
    );
  }
  check(
    "quality: no PNG re-encode/re-open round trip of the painted page",
    !/openPage\(canvas\.toDataURL/.test(ladderSrc),
  );
  check(
    "quality: never falls back to a whole-page Fast rerun from the source image",
    !/return await inpaintImageAuto\(imageSrc/.test(ladderSrc),
  );
  check(
    "quality: size-skipped clusters are recorded, not silently continued",
    /outcome:\s*"skipped-size"/.test(lamaSrc) &&
      !/if \(pw < 8 \|\| ph < 8\) continue;/.test(lamaSrc),
  );
  check(
    "quality: the minimum patch size is a named constant",
    /LAMA_MIN_PATCH_DIM/.test(lamaSrc),
  );
  check(
    "quality: painted-ness is derived from cluster records, not asserted",
    /if \(r\.outcome === "painted"\)/.test(lamaSrc),
  );
  check(
    "contract: the Fast path asserts one region record per box",
    /assertRegionCoverage\(regions, bboxes\.length, "fast"\)/.test(ladderSrc),
  );
  check(
    "contract: the Quality path asserts one region record per box",
    /assertRegionCoverage\(regions, bboxCount, "quality"\)/.test(ladderSrc),
  );
  check(
    "contract: an unowned region throws instead of shifting bubbles",
    /has no owner/.test(ladderSrc),
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nladder self-check: all passed");
