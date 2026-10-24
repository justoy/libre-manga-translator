import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  classOf,
  cjkShare,
  isJapaneseBlock,
  japaneseCharCount,
  classShare,
} from "../../src/lib/gate/charset";
import {
  translateWithServer,
  testServerConnection,
  type ServerConfig,
} from "../../src/lib/server/main";

const ASSETS_DIR = path.resolve(import.meta.dirname, "../assets");

describe("test assets existence & integrity", () => {
  const assets = [
    "inpainting-test.png",
    "vertical-japanese-test.png",
    "horizontal-japanese-test.png",
    "korean-test.png",
    "chinese-vertical-test.jpg",
  ];

  for (const asset of assets) {
    it(`verifies ${asset} exists and has valid image headers`, () => {
      const filePath = path.join(ASSETS_DIR, asset);
      expect(fs.existsSync(filePath)).toBe(true);

      const buffer = fs.readFileSync(filePath);
      expect(buffer.length).toBeGreaterThan(1000);

      if (asset.endsWith(".png")) {
        expect(buffer[0]).toBe(0x89);
        expect(buffer[1]).toBe(0x50);
        expect(buffer[2]).toBe(0x4e);
        expect(buffer[3]).toBe(0x47);
      } else if (asset.endsWith(".jpg")) {
        expect(buffer[0]).toBe(0xff);
        expect(buffer[1]).toBe(0xd8);
      }
    });
  }
});

describe("script classification for asset language targets", () => {
  it("classifies Japanese manga text (from vertical-japanese-test.png)", () => {
    const text = "これはあたしとセラの冒険のお話。苦しみと喜びを分かち合いながら旅してる";
    expect(cjkShare(text)).toBeGreaterThan(0.9);
    expect(japaneseCharCount(text)).toBeGreaterThan(10);
    for (const char of "これはあたしとセラの冒険のお話") {
      expect(isJapaneseBlock(char.codePointAt(0)!)).toBe(true);
    }
  });

  it("classifies Japanese horizontal text (from inpainting-test.png)", () => {
    const text = "今日が引退前の最後の日になると思う。あら エドワード… もう店を出ていくの？";
    expect(cjkShare(text)).toBeGreaterThan(0.9);
    expect(japaneseCharCount(text)).toBeGreaterThan(10);
    for (const char of "今日が引退前の最後の日になると思う") {
      expect(isJapaneseBlock(char.codePointAt(0)!)).toBe(true);
    }
  });

  it("classifies Korean manhwa text (from korean-test.png)", () => {
    const text = "저기... 총각 뭐 좀 물어볼게. 코엔지역은 이리로 가면 될까?";
    for (const char of "저기총각뭐좀물어볼게코엔지역은이리로가면될까") {
      expect(classOf(char.codePointAt(0)!)).toBe("hangul");
    }
    expect(classShare(text, ["hangul"])).toBeGreaterThan(0.7);
  });

  it("classifies Chinese manhua text (from chinese-vertical-test.jpg)", () => {
    const text = "各位贵宾，请自由拿取这边的餐点。三越餐厅的新菜单试吃会，现正举办中！";
    for (const char of "各位贵宾请自由拿取这边的餐点三越餐厅的新菜单试吃会现正举办中") {
      expect(classOf(char.codePointAt(0)!)).toBe("han");
    }
    expect(classShare(text, ["han"])).toBeGreaterThan(0.8);
  });
});

const apiConfig: ServerConfig = {
  serverHost: "http://localhost:8033/v1",
  serverSchema: "openai",
  serverModel: "tiny-aya-fire-q4_k_m",
  useServerApiKey: false,
  serverApiKey: "",
  temperature: 0.3,
};

const targetLang = "English";

// Probed at module load rather than in `beforeAll`: the skip decision has to
// exist before the suite is declared. An early `return` inside a test body
// still records a PASS, so an offline server used to look like green coverage.
// Bounded, because module load sits outside every test timeout: a listener
// that accepts the socket but never answers would otherwise hang the run.
const PROBE_TIMEOUT_MS = 3000;
let probeTimer: ReturnType<typeof setTimeout> | undefined;
const liveServer = await Promise.race([
  testServerConnection(apiConfig).catch(() => null),
  new Promise<null>((resolve) => {
    probeTimer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
  }),
]);
clearTimeout(probeTimer);
const serverAvailable = liveServer?.success === true;

if (!serverAvailable) {
  console.warn(
    `Live LLM suite SKIPPED: nothing answered http://localhost:8033/v1 within ${PROBE_TIMEOUT_MS}ms (boot lmt-mock-server to run it)`,
  );
}

const describeLive = serverAvailable ? describe : describe.skip;

describeLive("API Mode translation check (tiny-aya-fire-q4_k_m)", () => {
  it("validates server connection on localhost:8033/v1", async () => {
    const connection = await testServerConnection(apiConfig);
    expect(connection.success).toBe(true);
    expect(connection.models).toContain("tiny-aya-fire-q4_k_m");
  });

  it("translates real dialogue from vertical-japanese-test.png", async () => {
    const bubbles = [
      "これはあたしとセラの冒険のお話",
      "いつかまた家族として一緒になれるように！",
      "苦しみと喜びを分かち合いながらあたしたちはこの分断された世界を旅してる",
      "はじまりはじまり～",
    ];
    const result = await translateWithServer(
      bubbles,
      targetLang,
      "Japanese",
      undefined,
      apiConfig,
    );

    expect(result.translations.length).toBe(bubbles.length);
    for (const trans of result.translations) {
      expect(typeof trans).toBe("string");
      expect(trans.length).toBeGreaterThan(0);
      expect(trans.toLowerCase()).toMatch(/[a-z]/);
    }
  });

  it("translates real dialogue from korean-test.png", async () => {
    const bubbles = [
      "저기... 총각 뭐 좀 물어볼게",
      "코エン지역은 이리로 가면 될까?",
    ];
    const result = await translateWithServer(
      bubbles,
      targetLang,
      "Korean",
      undefined,
      apiConfig,
    );

    expect(result.translations.length).toBe(bubbles.length);
    for (const trans of result.translations) {
      expect(typeof trans).toBe("string");
      expect(trans.length).toBeGreaterThan(0);
      expect(trans.toLowerCase()).toMatch(/[a-z]/);
    }
  });

  it("translates real dialogue from chinese-vertical-test.jpg", async () => {
    const bubbles = [
      "各位贵宾，请自由拿取这边的餐点",
      "三越餐厅的新菜单试吃会，现正举办中！",
      "但作为交换，请务必告诉我们您的意见",
      "意见箱在这边",
    ];
    const result = await translateWithServer(
      bubbles,
      targetLang,
      "Chinese",
      undefined,
      apiConfig,
    );

    expect(result.translations.length).toBe(bubbles.length);
    for (const trans of result.translations) {
      expect(typeof trans).toBe("string");
      expect(trans.length).toBeGreaterThan(0);
      expect(trans.toLowerCase()).toMatch(/[a-z]/);
    }
  });
});
