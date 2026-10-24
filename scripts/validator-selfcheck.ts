import { parseLlmJson, validateTranslationResult } from "../src/lib/server/validator";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// Valid response
const valid = validateTranslationResult(
  {
    translations: ["Hello", "World"],
    sourceTexts: ["こんにちは", "世界"],
    context: { summary: "Manga chapter 1", dictionary: "term=def" },
  },
  2,
);
assert(valid.translations.length === 2, "translations length should be 2");
assert(valid.translations[0] === "Hello", "translation[0] should be Hello");
assert(valid.context?.summary === "Manga chapter 1", "summary should match");

// Count mismatch: healed by default, so one dropped box (usually an empty OCR
// box the model merged away) never fails the whole page. `strict` restores the
// older throw-on-mismatch contract. This script previously asserted the old
// behaviour as the only contract and had been failing unnoticed ever since.
const padded = validateTranslationResult({ translations: ["One"] }, 2);
assert(padded.translations.length === 2, "Short array must be padded to the expected count");
assert(padded.translations[1] === "", "Padded slots must be empty strings, not undefined");

const truncated = validateTranslationResult({ translations: ["A", "B", "C"] }, 2);
assert(truncated.translations.length === 2, "Long array must be truncated to the expected count");

let strictThrown = false;
try {
  validateTranslationResult({ translations: ["One"] }, 2, { strict: true });
} catch {
  strictThrown = true;
}
assert(strictThrown, "strict: true must throw on count mismatch");

// Non-string items are coerced, never rejected: output index N must keep
// mirroring OCR box N, so a numeric or null item still has to yield a string.
const coerced = validateTranslationResult({ translations: [123, "Two"] }, 2);
assert(coerced.translations[0] === "123", "Numeric translation must coerce to a string");
assert(
  validateTranslationResult({ translations: [null, undefined] }, 2).translations.every(
    (t) => t === "",
  ),
  "null/undefined must coerce to an empty string",
);

// Non-object should throw
let nonObjectThrown = false;
try {
  validateTranslationResult("not an object", 0);
} catch {
  nonObjectThrown = true;
}
assert(nonObjectThrown, "Non-object must throw error");

// parseLlmJson: chatty LLM preamble + code fence + trailing explanation
const chatty = parseLlmJson(
  "Here’s the translation and analysis based on the provided dialogue:\n\n```json\n" +
    '{"translations": ["One", "None", "None"], "context": {"summary": "s", "dictionary": "None"}}\n' +
    "```\n\n### Explanation:\n1. **Summary**: polite request.",
);
assert(
  Array.isArray(chatty.translations) && chatty.translations.length === 3,
  "parseLlmJson must extract 3 translations from chatty markdown",
);

// parseLlmJson: raw object without fences
const raw = parseLlmJson('{"translations": ["A", "B"]}');
assert(raw.translations[0] === "A", "parseLlmJson must parse raw JSON");

// parseLlmJson: bare JSON array
const arr = parseLlmJson('["X", "Y"]');
assert(Array.isArray(arr) && arr[1] === "Y", "parseLlmJson must parse bare array");

// parseLlmJson: garbage must throw
let garbageThrown = false;
try {
  parseLlmJson("no json here at all");
} catch {
  garbageThrown = true;
}
assert(garbageThrown, "parseLlmJson must throw on unparseable content");

console.log("PASS: validateTranslationResult self-check passed.");
