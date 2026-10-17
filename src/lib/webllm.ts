import type { MLCEngine } from "@mlc-ai/web-llm";
import { DefaultConfig, defaultLlmModelId, normalizeLlmModel } from "./configs";
import { createLlmEngine } from "./llm-engine";
import { buildSiteRulePrompts, buildTranslationPrompts } from "./prompts";
import { parseLlmJson, validateTranslationResult } from "./server/validator";

let globalEngine: MLCEngine | null = null;
let currentlyLoadedModel: string | null = null;

export async function translateLocal(
  ocrResults: string[],
  targetLang: string,
  sourceLang: string,
  seriesContext?: SeriesContext,
  model = defaultLlmModelId(),
  temperature = DefaultConfig.llmTemperature,
): Promise<TranslateResult> {
  const resolvedModel = normalizeLlmModel(model);
  if (!ocrResults || ocrResults.length === 0) {
    return { translations: [] };
  }

  const { systemPrompt, userPrompt, schema } = buildTranslationPrompts(
    ocrResults,
    targetLang,
    sourceLang,
    seriesContext,
  );

  const raw = await runLLMModel(
    systemPrompt,
    userPrompt,
    schema,
    resolvedModel,
    temperature,
  );

  // One correction round-trip on count mismatch (usually dropped empty
  // boxes). The healed validator guarantees the count; the retry gives the
  // model a chance to place real text first.
  if (
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as Record<string, any>).translations) &&
    (raw as Record<string, any>).translations.length !== ocrResults.length
  ) {
    const received = (raw as Record<string, any>).translations.length;
    console.warn(
      `[webllm] count mismatch (received ${received}, expected ${ocrResults.length}) — requesting correction`,
    );
    const corrected = await runLLMModel(
      systemPrompt,
      `${userPrompt}\n\nCORRECTION: Your previous response contained ${received} items but EXACTLY ${ocrResults.length} are required — one per input box, same order, empty boxes as "". Return the full corrected JSON now.`,
      schema,
      resolvedModel,
      temperature,
    );
    return validateTranslationResult(corrected, ocrResults.length);
  }

  return validateTranslationResult(raw, ocrResults.length);
}

export async function makeSiteRuleLocal(
  title: string,
  path: string,
  model = defaultLlmModelId(),
  temperature = DefaultConfig.llmTemperature,
): Promise<AIGeneratedRule> {
  const resolvedModel = normalizeLlmModel(model);
  const { systemPrompt, userPrompt, schema } = buildSiteRulePrompts(
    title,
    path,
  );

  const raw = await runLLMModel(
    systemPrompt,
    userPrompt,
    schema,
    resolvedModel,
    temperature,
  );
  return raw.parsed as AIGeneratedRule;
}

async function runLLMModel(
  systemPrompt: string,
  userPrompt: string,
  schema: string,
  model: string,
  temperature: number,
) {
  if (!globalEngine) {
    globalEngine = await createLlmEngine();
  }

  if (currentlyLoadedModel !== model) {
    await globalEngine.reload(model);
    currentlyLoadedModel = model;
  }

  const t0 = performance.now();
  const reply = await globalEngine.chatCompletion({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature,
    response_format: {
      type: "json_object",
      schema,
    },
  });
  const totalMs = performance.now() - t0;

  const content = reply.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Local LLM returned empty response");
  }

  try {
    const parsed = parseLlmJson(content);
    return { parsed, llmPerf: extractWebLlmPerf(reply, totalMs) };
  } catch (error) {
    console.error("Failed to parse LLM output:", content);
    throw new Error(`Local LLM generated invalid JSON: ${(error as Error).message}`);
  }
}

/** Token stats from WebLLM usage (prefill/decode rates live in extra). */
function extractWebLlmPerf(
  reply: { usage?: { prompt_tokens?: number; completion_tokens?: number; extra?: { prefill_tokens_per_s?: number; decode_tokens_per_s?: number } } },
  totalMs: number,
): LlmPerf | undefined {
  const usage = reply?.usage;
  if (!usage) return undefined;
  const promptTps = usage.extra?.prefill_tokens_per_s;
  const genTps = usage.extra?.decode_tokens_per_s;
  return {
    ...(usage.prompt_tokens !== undefined
      ? { promptTokens: usage.prompt_tokens }
      : {}),
    ...(usage.completion_tokens !== undefined
      ? { completionTokens: usage.completion_tokens }
      : {}),
    ...(promptTps !== undefined ? { promptTps } : {}),
    ...(genTps !== undefined ? { genTps } : {}),
    totalMs,
  };
}
