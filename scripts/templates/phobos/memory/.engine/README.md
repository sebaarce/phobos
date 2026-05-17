# Phobos Memory Engine — RAG over the vault

Semantic search over `vault/memory/insights/`, `vault/memory/wiki/`, and
`vault/memory/glossary/`. Used by the Researcher to retrieve relevant
prior context before writing a new `research.md`, and re-indexed by the
Archivist at the end of every Close task.

## Architecture

```
vault/memory/{insights,wiki,glossary}/**/*.md
        │
        │ chunk by markdown sections + paragraphs
        ▼
  @xenova/transformers   ←  Xenova/multilingual-e5-small (384d, multilingual)
        │
        │ vectors (Float32)
        ▼
   Qdrant @ localhost:6333 (Docker)
        │
        │ cosine similarity
        ▼
  search.mjs "query"  →  top-K chunks with wikilinks
```

## Files

| File | Purpose |
|------|---------|
| `config.json` | Single source of truth: model, chunking, qdrant URL, top-K |
| `embed.mjs` | Pipeline wrapper (cached) + tokenizer access |
| `chunk.mjs` | Markdown-aware chunker that respects sections + uses real tokens |
| `qdrant-client.mjs` | Wrapper over `@qdrant/js-client-rest` |
| `index-vault.mjs` | CLI: indexes the vault (full or `--incremental`) |
| `search.mjs` | CLI: semantic query, human or `--json` output |
| `.index-state.json` | (generated) Per-file SHA-1 hash for incremental indexing |

## Setup

The Phobos installer wizard creates everything for you (recommended):

```bash
npx github:sebaarce/phobos
# → main menu → "Memory (RAG)"
```

The wizard:
1. Detects Docker, Node, and `package.json`.
2. Installs `@xenova/transformers` and `@qdrant/js-client-rest` with your package manager.
3. Copies this engine to `vault/memory/.engine/`.
4. Creates `~/.phobos/docker-compose.qdrant.yml` (shared by all your Phobos projects).
5. Starts the global Qdrant container if not already running.
6. Indexes your vault into a project-specific collection.

### Manual setup (advanced)

```bash
# install deps
npm install @xenova/transformers @qdrant/js-client-rest

# create global qdrant home + compose
mkdir -p ~/.phobos/qdrant-storage
cp <phobos-repo>/scripts/templates/phobos/memory/docker-compose.qdrant.yml ~/.phobos/

# start qdrant
docker compose -f ~/.phobos/docker-compose.qdrant.yml up -d

# edit vault/memory/.engine/config.json to set a unique collection name:
#   "collection": "phobos-vault-<your-project-slug>"

# index
node vault/memory/.engine/index-vault.mjs
```

## Global Qdrant model

Qdrant runs as a **single shared instance** at `~/.phobos/` on your machine.
Every Phobos project gets its **own collection** inside that instance,
named after the project (`phobos-vault-<slug>`).

That means:

- Working on multiple projects? No port conflicts, no container conflicts.
- One `docker compose up -d` powers all projects.
- Each project's vectors are isolated by collection.
- Storage lives in `~/.phobos/qdrant-storage/` (single location, shared disk usage).

To stop Qdrant globally (frees ~30 MB RAM):

```bash
docker compose -f ~/.phobos/docker-compose.qdrant.yml down
```

To resume:

```bash
docker compose -f ~/.phobos/docker-compose.qdrant.yml up -d
```

## Usage

**Search from the shell**:

```bash
node vault/memory/.engine/search.mjs "jwt refresh token rotation" --top 5
```

**Search and get JSON for tooling**:

```bash
node vault/memory/.engine/search.mjs "jwt refresh" --json
```

**Re-index after editing notes manually**:

```bash
node vault/memory/.engine/index-vault.mjs --incremental
```

**Force full re-index** (e.g., after changing the model):

```bash
node vault/memory/.engine/index-vault.mjs --force
```

## Configuration

Edit `config.json`. Common changes:

- `search.topK` — number of chunks returned per query (default 5).
- `search.similarityThreshold` — minimum cosine score to include (default 0.7).
- `chunking.size` — token-size of each chunk (default 512).
- `model.name` — swap for `Xenova/all-MiniLM-L6-v2` (faster, English-only) or
  `Xenova/multilingual-e5-base` (larger, more accurate). After changing,
  re-run with `--force`.

## How agents use it

- **Researcher** (pre-flight): before writing `research.md`, invokes
  `search.mjs "<goal>"` and includes top-3 results under a
  `## Previous insights` section with wikilinks.
- **Archivist** (post-close): after writing `conclusion.md` and distilling
  to insights/wiki/glossary, invokes `index-vault.mjs --incremental` so the
  next task sees the new content.

If Qdrant is not running, both agents degrade gracefully: the Researcher
notes "(memory engine unreachable)" in `## Previous insights` and the
Archivist logs a follow-up.

## Troubleshooting

**`Qdrant unreachable`**
Run `docker ps`. If no Qdrant container is listed, start it with the
compose file. If port 6333 is taken, edit `docker-compose.qdrant.yml` and
`config.json` together to use a different port.

**First indexing is slow**
First run downloads the model (~80 MB) into `node_modules/.cache/`.
Subsequent runs are cached and much faster.

**Vault changes not appearing in search**
Re-index. The Archivist does this automatically on Close, but if you
edited insights manually, run `index-vault.mjs --incremental` yourself.

## Storage size

| Vault size | Approx Qdrant disk | RAM during index |
|------------|--------------------|------------------|
| 50 insights | ~5 MB | ~400 MB |
| 200 insights | ~20 MB | ~400 MB |
| 1000 insights | ~100 MB | ~500 MB |

The transformer model uses ~400 MB of RAM regardless of vault size. Qdrant
uses ~30 MB base + ~100 KB per chunk.
