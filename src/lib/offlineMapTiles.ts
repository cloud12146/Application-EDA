import { Customer } from '../types/erp';
import { calculateHaversineMeters } from './utils';

export const TILE_CACHE_NAME = 'glacetor-territory-tiles-v1';
const TILE_META_KEY = 'glacetor_territory_tile_meta_v1';
const MAX_CACHED_TILES = 500;
const MAX_PREFETCH_TILES = 220;

export interface TerritoryTileMeta {
  territoryLabel: string;
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
  tileCount: number;
  approxBytes: number;
  cachedAt: string;
  zoomLevels: number[];
}

export interface TilePrefetchProgress {
  completed: number;
  total: number;
  newlyCached: number;
  alreadyCached: number;
  failed: number;
}

export function latLngToTileCoords(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

export function buildOsmTileUrl(z: number, x: number, y: number): string {
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

function clampBoundingBox(
  centerLat: number,
  centerLng: number,
  radiusMeters: number,
  customers: Customer[]
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const effectiveRadiusM = Math.max(2500, Math.min(radiusMeters || 3500, 15000));
  const latDelta = effectiveRadiusM / 111320;
  const cosLat = Math.max(0.2, Math.cos((centerLat * Math.PI) / 180));
  const lngDelta = effectiveRadiusM / (111320 * cosLat);

  let minLat = centerLat - latDelta;
  let maxLat = centerLat + latDelta;
  let minLng = centerLng - lngDelta;
  let maxLng = centerLng + lngDelta;

  // Include nearby territory customers (within 25km of territory center)
  for (const c of customers) {
    if (typeof c.lat !== 'number' || typeof c.lng !== 'number') continue;
    const dist = calculateHaversineMeters(centerLat, centerLng, c.lat, c.lng);
    if (dist <= 25000) {
      minLat = Math.min(minLat, c.lat - 0.01);
      maxLat = Math.max(maxLat, c.lat + 0.01);
      minLng = Math.min(minLng, c.lng - 0.01);
      maxLng = Math.max(maxLng, c.lng + 0.01);
    }
  }

  return { minLat, maxLat, minLng, maxLng };
}

export function computeTerritoryTileUrls(params: {
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
  customers: Customer[];
  zoomLevels?: number[];
}): string[] {
  const {
    centerLat,
    centerLng,
    radiusMeters,
    customers,
    zoomLevels = [12, 13, 14, 15],
  } = params;

  const bbox = clampBoundingBox(centerLat, centerLng, radiusMeters, customers);
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const z of zoomLevels) {
    // For high-detail zoom 15, keep a tighter 2.5km box around center so tile count stays compact
    const activeBox =
      z >= 15
        ? clampBoundingBox(centerLat, centerLng, 2200, [])
        : bbox;

    const topLeft = latLngToTileCoords(activeBox.maxLat, activeBox.minLng, z);
    const bottomRight = latLngToTileCoords(activeBox.minLat, activeBox.maxLng, z);

    for (let x = topLeft.x; x <= bottomRight.x; x++) {
      for (let y = topLeft.y; y <= bottomRight.y; y++) {
        const url = buildOsmTileUrl(z, x, y);
        if (!seen.has(url)) {
          seen.add(url);
          urls.push(url);
        }
        if (urls.length >= MAX_PREFETCH_TILES) {
          return urls;
        }
      }
    }
  }

  return urls;
}

export function readStoredTileMeta(): TerritoryTileMeta | null {
  try {
    const raw = localStorage.getItem(TILE_META_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as TerritoryTileMeta;
  } catch {
    return null;
  }
}

export function writeStoredTileMeta(meta: TerritoryTileMeta | null): void {
  try {
    if (!meta) localStorage.removeItem(TILE_META_KEY);
    else localStorage.setItem(TILE_META_KEY, JSON.stringify(meta));
  } catch {
    // ignore storage quota failures
  }
}

export async function getCachedTileStats(): Promise<{
  count: number;
  meta: TerritoryTileMeta | null;
  supported: boolean;
}> {
  const meta = readStoredTileMeta();
  if (typeof window === 'undefined' || !('caches' in window)) {
    return { count: 0, meta, supported: false };
  }
  try {
    const cache = await caches.open(TILE_CACHE_NAME);
    const keys = await cache.keys();
    return { count: keys.length, meta, supported: true };
  } catch {
    return { count: 0, meta, supported: false };
  }
}

export async function trimTileCacheIfNeeded(cache: Cache): Promise<void> {
  try {
    const keys = await cache.keys();
    if (keys.length <= MAX_CACHED_TILES) return;
    const excess = keys.length - MAX_CACHED_TILES;
    for (let i = 0; i < excess; i++) {
      await cache.delete(keys[i]);
    }
  } catch {
    // best effort cleanup
  }
}

export async function cacheSingleTileResponse(url: string, response: Response): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in window)) return;
  if (!response.ok && response.type !== 'opaque') return;
  try {
    const cache = await caches.open(TILE_CACHE_NAME);
    await cache.put(url, response.clone());
    await trimTileCacheIfNeeded(cache);
  } catch {
    // ignore cache write failures
  }
}

