#!/usr/bin/env node
// Semantic search CLI for the Researcher (and humans).
//
// Usage:
//   node vault/memory/.engine/search.mjs "<query>" [--top 5] [--json]
//
// Output (default human format):
//   Markdown-friendly bullets with wikilinks to source notes.
//
// Output (--json):
//   JSON array suitable for downstream tools.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { embed } from './embed.mjs';
import { search, ping } from './qdrant-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');

async function loadConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
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

function formatHuman(results) {
  if (results.length === 0) {
    return '_(no semantic matches above threshold)_';
  }
  const lines = [];
  for (const r of results) {
    const file = r.payload.filePath;
    // Extract a slug-ish name for the wikilink: filename without extension.
    const base = file.split('/').pop().replace(/\.md$/, '');
    const section = r.payload.sectionTitle ? ` § ${r.payload.sectionTitle}` : '';
    lines.push(`- **[[${base}]]**${section}  _(similarity ${r.score.toFixed(3)})_`);
    // Indented excerpt — keep it short, the consumer can read the file.
    const excerpt = r.payload.text.length > 280
      ? r.payload.text.slice(0, 280) + '…'
      : r.payload.text;
    lines.push('  > ' + excerpt.replace(/\n/g, '\n  > '));
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    console.error('Usage: node search.mjs "<query>" [--top N] [--json]');
    process.exit(2);
  }

  const config = await loadConfig();
  const topK = args.top || config.search.topK;
  const threshold = config.search.similarityThreshold;

  if (!await ping(config.qdrant.url)) {
    if (args.json) {
      console.log(JSON.stringify({ error: 'qdrant unreachable', results: [] }));
    } else {
      console.error('[memory] qdrant unreachable — start it with: docker compose -f docker-compose.qdrant.yml up -d');
    }
    process.exit(1);
  }

  // e5 expects "query: " prefix at search time.
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
