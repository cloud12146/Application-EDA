import L from 'leaflet';
import { LocationPing } from '../types/erp';

export interface LocationCluster {
  id: string;
  lat: number;
  lng: number;
  items: LocationPing[];
  count: number;
  liveCount: number;
  demoCount: number;
  bounds: L.LatLngBounds;
  hasGeographicSpread: boolean;
}

export interface ClusterResult {
  clusters: LocationCluster[];
  totalEmployees: number;
  visibleMarkerCount: number;
  clusterCount: number;
  zoom: number;
  isClustered: boolean;
}

export interface ClusterOptions {
  enabled?: boolean;
  maxClusterZoom?: number;
  excludeUserId?: string;
}

/**
 * Computes zoom-adaptive pixel clustering radius.
 * When zoomed far out, uses a wider radius to keep national/regional views uncluttered.
 * When zoomed in past maxClusterZoom, only merges near-identical overlapping coordinates.
 */
export function getClusterRadiusPx(zoom: number, maxClusterZoom = 14): number {
  if (zoom <= 6) return 76;
  if (zoom <= 9) return 66;
  if (zoom <= 12) return 58;
  if (zoom <= maxClusterZoom) return 48;
  return 16;
}

/**
 * Deduplicates a chronologically-descending LocationPing list into the latest ping per user.
 */
export function getLatestLocationsByUser(locations: LocationPing[]): LocationPing[] {
  const latest = new Map<string, LocationPing>();
  for (const loc of locations) {
    if (!latest.has(loc.userId)) {
      latest.set(loc.userId, loc);
    }
  }
  return Array.from(latest.values());
}

/**
 * High-performance O(N) spatial-hash pixel clusterer with viewport culling.
 * Projects employee coordinates at the current Leaflet zoom level and groups
 * nearby pins into clusters so large field teams stay legible at any zoom.
 */
export function clusterEmployeeLocations(
  latestLocations: LocationPing[],
  map: L.Map,
  options: ClusterOptions = {}
): ClusterResult {
  const { enabled = true, maxClusterZoom = 14, excludeUserId } = options;
  const zoom = map.getZoom();
  const totalEmployees = latestLocations.length;

  if (totalEmployees === 0) {
    return {
      clusters: [],
      totalEmployees: 0,
      visibleMarkerCount: 0,
      clusterCount: 0,
      zoom,
      isClustered: false,
    };
  }

  let viewportBounds: L.LatLngBounds | null = null;
  try {
    viewportBounds = map.getBounds().pad(0.35);
  } catch {
    viewportBounds = null;
  }

  const radiusPx = enabled ? getClusterRadiusPx(zoom, maxClusterZoom) : 0;
  const radiusSq = radiusPx * radiusPx;

  interface BucketCluster {
    sumLat: number;
    sumLng: number;
    anchorX: number;
    anchorY: number;
    items: LocationPing[];
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  }

  const buckets: BucketCluster[] = [];
  const grid = new Map<string, number[]>();
  const standalone: LocationPing[] = [];

  for (const loc of latestLocations) {
    if (!enabled || (excludeUserId && loc.userId === excludeUserId)) {
      standalone.push(loc);
      continue;
    }

    const pt = map.project([loc.lat, loc.lng], zoom);
    const gx = Math.floor(pt.x / radiusPx);
    const gy = Math.floor(pt.y / radiusPx);

    let matchedIdx = -1;
    let bestDistSq = Infinity;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cellKey = `${gx + dx}:${gy + dy}`;
        const candidates = grid.get(cellKey);
        if (!candidates) continue;

        for (const idx of candidates) {
          const b = buckets[idx];
          const ddx = pt.x - b.anchorX;
          const ddy = pt.y - b.anchorY;
          const distSq = ddx * ddx + ddy * ddy;
          if (distSq <= radiusSq && distSq < bestDistSq) {
            bestDistSq = distSq;
            matchedIdx = idx;
          }
        }
      }
    }

    if (matchedIdx >= 0) {
      const target = buckets[matchedIdx];
      target.items.push(loc);
      target.sumLat += loc.lat;
      target.sumLng += loc.lng;
      target.minLat = Math.min(target.minLat, loc.lat);
      target.maxLat = Math.max(target.maxLat, loc.lat);
      target.minLng = Math.min(target.minLng, loc.lng);
      target.maxLng = Math.max(target.maxLng, loc.lng);
    } else {
      const idx = buckets.length;
      buckets.push({
        sumLat: loc.lat,
        sumLng: loc.lng,
        anchorX: pt.x,
        anchorY: pt.y,
        items: [loc],
        minLat: loc.lat,
        maxLat: loc.lat,
        minLng: loc.lng,
        maxLng: loc.lng,
      });
      const cellKey = `${gx}:${gy}`;
      const existing = grid.get(cellKey);
      if (existing) {
        existing.push(idx);
      } else {
        grid.set(cellKey, [idx]);
      }
    }
  }

  for (const loc of standalone) {
    buckets.push({
      sumLat: loc.lat,
      sumLng: loc.lng,
      anchorX: 0,
      anchorY: 0,
      items: [loc],
      minLat: loc.lat,
      maxLat: loc.lat,
      minLng: loc.lng,
      maxLng: loc.lng,
    });
  }

  const clusters: LocationCluster[] = [];
  let clusterCount = 0;

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const count = b.items.length;
    const lat = b.sumLat / count;
    const lng = b.sumLng / count;

    // Viewport culling for DOM rendering performance
    if (viewportBounds && !viewportBounds.contains([lat, lng])) {
      continue;
    }

    const sortedItems =
      count > 1
        ? [...b.items].sort((a, c) => {
            const aLive = a.trackingActive && !a.isDemo ? 1 : 0;
            const cLive = c.trackingActive && !c.isDemo ? 1 : 0;
            if (aLive !== cLive) return cLive - aLive;
            return a.employeeName.localeCompare(c.employeeName);
          })
        : b.items;

    let liveCount = 0;
    let demoCount = 0;
    for (const item of sortedItems) {
      if (item.trackingActive && !item.isDemo) liveCount++;
      if (item.isDemo) demoCount++;
    }

    const hasGeographicSpread =
      b.maxLat - b.minLat > 0.0004 || b.maxLng - b.minLng > 0.0004;

    if (count > 1) clusterCount++;

    clusters.push({
      id: count === 1 ? sortedItems[0].userId : `cluster_${i}_${sortedItems[0].userId}`,
      lat,
      lng,
      items: sortedItems,
      count,
      liveCount,
      demoCount,
      bounds: L.latLngBounds([b.minLat, b.minLng], [b.maxLat, b.maxLng]),
      hasGeographicSpread,
    });
  }

  return {
    clusters,
    totalEmployees,
    visibleMarkerCount: clusters.length,
    clusterCount,
    zoom,
    isClustered: enabled && clusterCount > 0,
  };
}
