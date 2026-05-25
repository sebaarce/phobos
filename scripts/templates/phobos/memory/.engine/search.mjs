#!/usr/bin/env node
// Semantic search CLI for the Researcher (and humans).
//
// El engine vive GLOBALMENTE en <base>/memory-engine/. Recibe el path
// absoluto del proyecto vía --project para resolver el config.json local.
//
// Usage (vía launcher local — recomendado):
//   node vault/memory/.engine/launcher.mjs search "<query>" [--top 5] [--json]
//
// Usage (invocación directa del engine global):
//   node ~/.phobos/memory-engine/search.mjs --project <abs-path> "<query>" [--top 5] [--json]

import { readFile } from 'node:fs/promises';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { embed } from './embed.mjs';
import { search, ping } from './qdrant-client.mjs';

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

function parseArgs(argv) {
  const args = { query: '', top: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') { args.top = parseInt(argv[++i], 10); }
    else if (a === '--json') { args.json = true; }
    else if (!args.query) { args.query = a; }
  }
  return args;
}

async function loadConfig(configPath) {
  return JSON.parse(await readFile(configPath, 'utf-8'));
}

function formatHuman(results) {
  if (results.length === 0) {
    return '_(no semantic matches above threshold)_';
  }
  const lines = [];
  for (const r of results) {
    const file = r.payload.filePath;
    const base = file.split('/').pop().replace(/\.md$/, '');
    const section = r.payload.sectionTitle ? ` § ${r.payload.sectionTitle}` : '';
    lines.push(`- **[[${base}]]**${section}  _(similarity ${r.score.toFixed(3)})_`);
    const excerpt = r.payload.text.length > 280
      ? r.payload.text.slice(0, 280) + '…'
      : r.payload.text;
    lines.push('  > ' + excerpt.replace(/\n/g, '\n  > '));
  }
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  // Project root: vía --project (engine global) o fallback __dirname (engine local legacy)
  const projectRoot = parseProjectFlag(argv) || join(__dirname, '..', '..', '..');
  const configPath = join(projectRoot, 'vault', 'memory', '.engine', 'config.json');

  const args = parseArgs(argv);
  if (!args.query) {
    console.error('Usage: search.mjs [--project <abs-path>] "<query>" [--top N] [--json]');
    process.exit(2);
  }

  const config = await loadConfig(configPath);
  const topK = args.top || config.search.topK;
  const threshold = config.search.similarityThreshold;

  if (!await ping(config.qdrant.url)) {
    if (args.json) {
      console.log(JSON.stringify({ error: 'qdrant unreachable', results: [] }));
    } else {
      console.error('[memory] qdrant unreachable — start it with: docker compose -f ~/.phobos/docker-compose.qdrant.yml up -d');
    }
    process.exit(1);
  }

  const [vec] = await embed([`query: ${args.query}`], {
    model: config.model.name,
    pooling: config.model.pooling,
    normalize: config.model.normalize,
  });

  const results = await search(
    config.qdrant.url,
    config.qdrant.collection,
    vec,
    topK,
    threshold,
  );

  if (args.json) {
    console.log(JSON.stringify({
      query: args.query,
      threshold,
      topK,
      results: results.map(r => ({
        id: r.id,
        score: r.score,
        filePath: r.payload.filePath,
        sectionTitle: r.payload.sectionTitle,
        text: r.payload.text,
      })),
    }, null, 2));
  } else {
    console.log(formatHuman(results));
  }
}

main().catch(err => {
  console.error('[memory] fatal:', err.message || err);
  process.exit(1);
});
