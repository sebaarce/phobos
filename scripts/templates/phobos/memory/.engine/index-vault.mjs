#!/usr/bin/env node
// Indexes vault/memory/{insights,wiki,glossary}/**/*.md into Qdrant.
//
// El engine vive GLOBALMENTE en <base>/memory-engine/. Recibe el path
// absoluto del proyecto vía --project para resolver config + state local.
//
// Usage (vía launcher local — recomendado):
//   node vault/memory/.engine/launcher.mjs index             # full reindex
//   node vault/memory/.engine/launcher.mjs index --incremental
//
// Usage (invocación directa):
//   node ~/.phobos/memory-engine/index-vault.mjs --project <abs-path>
//
// Idempotente: re-running on unchanged files is a no-op (hash check skips them).

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { embed } from './embed.mjs';
import { chunkMarkdown, chunkId, contentHash } from './chunk.mjs';
import { ensureCollection, upsertPoints, deletePointsByFile, ping } from './qdrant-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseProjectFlag(argv) {
  const idx = argv.indexOf('--project');
  if (idx >= 0 && argv[idx + 1]) {
    const p = resolvePath(argv[idx + 1]);
    argv.splice(idx, 2);
    return p;
  }
  return null;
}

async function loadConfig(configPath) {
  const raw = await readFile(configPath, 'utf-8');
  return JSON.parse(raw);
}

async function loadState(statePath) {
  if (!existsSync(statePath)) return { files: {} };
  try {
    return JSON.parse(await readFile(statePath, 'utf-8'));
  } catch {
    return { files: {} };
  }
}

async function saveState(statePath, state) {
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

async function walkMarkdown(projectRoot, root) {
  const absRoot = join(projectRoot, root);
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

async function indexFile(filePath, projectRoot, config, state, force) {
  const relPath = relative(projectRoot, filePath).replace(/\\/g, '/');
  const content = await readFile(filePath, 'utf-8');
  const hash = await contentHash(content);

  const prevHash = state.files[relPath]?.hash;
  if (!force && prevHash === hash) {
    return { skipped: true, relPath };
  }

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

function deterministicId(relPath, chunkIndex) {
  const raw = chunkId(relPath, chunkIndex);
  let hash = 0n;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31n + BigInt(raw.charCodeAt(i))) & 0xFFFFFFFFFFFFFFFFn;
  }
  return Number(hash % BigInt(Number.MAX_SAFE_INTEGER));
}

async function main() {
  const argv = process.argv.slice(2);
  const projectRoot = parseProjectFlag(argv) || join(__dirname, '..', '..', '..');
  const incremental = argv.includes('--incremental');
  const force = argv.includes('--force');

  const configPath = join(projectRoot, 'vault', 'memory', '.engine', 'config.json');
  const statePath  = join(projectRoot, 'vault', 'memory', '.engine', '.index-state.json');

  console.log('[memory] project: ' + projectRoot);
  console.log('[memory] loading config...');
  const config = await loadConfig(configPath);

  console.log(`[memory] qdrant: ${config.qdrant.url}`);
  const alive = await ping(config.qdrant.url);
  if (!alive) {
    console.error(`[memory] qdrant unreachable at ${config.qdrant.url}`);
    console.error(`[memory] start it with: docker compose -f ~/.phobos/docker-compose.qdrant.yml up -d`);
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

  const state = await loadState(statePath);
  if (force) state.files = {};

  const allFiles = [];
  for (const root of config.vault.roots) {
    const files = await walkMarkdown(projectRoot, root);
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
    const result = await indexFile(file, projectRoot, config, state, force);
    if (result.skipped) {
      skipped++;
      if (!incremental) console.log(`  · ${result.relPath} (unchanged)`);
    } else {
      indexed++;
      totalChunks += result.chunks;
      console.log(`  ✓ ${result.relPath} → ${result.chunks} chunk(s)`);
    }
  }

  await saveState(statePath, state);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('');
  console.log(`[memory] done in ${elapsed}s: ${indexed} indexed, ${skipped} unchanged, ${totalChunks} chunks total`);
}

main().catch(err => {
  console.error('[memory] fatal:', err.message || err);
  process.exit(1);
});
