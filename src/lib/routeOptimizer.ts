import { Customer } from '../types/erp';
import { calculateHaversineMeters } from './utils';
import { getUnifiedCurrentPosition } from './nativeGeolocation';

export interface GeoOrigin {
  lat: number;
  lng: number;
  accuracy?: number;
  label: string;
  source: 'gps' | 'hq' | 'customer';
}

export interface RouteStop {
  customer: Customer;
  order: number;
  distanceFromOriginMeters: number;
  legMeters: number;
  cumulativeMeters: number;
  estimatedLegMinutes: number;
}

export interface OptimizedRouteResult {
  origin: GeoOrigin;
  stops: RouteStop[];
  totalDistanceMeters: number;
  unoptimizedDistanceMeters: number;
  savedMeters: number;
  savedPercent: number;
  estimatedTravelMinutes: number;
}

export function hasValidGps(
  customer: Pick<Customer, 'lat' | 'lng'>
): customer is Customer & { lat: number; lng: number } {
  return (
    typeof customer.lat === 'number' &&
    typeof customer.lng === 'number' &&
    Number.isFinite(customer.lat) &&
    Number.isFinite(customer.lng) &&
    Math.abs(customer.lat) <= 90 &&
    Math.abs(customer.lng) <= 180 &&
    !(customer.lat === 0 && customer.lng === 0)
  );
}

export function formatDistanceKm(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '0 m';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export async function getCurrentBrowserPosition(): Promise<{
  lat: number;
  lng: number;
  accuracy: number;
}> {
  try {
    const pos = await getUnifiedCurrentPosition({
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000,
    });
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy || 0,
    };
  } catch (err: any) {
    if (err?.code === 1) {
      throw new Error(
        'Location permission denied. Enable GPS access or choose HQ / Customer origin.'
      );
    }
    if (err?.code === 3) {
      throw new Error(
        'GPS location request timed out. Try again or use HQ coordinates.'
      );
    }
    throw new Error(
      err?.message || 'Unable to determine your current GPS position.'
    );
  }
}

function totalPathMeters(origin: { lat: number; lng: number }, list: Customer[]): number {
  let prevLat = origin.lat;
  let prevLng = origin.lng;
  let total = 0;
  for (const c of list) {
    if (!hasValidGps(c)) continue;
    total += calculateHaversineMeters(prevLat, prevLng, c.lat, c.lng);
    prevLat = c.lat;
    prevLng = c.lng;
  }
  return total;
}

/**
 * Computes an efficient daily customer visit sequence from `origin` using
 * Nearest-Neighbor construction followed by 2-opt local path refinement.
 */
export function optimizeCustomerVisitRoute(
  origin: GeoOrigin,
  candidates: Customer[]
): OptimizedRouteResult {
  const gpsCustomers = candidates.filter(hasValidGps);
  const unoptimizedDistanceMeters = totalPathMeters(origin, gpsCustomers);

  if (gpsCustomers.length === 0) {
    return {
      origin,
      stops: [],
      totalDistanceMeters: 0,
      unoptimizedDistanceMeters: 0,
      savedMeters: 0,
      savedPercent: 0,
      estimatedTravelMinutes: 0,
    };
  }

  // 1. Nearest-Neighbor seed path from origin
  const remaining = [...gpsCustomers];
  const ordered: (Customer & { lat: number; lng: number })[] = [];
  let curLat = origin.lat;
  let curLng = origin.lng;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = calculateHaversineMeters(
        curLat,
        curLng,
        remaining[i].lat,
        remaining[i].lng
      );
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    ordered.push(chosen);
    curLat = chosen.lat;
    curLng = chosen.lng;
  }

  // 2. 2-opt refinement (origin stays fixed before index 0)
  if (ordered.length >= 3) {
    let improved = true;
    let passes = 0;
    while (improved && passes < 50) {
      improved = false;
      passes++;
      for (let i = 0; i < ordered.length - 1; i++) {
        for (let j = i + 1; j < ordered.length; j++) {
          const candidatePath = [
            ...ordered.slice(0, i),
            ...ordered.slice(i, j + 1).reverse(),
            ...ordered.slice(j + 1),
          ];
          const curLen = totalPathMeters(origin, ordered);
          const nextLen = totalPathMeters(origin, candidatePath);
          if (nextLen + 1 < curLen) {
            ordered.splice(0, ordered.length, ...candidatePath);
            improved = true;
          }
        }
      }
    }
  }

  // 3. Build leg-by-leg route summary
  const stops: RouteStop[] = [];
  let prevLat = origin.lat;
  let prevLng = origin.lng;
  let cumulative = 0;
  let totalMinutes = 0;

  ordered.forEach((cust, idx) => {
    const legMeters = calculateHaversineMeters(prevLat, prevLng, cust.lat, cust.lng);
    const fromOrigin = calculateHaversineMeters(
      origin.lat,
      origin.lng,
      cust.lat,
      cust.lng
    );
    cumulative += legMeters;
    // Estimate ~24 km/h average field travel speed (min 2 mins per leg)
    const legMinutes =
      legMeters <= 100 ? 1 : Math.max(2, Math.round((legMeters / 1000 / 24) * 60));
    totalMinutes += legMinutes;

    stops.push({
      customer: cust,
      order: idx + 1,
      distanceFromOriginMeters: fromOrigin,
      legMeters,
      cumulativeMeters: cumulative,
      estimatedLegMinutes: legMinutes,
    });

    prevLat = cust.lat;
    prevLng = cust.lng;
  });

  const savedMeters = Math.max(0, unoptimizedDistanceMeters - cumulative);
  const savedPercent =
    unoptimizedDistanceMeters > 0
      ? Math.round((savedMeters / unoptimizedDistanceMeters) * 100)
      : 0;

  return {
    origin,
    stops,
    totalDistanceMeters: cumulative,
    unoptimizedDistanceMeters,
    savedMeters,
    savedPercent,
    estimatedTravelMinutes: totalMinutes,
  };
}
