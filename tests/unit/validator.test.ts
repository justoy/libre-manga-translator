import { describe, it, expect } from "bun:test";
import { parseLlmJson, validateTranslationResult } from "../../src/lib/server/validator";

describe("parseLlmJson", () => {
  it("parses pure JSON", () => {
    const res = parseLlmJson('{"translations": ["Hello", "World"]}');
    expect(res.translations).toEqual(["Hello", "World"]);
  });

  it("extracts JSON from markdown codeblock", () => {
    const text = "```json\n{\"translations\": [\"One\", \"Two\"]}\n```";
    expect(parseLlmJson(text).translations).toEqual(["One", "Two"]);
  });

  it("extracts JSON from raw fenced codeblock with LLM conversation preamble", () => {
    const text = "Sure! Here is the output:\n```\n{\"translations\": [\"Alpha\", \"Beta\"]}\n```\nHope this helps!";
    expect(parseLlmJson(text).translations).toEqual(["Alpha", "Beta"]);
  });

  it("extracts raw outermost JSON object when fences are missing", () => {
    const text = "Here you go: {\"translations\": [\"Raw\"]} have a great day!";
    expect(parseLlmJson(text).translations).toEqual(["Raw"]);
  });

  it("extracts raw outermost JSON array", () => {
    const text = "Prefix [\"First\", \"Second\"] suffix";
    expect(parseLlmJson(text)).toEqual(["First", "Second"]);
  });

  it("throws for unparseable input", () => {
    expect(() => parseLlmJson("not json at all")).toThrow("Failed to parse server JSON");
  });
});

describe("validateTranslationResult", () => {
  it("validates well-formed translation and preserves context and sourceTexts", () => {
    const input = {
      translations: ["Hello", "World"],
      sourceTexts: ["こんにちは", "世界"],
      context: { summary: "Chapter 1", dictionary: "A=B" },
    };
    const result = validateTranslationResult(input, 2);
    expect(result.translations).toEqual(["Hello", "World"]);
    expect(result.sourceTexts).toEqual(["こんにちは", "世界"]);
    expect(result.context?.summary).toBe("Chapter 1");
    expect(result.context?.dictionary).toBe("A=B");
  });

  it("coerces non-string items cleanly into strings", () => {
    const input = {
      translations: [123, null, undefined, { key: "val" }, "valid"],
    };
    const result = validateTranslationResult(input, 5);
    expect(result.translations[0]).toBe("123");
    expect(result.translations[1]).toBe("");
    expect(result.translations[2]).toBe("");
    expect(result.translations[3]).toBe('{"key":"val"}');
    expect(result.translations[4]).toBe("valid");
  });

  it("heals count mismatch in default non-strict mode", () => {
    // Array too short: pads with ""
    const shortRes = validateTranslationResult({ translations: ["OnlyOne"] }, 3);
    expect(shortRes.translations).toEqual(["OnlyOne", "", ""]);

    // Array too long: truncates
    const longRes = validateTranslationResult({ translations: ["A", "B", "C", "D"] }, 2);
    expect(longRes.translations).toEqual(["A", "B"]);
  });

  it("throws on count mismatch when strict: true", () => {
    expect(() => {
      validateTranslationResult({ translations: ["One"] }, 3, { strict: true });
    }).toThrow("Translation count mismatch");
  });

  it("throws when translations is not an array or response is not object", () => {
    expect(() => validateTranslationResult(null, 1)).toThrow("not an object");
    expect(() => validateTranslationResult({ translations: "not array" }, 1)).toThrow("must be an array");
  });

  it("throws when sourceTexts is not an array", () => {
    expect(() => {
      validateTranslationResult({ translations: ["A"], sourceTexts: "bad" }, 1);
    }).toThrow("'sourceTexts' must be an array");
  });
});
