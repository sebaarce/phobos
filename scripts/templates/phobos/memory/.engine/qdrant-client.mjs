// Qdrant client wrapper — uses the official @qdrant/js-client-rest.
// Talks to a Qdrant instance running locally (default: http://localhost:6333).
// Start it with: `docker compose -f docker-compose.qdrant.yml up -d`

import { QdrantClient } from '@qdrant/js-client-rest';

let cachedClient = null;

export function getClient(qdrantUrl) {
  if (cachedClient) return cachedClient;
  cachedClient = new QdrantClient({ url: qdrantUrl });
  return cachedClient;
}

/**
 * Ensure the collection exists with the right vector size + distance metric.
 * Creates it if missing; verifies dimensions if it already exists.
 */
export async function ensureCollection(qdrantUrl, collection, dimensions, distance) {
  const client = getClient(qdrantUrl);
  try {
    const info = await client.getCollection(collection);
    const existingDim = info.config?.params?.vectors?.size;
    if (existingDim && existingDim !== dimensions) {
      throw new Error(
        `Collection "${collection}" exists with dimensions=${existingDim}, but config says ${dimensions}. ` +
        `Delete the collection (qdrant dashboard at http://localhost:6333/dashboard) or change the model.`
      );
    }
    return { created: false };
  } catch (err) {
    // If collection doesn't exist, create it. The client throws a "Not found" error.
    if (err.status === 404 || /not found/i.test(err.message || '')) {
      await client.createCollection(collection, {
        vectors: { size: dimensions, distance },
      });
      return { created: true };
    }
    throw err;
  }
}

/**
 * Upsert a batch of points. Each point has { id, vector, payload }.
 * Payload includes: filePath, chunkIndex, sectionTitle, text, hash, updatedAt.
 */
export async function upsertPoints(qdrantUrl, collection, points) {
  if (points.length === 0) return { upserted: 0 };
  const client = getClient(qdrantUrl);
  // Qdrant batch size limit ~ 64k bytes per request — chunk to be safe.
  const BATCH = 64;
  let total = 0;
  for (let i = 0; i < points.length; i += BATCH) {
    const slice = points.slice(i, i + BATCH);
    await client.upsert(collection, {
      wait: true,
      points: slice,
    });
    total += slice.length;
  }
  return { upserted: total };
}

/**
 * Delete points by filter (e.g., all points for a specific filePath).
 * Used during incremental indexing to remove stale chunks.
 */
export async function deletePointsByFile(qdrantUrl, collection, filePath) {
  const client = getClient(qdrantUrl);
  try {
    await client.delete(collection, {
      wait: true,
      filter: {
        must: [{ key: 'filePath', match: { value: filePath } }],
      },
    });
  } catch (err) {
    // Non-fatal: if nothing matched, Qdrant returns 200 anyway.
    if (err.status !== 404) throw err;
  }
}

/**
 * Search top-K similar chunks for a query vector.
 * Returns array of { id, score, payload }.
 */
export async function search(qdrantUrl, collection, queryVector, topK, threshold) {
  const client = getClient(qdrantUrl);
  const result = await client.search(collection, {
    vector: queryVector,
    limit: topK,
    score_threshold: threshold,
    with_payload: true,
  });
  return result;
}

/**
 * Sanity ping — returns true if the server responds on /healthz.
 */
export async function ping(qdrantUrl) {
  try {
    const r = await fetch(`${qdrantUrl.replace(/\/$/, '')}/healthz`);
    return r.ok;
  } catch {
    return false;
  }
}
