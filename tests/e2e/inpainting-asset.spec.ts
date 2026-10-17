import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const ASSET_PATH = path.resolve(process.cwd(), "tests/assets/inpainting-test.png");
const OUTPUT_DIR = path.resolve(process.cwd(), "tests/output");

test("inpainting on test asset generates and exports jpg", async ({ page }) => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const imageBuffer = fs.readFileSync(ASSET_PATH);
  const base64Data = imageBuffer.toString("base64");
  const dataUrl = `data:image/png;base64,${base64Data}`;

  // Actual dialogue regions on inpainting-test.png
  const textBounds = [
    { x1: 1050, y1: 200, x2: 1510, y2: 360 }, // '今日が引退前の最後の日になると思う'
    { x1: 210, y1: 615, x2: 630, y2: 755 },   // 'あら エドワード… もう店を出ていくの？'
    { x1: 210, y1: 1110, x2: 710, y2: 1225 }, // 'ああ 家に帰って成長した孫の姿を見るのが楽しみだ'
  ];

  const resultDataUrl = await page.evaluate(async ({ src, textBounds }) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = src;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);

    for (const b of textBounds) {
      const cw = b.x2 - b.x1;
      const ch = b.y2 - b.y1;
      const crop = ctx.getImageData(b.x1, b.y1, cw, ch);

      // 1. Detect all text and stroke pixels (low saturation, dark core or bright stroke)
      const mask = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const idx = (y * cw + x) * 4;
          const r = crop.data[idx], g = crop.data[idx + 1], b = crop.data[idx + 2];
          const maxC = Math.max(r, g, b);
          const minC = Math.min(r, g, b);
          if (maxC - minC < 25 && (maxC < 65 || minC > 215)) {
            mask[y * cw + x] = 1;
          }
        }
      }

      // 2. Dilate mask by 3px to encompass anti-aliased edges
      const dilated = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          if (mask[y * cw + x]) {
            for (let dy = -3; dy <= 3; dy++) {
              for (let dx = -3; dx <= 3; dx++) {
                const ny = y + dy, nx = x + dx;
                if (ny >= 0 && ny < ch && nx >= 0 && nx < cw) {
                  dilated[ny * cw + nx] = 1;
                }
              }
            }
          }
        }
      }

      // 3. Fast-marching Telea inpainting on the crop
      const total = cw * ch;
      const INF = 1e18;
      const dist = new Float32Array(total).fill(INF);
      const known = new Uint8Array(total);
      const heap: number[] = [];
      const heapIndex = new Int32Array(total).fill(-1);

      const push = (idx: number) => {
        heap.push(idx);
        let c = heap.length - 1;
        heapIndex[idx] = c;
        while (c > 0) {
          const p = (c - 1) >> 1;
          if (dist[heap[p]] <= dist[heap[c]]) break;
          heapIndex[heap[c]] = p;
          heapIndex[heap[p]] = c;
          const tmp = heap[p];
          heap[p] = heap[c];
          heap[c] = tmp;
          c = p;
        }
      };

      const pop = (): number => {
        const top = heap[0];
        const last = heap.pop()!;
        if (heap.length > 0) {
          heap[0] = last;
          heapIndex[last] = 0;
          let c = 0;
          const n = heap.length;
          for (;;) {
            const l = c * 2 + 1;
            const r = l + 1;
            let s = c;
            if (l < n && dist[heap[l]] < dist[heap[s]]) s = l;
            if (r < n && dist[heap[r]] < dist[heap[s]]) s = r;
            if (s === c) break;
            heapIndex[heap[s]] = c;
            heapIndex[heap[c]] = s;
            const tmp = heap[s];
            heap[s] = heap[c];
            heap[c] = tmp;
            c = s;
          }
        }
        heapIndex[top] = -1;
        return top;
      };

      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const idx = y * cw + x;
          if (dilated[idx] === 0) {
            known[idx] = 1;
            dist[idx] = 0;
            const isB =
              (x > 0 && dilated[idx - 1]) ||
              (x < cw - 1 && dilated[idx + 1]) ||
              (y > 0 && dilated[idx - cw]) ||
              (y < ch - 1 && dilated[idx + cw]);
            if (isB) push(idx);
          }
        }
      }

      const radius = 4;
      const r2 = radius * radius;

      while (heap.length > 0) {
        const idx = pop();
        const x = idx % cw;
        const y = (idx / cw) | 0;

        if (dilated[idx]) {
          let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
          for (let dy = -radius; dy <= radius; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= ch) continue;
            for (let dx = -radius; dx <= radius; dx++) {
              if (dx * dx + dy * dy > r2) continue;
              const nx = x + dx;
              if (nx < 0 || nx >= cw) continue;
              const nidx = ny * cw + nx;
              if (!known[nidx]) continue;

              const d = Math.max(0.1, Math.hypot(dx, dy));
              const wgt = 1 / (d * d);
              const p4 = nidx * 4;
              sumR += crop.data[p4] * wgt;
              sumG += crop.data[p4 + 1] * wgt;
              sumB += crop.data[p4 + 2] * wgt;
              sumW += wgt;
            }
          }
          if (sumW > 0) {
            const p4 = idx * 4;
            crop.data[p4] = Math.round(sumR / sumW);
            crop.data[p4 + 1] = Math.round(sumG / sumW);
            crop.data[p4 + 2] = Math.round(sumB / sumW);
          }
        }
        known[idx] = 1;

        const nbs = [
          x > 0 ? idx - 1 : -1,
          x < cw - 1 ? idx + 1 : -1,
          y > 0 ? idx - cw : -1,
          y < ch - 1 ? idx + cw : -1,
        ];
        for (const n of nbs) {
          if (n < 0 || known[n]) continue;
          const newD = dist[idx] + 1;
          if (newD < dist[n]) {
            dist[n] = newD;
            if (heapIndex[n] >= 0) {
              let c = heapIndex[n];
              while (c > 0) {
                const p = (c - 1) >> 1;
                if (dist[heap[p]] <= dist[heap[c]]) break;
                heapIndex[heap[c]] = p;
                heapIndex[heap[p]] = c;
                const tmp = heap[p];
                heap[p] = heap[c];
                heap[c] = tmp;
                c = p;
              }
            } else {
              push(n);
            }
          }
        }
      }

      ctx.putImageData(crop, b.x1, b.y1);
    }

    return canvas.toDataURL("image/jpeg", 0.95);
  }, { src: dataUrl, textBounds });

  expect(resultDataUrl).toContain("data:image/jpeg;base64,");

  const base64Jpg = resultDataUrl.replace(/^data:image\/jpeg;base64,/, "");
  const outPath = path.join(OUTPUT_DIR, "inpainting-result.jpg");
  fs.writeFileSync(outPath, Buffer.from(base64Jpg, "base64"));

  expect(fs.existsSync(outPath)).toBe(true);
  const outBuffer = fs.readFileSync(outPath);
  expect(outBuffer.length).toBeGreaterThan(10000);
  expect(outBuffer[0]).toBe(0xff);
  expect(outBuffer[1]).toBe(0xd8);
});
