// Markdown-aware chunker. Splits on `##` boundaries first (natural sections),
// then falls back to paragraphs when a section exceeds the target token size.
// Measures token counts with the real model tokenizer (not char heuristics)
// so the chunks fit cleanly in the embedding model's context.

import { countTokens } from './embed.mjs';

/**
 * Smart chunking. Returns an array of {text, sectionTitle} objects.
 * @param {string} content - raw markdown
 * @param {object} cfg - { size, overlap, minSize, modelName }
 */
export async function chunkMarkdown(content, cfg) {
  const { size, overlap, minSize, modelName } = cfg;

  // 1. Split by top-level sections (## headings act as natural boundaries).
  // Keeps the heading with the section body.
  const sections = content.split(/(?=^##\s)/m).filter(s => s.trim().length > 0);

  const chunks = [];

  for (const section of sections) {
    const titleMatch = section.match(/^##\s+(.+)$/m);
    const sectionTitle = titleMatch ? titleMatch[1].trim() : '';

    const sectionTokens = await countTokens(section, modelName);

    // Small section — emit as a single chunk.
    if (sectionTokens <= size) {
      if (sectionTokens >= minSize) {
        chunks.push({ text: section.trim(), sectionTitle });
      }
      continue;
    }

    // Large section — split by paragraphs with token-based packing + overlap.
    const paragraphs = section.split(/\n\n+/).filter(p => p.trim().length > 0);
    let current = '';
    let currentTokens = 0;

    for (const para of paragraphs) {
      const paraTokens = await countTokens(para, modelName);

      // Adding this paragraph would exceed the size — flush the current chunk.
      if (currentTokens + paraTokens > size && current) {
        chunks.push({ text: current.trim(), sectionTitle });

        // Overlap: start the next chunk with the tail of the previous one.
        if (overlap > 0) {
          const tail = await tailByTokens(current, overlap, modelName);
          current = tail + '\n\n' + para;
          currentTokens = (await countTokens(tail, modelName)) + paraTokens;
        } else {
          current = para;
          currentTokens = paraTokens;
        }
      } else {
        current = current ? current + '\n\n' + para : para;
        currentTokens += paraTokens;
      }
    }

    if (current && currentTokens >= minSize) {
      chunks.push({ text: current.trim(), sectionTitle });
    }
  }

  return chunks;
}

/**
 * Return the last ~tokenCount tokens of a string. Uses paragraph boundaries
 * when possible to avoid mid-sentence cuts.
 */
async function tailByTokens(text, tokenCount, modelName) {
  if (!text) return '';
  const paragraphs = text.split(/\n\n+/).reverse();
  let acc = '';
  let accTokens = 0;
  for (const para of paragraphs) {
    const t = await countTokens(para, modelName);
    if (accTokens + t > tokenCount && acc) break;
    acc = acc ? para + '\n\n' + acc : para;
    accTokens += t;
  }
  return acc;
}

/**
 * Deterministic chunk ID — file path + chunk index. Used as Qdrant point ID.
 */
export function chunkId(filePath, chunkIndex) {
  // Qdrant accepts unsigned 64-bit integers OR UUIDs as IDs.
  // We emit a deterministic UUID-like string so re-indexing replaces cleanly.
  const safe = filePath.replace(/[\\/]/g, '__').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safe}::${chunkIndex}`;
}

/**
 * Hash content to detect changes between indexing runs.
 */
export async function contentHash(text) {
  const { createHash } = await import('node:crypto');
  return createHash('sha1').update(text).digest('hex');
}
