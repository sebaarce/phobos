// Embedding engine — @xenova/transformers (local, WASM/WebGPU).
// First call downloads the model (~80 MB) into node_modules/.cache; subsequent
// calls reuse it. The pipeline is cached at module-level — do not re-create
// it in a hot loop.

import { pipeline, env } from '@xenova/transformers';

// Disable telemetry and remote calls outside HF model hub.
env.allowRemoteModels = true;
env.allowLocalModels = true;

let cachedExtractor = null;
let cachedModelName = null;

/**
 * Load (or reuse) the feature-extraction pipeline.
 */
export async function getExtractor(modelName) {
  if (cachedExtractor && cachedModelName === modelName) {
    return cachedExtractor;
  }
  // Quantized fp32 model — small and fast. Set `quantized: true` for int8.
  cachedExtractor = await pipeline('feature-extraction', modelName, {
    quantized: true,
  });
  cachedModelName = modelName;
  return cachedExtractor;
}

/**
 * Embed a batch of texts. Returns Float32Array vectors.
 * @param {string[]} texts - input strings
 * @param {object} opts
 * @param {string} opts.model - HF model id (e.g. "Xenova/multilingual-e5-small")
 * @param {string} opts.pooling - "mean" | "cls"
 * @param {boolean} opts.normalize - L2-normalize the output
 * @returns {Promise<number[][]>}
 */
export async function embed(texts, opts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const extractor = await getExtractor(opts.model);

  // multilingual-e5 expects a prefix: "query: ..." for queries, "passage: ..." for documents.
  // We use "passage: " by default; the search.mjs script can override with "query: ".
  const output = await extractor(texts, {
    pooling: opts.pooling || 'mean',
    normalize: opts.normalize !== false,
  });

  // output.data is a Float32Array flattened across batch; reshape into rows.
  const dim = output.dims[output.dims.length - 1];
  const rows = [];
  for (let i = 0; i < texts.length; i++) {
    rows.push(Array.from(output.data.slice(i * dim, (i + 1) * dim)));
  }
  return rows;
}

/**
 * Convenience: embed a single string.
 */
export async function embedOne(text, opts) {
  const [vec] = await embed([text], opts);
  return vec;
}

/**
 * Get the tokenizer associated with the loaded model — used by chunk.mjs to
 * measure real token counts instead of character heuristics.
 */
export async function getTokenizer(modelName) {
  const extractor = await getExtractor(modelName);
  return extractor.tokenizer;
}

/**
 * Count tokens of a string using the real model tokenizer.
 */
export async function countTokens(text, modelName) {
  const tokenizer = await getTokenizer(modelName);
  const encoded = tokenizer.encode(text);
  return encoded.length;
}