export async function getCachedTileBlobUrl(url: string): Promise<string | null> {
  if (typeof window === 'undefined' || !('caches' in window)) return null;
  try {
    const cache = await caches.open(TILE_CACHE_NAME);
    const match = await cache.match(url);
    if (!match || match.type === 'opaque') return null;
    const blob = await match.blob();
    if (!blob || blob.size === 0) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

export async function prefetchTerritoryTiles(params: {
  territoryLabel: string;
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
  customers: Customer[];
  zoomLevels?: number[];
  onProgress?: (progress: TilePrefetchProgress) => void;
  signal?: AbortSignal;
}): Promise<TerritoryTileMeta> {
  if (typeof window === 'undefined' || !('caches' in window)) {
    throw new Error('Browser Cache Storage API is unavailable in this environment.');
  }

  const zoomLevels = params.zoomLevels || [12, 13, 14, 15];
  const urls = computeTerritoryTileUrls({
    centerLat: params.centerLat,
    centerLng: params.centerLng,
    radiusMeters: params.radiusMeters,
    customers: params.customers,
    zoomLevels,
  });

  const cache = await caches.open(TILE_CACHE_NAME);
  let completed = 0;
  let newlyCached = 0;
  let alreadyCached = 0;
  let failed = 0;
  let approxBytes = 0;

  const queue = [...urls];
  const CONCURRENCY = 4;

  const worker = async () => {
    while (queue.length > 0) {
      if (params.signal?.aborted) break;
      const url = queue.shift();
      if (!url) break;

      try {
        const existing = await cache.match(url);
        if (existing) {
          alreadyCached++;
          const blob = existing.type !== 'opaque' ? await existing.clone().blob() : null;
          approxBytes += blob ? blob.size : 18000;
        } else {
          const res = await fetch(url, { mode: 'cors', signal: params.signal });
          if (res.ok) {
            const clone = res.clone();
            const blob = await res.blob();
            approxBytes += blob.size || 18000;
            await cache.put(url, clone);
            newlyCached++;
          } else {
            failed++;
          }
          await new Promise((r) => setTimeout(r, 35));
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') break;
        failed++;
      } finally {
        completed++;
        params.onProgress?.({
          completed,
          total: urls.length,
          newlyCached,
          alreadyCached,
          failed,
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker())
  );

  await trimTileCacheIfNeeded(cache);
  const allKeys = await cache.keys();

  const meta: TerritoryTileMeta = {
    territoryLabel: params.territoryLabel,
    centerLat: params.centerLat,
    centerLng: params.centerLng,
    radiusMeters: params.radiusMeters,
    tileCount: allKeys.length,
    approxBytes,
    cachedAt: new Date().toISOString(),
    zoomLevels,
  };
  writeStoredTileMeta(meta);
  return meta;
}

export async function clearCachedTerritoryTiles(): Promise<void> {
  writeStoredTileMeta(null);
  if (typeof window === 'undefined' || !('caches' in window)) return;
  try {
    await caches.delete(TILE_CACHE_NAME);
  } catch {
    // ignore
  }
}
