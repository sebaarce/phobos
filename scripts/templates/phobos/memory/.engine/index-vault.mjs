#!/usr/bin/env node
// Indexes vault/memory/{insights,wiki,glossary}/**/*.md into Qdrant.
//
// Usage:
//   node vault/memory/.engine/index-vault.mjs              # full reindex
//   node vault/memory/.engine/index-vault.mjs --incremental # only changed files
//
// Idempotent: re-running on unchanged files is a no-op (hash check skips them).

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { embed } from './embed.mjs';
import { chunkMarkdown, chunkId, contentHash } from './chunk.mjs';
import { ensureCollection, upsertPoints, deletePointsByFile, ping } from './qdrant-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CONFIG_PATH = join(__dirname, 'config.json');
const STATE_PATH = join(__dirname, '.index-state.json');

async function loadConfig() {
  const raw = await readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function loadState() {
  if (!existsSync(STATE_PATH)) return { files: {} };
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf-8'));
  } catch {
    return { files: {} };
  }
}

async function saveState(state) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function walkMarkdown(root) {
  const absRoot = join(PROJECT_ROOT, root);
  if (!existsSync(absRoot)) return [];
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  await walk(absRoot);
  return out;
}

async function indexFile(filePath, config, state, force) {
  const relPath = relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
  const content = await readFile(filePath, 'utf-8');
  const hash = await contentHash(content);

  const prevHash = state.files[relPath]?.hash;
  if (!force && prevHash === hash) {
    return { skipped: true, relPath };
  }

  // File changed — wipe old chunks first, then re-insert.
  await deletePointsByFile(
    config.qdrant.url,
    config.qdrant.collection,
    relPath,
  );

  const chunks = await chunkMarkdown(content, {
    size: config.chunking.size,
    overlap: config.chunking.overlap,
    minSize: config.chunking.minSize,
    modelName: config.model.name,
  });

  if (chunks.length === 0) {
    state.files[relPath] = { hash, chunks: 0, updatedAt: new Date().toISOString() };
    return { skipped: false, relPath, chunks: 0 };
  }

  // e5 models expect "passage: " prefix for documents (and "query: " for queries).
  const texts = chunks.map(c => `passage: ${c.text}`);
  const vectors = await embed(texts, {
    model: config.model.name,
    pooling: config.model.pooling,
    normalize: config.model.normalize,
  });

  const points = chunks.map((chunk, i) => ({
    id: deterministicId(relPath, i),
    vector: vectors[i],
    payload: {
      filePath: relPath,
      chunkIndex: i,
      sectionTitle: chunk.sectionTitle,
      text: chunk.text,
      hash,
      updatedAt: new Date().toISOString(),
    },
  }));

  await upsertPoints(config.qdrant.url, config.qdrant.collection, points);
  state.files[relPath] = { hash, chunks: chunks.length, updatedAt: new Date().toISOString() };

  return { skipped: false, relPath, chunks: chunks.length };
}

// Qdrant accepts unsigned 64-bit ints OR UUIDs as IDs. We hash the chunkId
// string (filePath + index) into a stable unsigned 64-bit integer.
function deterministicId(relPath, chunkIndex) {
  const raw = chunkId(relPath, chunkIndex);
  let hash = 0n;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31n + BigInt(raw.charCodeAt(i))) & 0xFFFFFFFFFFFFFFFFn;
  }
  // Qdrant point IDs must fit in u64; we return the integer as a number/string.
  return Number(hash % BigInt(Number.MAX_SAFE_INTEGER));
}

async function main() {
  const args = process.argv.slice(2);
  const incremental = args.includes('--incremental');
  const force = args.includes('--force');

  console.log('[memory] loading config...');
  const config = await loadConfig();

  console.log(`[memory] qdrant: ${config.qdrant.url}`);
  const alive = await ping(config.qdrant.url);
  if (!alive) {
    console.error(`[memory] qdrant unreachable at ${config.qdrant.url}`);
    console.error(`[memory] start it with: docker compose -f docker-compose.qdrant.yml up -d`);
    process.exit(1);
  }

  console.log(`[memory] model: ${config.model.name} (${config.model.dimensions}d)`);
  const { created } = await ensureCollection(
    config.qdrant.url,
    config.qdrant.collection,
    config.model.dimensions,
    config.qdrant.distance,
  );
  if (created) console.log(`[memory] created collection "${config.qdrant.collection}"`);

  const state = await loadState();
  if (force) state.files = {};

  // Collect all markdown files from configured roots.
  const allFiles = [];
  for (const root of config.vault.roots) {
    const files = await walkMarkdown(root);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    console.log('[memory] no markdown files found in vault.');
    return;
  }

  console.log(`[memory] indexing ${allFiles.length} file(s) ${incremental ? '(incremental)' : '(full)'}`);

  let indexed = 0, skipped = 0, totalChunks = 0;
  const start = Date.now();

  for (const file of allFiles) {
    const result = await indexFile(file, config, state, force);
    if (result.skipped) {
      skipped++;
      if (!incremental) console.log(`  · ${result.relPath} (unchanged)`);
    } else {
      indexed++;
      totalChunks += result.chunks;
      console.log(`  ✓ ${result.relPath} → ${result.chunks} chunk(s)`);
    }
  }

  await saveState(state);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('');
  console.log(`[memory] done in ${elapsed}s: ${indexed} indexed, ${skipped} unchanged, ${totalChunks} chunks total`);
}

main().catch(err => {
  console.error('[memory] fatal:', err.message || err);
  process.exit(1);
});
