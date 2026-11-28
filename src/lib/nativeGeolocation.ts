import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';

export interface UnifiedGeolocationCoords {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  heading: number | null;
  speed: number | null;
  toJSON: () => Record<string, number | null>;
}

export interface UnifiedGeolocationPosition {
  coords: UnifiedGeolocationCoords;
  timestamp: number;
  toJSON: () => { coords: Record<string, number | null>; timestamp: number };
}

function toUnifiedPosition(pos: {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude?: number | null;
    altitudeAccuracy?: number | null;
    heading?: number | null;
    speed?: number | null;
  };
  timestamp: number;
}): UnifiedGeolocationPosition {
  const coordsObj: UnifiedGeolocationCoords = {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracy: pos.coords.accuracy ?? 0,
    altitude: pos.coords.altitude ?? null,
    altitudeAccuracy: pos.coords.altitudeAccuracy ?? null,
    heading: pos.coords.heading ?? null,
    speed: pos.coords.speed ?? null,
    toJSON() {
      return {
        latitude: this.latitude,
        longitude: this.longitude,
        accuracy: this.accuracy,
        altitude: this.altitude,
        altitudeAccuracy: this.altitudeAccuracy,
        heading: this.heading,
        speed: this.speed,
      };
    },
  };
  return {
    coords: coordsObj,
    timestamp: pos.timestamp,
    toJSON() {
      return {
        coords: coordsObj.toJSON(),
        timestamp: this.timestamp,
      };
    },
  };
}

export async function ensureNativeLocationPermission(): Promise<
  'granted' | 'denied' | 'prompt'
> {
  if (!Capacitor.isNativePlatform()) {
    if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
      try {
        const res = await navigator.permissions.query({ name: 'geolocation' });
        return res.state;
      } catch {
        return 'prompt';
      }
    }
    return 'prompt';
  }

  try {
    const status = await Geolocation.checkPermissions();
    if (status.location === 'granted' || status.coarseLocation === 'granted') {
      return 'granted';
    }
    const requested = await Geolocation.requestPermissions({
      permissions: ['location'],
    });
    if (
      requested.location === 'granted' ||
      requested.coarseLocation === 'granted'
    ) {
      return 'granted';
    }
    if (requested.location === 'denied') {
      return 'denied';
    }
    return 'prompt';
  } catch {
    return 'prompt';
  }
}

export async function getUnifiedCurrentPosition(options?: {
  enableHighAccuracy?: boolean;
  timeout?: number;
  maximumAge?: number;
}): Promise<UnifiedGeolocationPosition> {
  const opts = {
    enableHighAccuracy: options?.enableHighAccuracy ?? true,
    timeout: options?.timeout ?? 10000,
    maximumAge: options?.maximumAge ?? 15000,
  };

  if (Capacitor.isNativePlatform()) {
    const perm = await ensureNativeLocationPermission();
    if (perm === 'denied') {
      const err: any = new Error(
        'Location permission denied. Enable GPS access in Android App Settings.'
      );
      err.code = 1;
      throw err;
    }
    const pos = await Geolocation.getCurrentPosition(opts);
    return toUnifiedPosition(pos);
  }

  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      reject(new Error('Device geolocation is unavailable on this browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(toUnifiedPosition(pos)),
      reject,
      opts
    );
  });
}

export async function watchUnifiedPosition(
  onPosition: (pos: UnifiedGeolocationPosition) => void,
  onError: (err: { code?: number; message: string }) => void,
  options?: {
    enableHighAccuracy?: boolean;
    timeout?: number;
    maximumAge?: number;
  }
): Promise<string | number> {
  const opts = {
    enableHighAccuracy: options?.enableHighAccuracy ?? true,
    timeout: options?.timeout ?? 15000,
    maximumAge: options?.maximumAge ?? 10000,
  };

  if (Capacitor.isNativePlatform()) {
    const perm = await ensureNativeLocationPermission();
    if (perm === 'denied') {
      onError({
        code: 1,
        message:
          'Location permission denied. Enable GPS access in Android App Settings.',
      });
      throw new Error('Location permission denied');
    }
    return await Geolocation.watchPosition(opts, (pos, err) => {
      if (err) {
        onError({
          code: (err as any)?.code,
          message: err.message || 'Unable to acquire GPS signal.',
        });
        return;
      }
      if (pos) {
        onPosition(toUnifiedPosition(pos));
      }
    });
  }

  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    throw new Error('Geolocation is not supported by this browser or device.');
  }

  return navigator.geolocation.watchPosition(
    (pos) => onPosition(toUnifiedPosition(pos)),
    (err) =>
      onError({
        code: err.code,
        message: err.message || 'Location request failed.',
      }),
    opts
  );
}

export async function clearUnifiedWatch(watchId: string | number): Promise<void> {
  if (typeof watchId === 'string') {
    if (Capacitor.isNativePlatform()) {
      await Geolocation.clearWatch({ id: watchId });
    }
    return;
  }
  if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(watchId);
  }
}
