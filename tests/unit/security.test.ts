import { describe, it, expect } from "bun:test";
import { isAllowedImageUrl } from "../../src/lib/security";

describe("isAllowedImageUrl SSRF protection", () => {
  it("rejects loopback and local hosts", () => {
    expect(isAllowedImageUrl("http://localhost:8080/img.jpg")).toBe(false);
    expect(isAllowedImageUrl("http://127.0.0.1:3000/img.jpg")).toBe(false);
    expect(isAllowedImageUrl("http://[::1]:3000/img.jpg")).toBe(false);
    expect(isAllowedImageUrl("http://app.local/pic.png")).toBe(false);
    expect(isAllowedImageUrl("http://router.lan/pic.png")).toBe(false);
    expect(isAllowedImageUrl("http://service.internal/pic.png")).toBe(false);
  });

  it("rejects RFC1918 private IPv4 addresses", () => {
    expect(isAllowedImageUrl("http://10.0.0.1/test.png")).toBe(false);
    expect(isAllowedImageUrl("http://172.20.0.1/test.png")).toBe(false);
    expect(isAllowedImageUrl("http://192.168.1.1/test.png")).toBe(false);
  });

  it("rejects cloud metadata link-local endpoints", () => {
    expect(isAllowedImageUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
  });

  it("rejects non-HTTP protocols", () => {
    expect(isAllowedImageUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedImageUrl("chrome://settings")).toBe(false);
    expect(isAllowedImageUrl("chrome-extension://xyz/test.png")).toBe(false);
    expect(isAllowedImageUrl("data:image/png;base64,abc")).toBe(false);
    expect(isAllowedImageUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects embedded credentials and integer/hex obfuscations", () => {
    expect(isAllowedImageUrl("http://user:pass@example.com/img.jpg")).toBe(false);
    expect(isAllowedImageUrl("http://2130706433/img.jpg")).toBe(false);
    expect(isAllowedImageUrl("http://0x7f000001/img.jpg")).toBe(false);
  });

  it("allows standard public HTTPS and HTTP image URLs", () => {
    expect(isAllowedImageUrl("https://example.com/manga.jpg")).toBe(true);
    expect(isAllowedImageUrl("https://uploads.mangadex.org/data/123.jpg")).toBe(true);
    expect(isAllowedImageUrl("http://images.example.com:80/pic.webp")).toBe(true);
  });
});
