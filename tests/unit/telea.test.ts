import { describe, it, expect } from "bun:test";
import { teleaInpaint } from "../../src/lib/inpaint/telea";

function createMockImageData(
  width: number,
  height: number,
  initialRgba: [number, number, number, number] = [255, 255, 255, 255],
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 0] = initialRgba[0];
    data[i * 4 + 1] = initialRgba[1];
    data[i * 4 + 2] = initialRgba[2];
    data[i * 4 + 3] = initialRgba[3];
  }
  return { width, height, data } as unknown as ImageData;
}

describe("teleaInpaint fast-marching", () => {
  it("does nothing when mask is empty (0 masked pixels)", () => {
    const img = createMockImageData(10, 10, [100, 100, 100, 255]);
    const mask = new Uint8Array(100); // all 0
    teleaInpaint(img, mask);
    expect(img.data[0]).toBe(100);
    expect(img.data[396]).toBe(100); // R channel of last pixel
  });

  it("throws when mask covers >80% of image", () => {
    const img = createMockImageData(10, 10);
    const mask = new Uint8Array(100).fill(1); // 100% masked
    expect(() => teleaInpaint(img, mask)).toThrow("mask covers too much of the image");
  });

  it("inpaints a black center hole using surrounding white background", () => {
    const width = 10;
    const height = 10;
    const img = createMockImageData(width, height, [255, 255, 255, 255]); // white background
    const mask = new Uint8Array(width * height);

    // Create a 2x2 black box at (4,4) to (5,5)
    for (let y = 4; y <= 5; y++) {
      for (let x = 4; x <= 5; x++) {
        const idx = y * width + x;
        mask[idx] = 1;
        img.data[idx * 4 + 0] = 0; // Black
        img.data[idx * 4 + 1] = 0;
        img.data[idx * 4 + 2] = 0;
      }
    }

    // Before inpaint: masked pixels are black (0, 0, 0)
    const targetIdx = 4 * width + 4;
    expect(img.data[targetIdx * 4]).toBe(0);

    // Run Telea inpaint
    teleaInpaint(img, mask, 2);

    // After inpaint: masked pixels should be close to white (surrounding background)
    expect(img.data[targetIdx * 4]).toBeGreaterThan(200);
    expect(img.data[targetIdx * 4 + 1]).toBeGreaterThan(200);
    expect(img.data[targetIdx * 4 + 2]).toBeGreaterThan(200);
  });
});
