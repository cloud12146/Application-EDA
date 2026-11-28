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

export interface ViewportBoundsLiteral {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface ViewportLocationCluster {
  id: string;
  lat: number;
  lng: number;
  items: LocationPing[];
  count: number;
  liveCount: number;
  demoCount: number;
  bounds: ViewportBoundsLiteral;
  hasGeographicSpread: boolean;
}

export interface ViewportClusterResult {
  clusters: ViewportLocationCluster[];
  totalEmployees: number;
  visibleMarkerCount: number;
  clusterCount: number;
  zoom: number;
  isClustered: boolean;
}

/**
 * Computes zoom-adaptive pixel clustering radius.
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
  const latest: Record<string, LocationPing> = {};
  const result: LocationPing[] = [];
  for (const loc of locations) {
    if (!Object.prototype.hasOwnProperty.call(latest, loc.userId)) {
      latest[loc.userId] = loc;
      result.push(loc);
    }
  }
  return result;
}

function projectMercatorPixel(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const worldSize = 256 * Math.pow(2, zoom);
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sinLat = Math.sin((clampedLat * Math.PI) / 180);
  const x = ((lng + 180) / 360) * worldSize;
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;
  return { x, y };
}

function isWithinPaddedBounds(
  lat: number,
  lng: number,
  bounds?: ViewportBoundsLiteral | null
): boolean {
  if (!bounds) return true;
  const latPad = Math.abs(bounds.north - bounds.south) * 0.35;
  const lngSpan =
    bounds.east >= bounds.west
      ? bounds.east - bounds.west
      : 360 - (bounds.west - bounds.east);
  const lngPad = lngSpan * 0.35;

  if (lat < bounds.south - latPad || lat > bounds.north + latPad) {
    return false;
  }
  if (bounds.east >= bounds.west) {
    return lng >= bounds.west - lngPad && lng <= bounds.east + lngPad;
  }
  return lng >= bounds.west - lngPad || lng <= bounds.east + lngPad;
}

/**
 * Renderer-agnostic O(N) spatial-hash pixel clusterer using Web Mercator projection.
 * Works directly with Google Maps camera zoom & bounds.
 */
export function clusterLocationsForViewport(
  latestLocations: LocationPing[],
  zoom: number,
  viewportBounds?: ViewportBoundsLiteral | null,
  options: ClusterOptions = {}
): ViewportClusterResult {
  const { enabled = true, maxClusterZoom = 14, excludeUserId } = options;
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
  const grid: Record<string, number[]> = {};
  const standalone: LocationPing[] = [];

  for (const loc of latestLocations) {
    if (!enabled || (excludeUserId && loc.userId === excludeUserId)) {
      standalone.push(loc);
      continue;
    }

    const pt = projectMercatorPixel(loc.lat, loc.lng, zoom);
    const gx = Math.floor(pt.x / radiusPx);
    const gy = Math.floor(pt.y / radiusPx);

    let matchedIdx = -1;
    let bestDistSq = Infinity;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cellKey = `${gx + dx}:${gy + dy}`;
        const candidates = grid[cellKey];
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
      if (grid[cellKey]) {
        grid[cellKey].push(idx);
      } else {
        grid[cellKey] = [idx];
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

  const clusters: ViewportLocationCluster[] = [];
  let clusterCount = 0;

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const count = b.items.length;
    const lat = b.sumLat / count;
    const lng = b.sumLng / count;

    if (!isWithinPaddedBounds(lat, lng, viewportBounds)) {
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
      bounds: {
        north: b.maxLat,
        south: b.minLat,
        east: b.maxLng,
        west: b.minLng,
      },
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

/**
 * Leaflet-backed clusterer preserved for the offline cached-tile fallback map.
 */
export function clusterEmployeeLocations(
  latestLocations: LocationPing[],
  map: L.Map,
  options: ClusterOptions = {}
): ClusterResult {
  const zoom = map.getZoom();
  let viewportBounds: ViewportBoundsLiteral | null = null;
  try {
    const b = map.getBounds();
    viewportBounds = {
      north: b.getNorth(),
      south: b.getSouth(),
      east: b.getEast(),
      west: b.getWest(),
    };
  } catch {
    viewportBounds = null;
  }

  const res = clusterLocationsForViewport(latestLocations, zoom, viewportBounds, options);
  return {
    ...res,
    clusters: res.clusters.map((c) => ({
      ...c,
      bounds: L.latLngBounds([c.bounds.south, c.bounds.west], [c.bounds.north, c.bounds.east]),
    })),
  };
}
