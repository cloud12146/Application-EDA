import { DoctorCallRecord } from '../types/erp';

export interface CapturedGpsPoint {
  lat: number;
  lng: number;
  accuracy: number;
}

const geocodeCache = new Map<string, string>();

export function captureCurrentGps(timeoutMs = 10000): Promise<CapturedGpsPoint> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      reject(new Error('GPS is not supported on this browser or device.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.max(0, Math.round(pos.coords.accuracy || 0)),
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(
            new Error(
              'Location permission denied. Allow location access in browser/device settings to record call place.'
            )
          );
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          reject(new Error('GPS signal unavailable. Ensure device Location/GPS is turned on.'));
        } else {
          reject(new Error('GPS request timed out. Tap Refresh GPS or enter place manually.'));
        }
      },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: timeoutMs }
    );
  });
}

export async function reverseGeocodeCoords(lat: number, lng: number): Promise<string> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = geocodeCache.get(key);
  if (cached) return cached;

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return '';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lng)}&zoom=16&addressdetails=1`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });
    if (!res.ok) return '';
    const data = await res.json();
    const addr = data?.address || {};

    const primary =
      addr.neighbourhood ||
      addr.suburb ||
      addr.residential ||
      addr.road ||
      addr.village ||
      addr.town ||
      '';
    const cityPart = addr.city || addr.town || addr.state_district || addr.county || '';
    const statePart = addr.state || '';

    const parts = [primary, cityPart || statePart].filter(
      (v, idx, arr) => Boolean(v) && arr.indexOf(v) === idx
    );

    const label = (parts.join(', ') || data?.display_name || '').trim().slice(0, 180);
    if (label) {
      geocodeCache.set(key, label);
    }
    return label;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

export function buildGoogleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export function formatCallLocationSummary(
  call: Pick<DoctorCallRecord, 'locationName' | 'lat' | 'lng' | 'areaBeat' | 'clinicName'>
): {
  label: string;
  hasGps: boolean;
  coordsText: string;
  mapsUrl: string | null;
} {
  const hasGps = typeof call.lat === 'number' && typeof call.lng === 'number';
  const fallbackPlace = [call.areaBeat, call.clinicName].filter(Boolean).join(' · ');
  const label = (call.locationName || '').trim() || fallbackPlace || 'Location not tagged';
  const coordsText = hasGps
    ? `${call.lat!.toFixed(5)}, ${call.lng!.toFixed(5)}`
    : '';
  const mapsUrl = hasGps ? buildGoogleMapsUrl(call.lat!, call.lng!) : null;
  return { label, hasGps, coordsText, mapsUrl };
}
