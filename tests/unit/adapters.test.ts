import { describe, it, expect } from "bun:test";
import { COMMUNITY_RULES } from "../../src/lib/adapters";

describe("COMMUNITY_RULES integrity", () => {
  it("includes trusted core rules", () => {
    const ids = COMMUNITY_RULES.map((r) => r.id);
    expect(ids).toContain("mangadex");
    expect(ids).toContain("nhentai");
  });

  it("ensures all regex patterns are syntactically valid", () => {
    for (const rule of COMMUNITY_RULES) {
      expect(() => new RegExp(rule.seriesName.regex)).not.toThrow();
      expect(() => new RegExp(rule.chapterId.regex)).not.toThrow();
      expect(() => new RegExp(rule.pageIndex.regex)).not.toThrow();
    }
  });

  it("correctly extracts metadata using mangadex rule", () => {
    const rule = COMMUNITY_RULES.find((r) => r.id === "mangadex");
    expect(rule).toBeDefined();

    const title = "Chapter 1 - Frieren at the Funeral - MangaDex";
    const path = "/chapter/abc-123-def/4";

    const titleMatch = title.match(new RegExp(rule!.seriesName.regex));
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![1]?.trim()).toBe("Frieren at the Funeral");

    const chapterMatch = path.match(new RegExp(rule!.chapterId.regex));
    expect(chapterMatch).not.toBeNull();
    expect(chapterMatch![1]).toBe("abc-123-def");

    const pageMatch = path.match(new RegExp(rule!.pageIndex.regex));
    expect(pageMatch).not.toBeNull();
    expect(pageMatch![1]).toBe("4");
  });
});
