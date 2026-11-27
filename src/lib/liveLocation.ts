import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import {
  calculateHaversineMeters,
  formatTimestamp,
  generateId,
  tsToMs,
} from './utils';
import { CompanySettings, Customer, Employee, LocationPing, UserAccount } from '../types/erp';

export const LIVE_TRACKING_DUTY_STORAGE_PREFIX = 'glacetor_live_gps_duty_';
export const LIVE_TRACKING_CONSENT_PREFIX = 'glacetor_live_gps_consent_';

export interface LiveTrackingCoords {
  lat: number;
  lng: number;
  accuracy: number;
  capturedAtMs: number;
}

export interface LiveTrackingController {
  isTracking: boolean;
  permissionState: string;
  trackingError: string;
  lastPingAtMs: number | null;
  currentCoords: LiveTrackingCoords | null;
  startLiveTracking: (options?: {
    initialPosition?: GeolocationPosition;
    note?: string;
    silentIfUnavailable?: boolean;
  }) => void;
  stopLiveTracking: (options?: {
    recordCheckoutPing?: boolean;
    finalPosition?: GeolocationPosition;
    note?: string;
  }) => Promise<void>;
  recordManualPing: (params: {
    coords: GeolocationCoordinates;
    status: LocationPing['status'];
    trackingActive: boolean;
    customer?: Customer;
    note?: string;
  }) => Promise<void>;
  clearTrackingError: () => void;
}

export function resolveUserGeofence(
  currentUser: UserAccount,
  employees: Employee[],
  settings: CompanySettings | null
): { lat: number; lng: number; radiusM: number; territory: string } {
  const myEmp = employees.find(
    (e) =>
      e.uid === currentUser.uid ||
      e.email.toLowerCase() === currentUser.email.toLowerCase()
  );
  return {
    lat: myEmp?.geofenceLat ?? settings?.officeLat ?? 19.076,
    lng: myEmp?.geofenceLng ?? settings?.officeLng ?? 72.8777,
    radiusM: myEmp?.geofenceRadiusM ?? settings?.officeRadiusM ?? 500,
    territory: currentUser.territory || myEmp?.territory || 'Field Zone',
  };
}

export async function writeValidatedLocationPing(params: {
  currentUser: UserAccount;
  employees: Employee[];
  settings: CompanySettings | null;
  coords: { latitude: number; longitude: number; accuracy?: number | null };
  status: LocationPing['status'];
  trackingActive: boolean;
  customer?: Customer;
  note?: string;
}): Promise<string> {
  const {
    currentUser,
    employees,
    settings,
    coords,
    status,
    trackingActive,
    customer,
    note,
  } = params;

  const id = generateId('loc');
  const geofence = resolveUserGeofence(currentUser, employees, settings);
  const dist = calculateHaversineMeters(
    coords.latitude,
    coords.longitude,
    geofence.lat,
    geofence.lng
  );
  const withinGeofence = dist <= geofence.radiusM;
  const safeName = (currentUser.displayName || 'Field Staff').trim().slice(0, 120) || 'Field Staff';
  const safeTerritory = geofence.territory.trim().slice(0, 120);
  const safeNote = note ? note.trim().slice(0, 240) : '';
  const safeCustomerName = customer?.businessName
    ? customer.businessName.trim().slice(0, 140)
    : '';

  try {
    await setDoc(doc(db, 'locations', id), {
      id,
      userId: currentUser.uid,
      employeeName: safeName,
      ...(safeTerritory ? { territory: safeTerritory } : {}),
      lat: Number(coords.latitude),
      lng: Number(coords.longitude),
      accuracy: Math.max(0, Math.round(coords.accuracy || 0)),
      trackingActive: Boolean(trackingActive),
      status,
      ...(customer?.id && safeCustomerName
        ? { customerId: customer.id, customerName: safeCustomerName }
        : {}),
      withinGeofence,
      ...(safeNote ? { note: safeNote } : {}),
      recordedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `locations/${id}`);
  }

  return id;
}

export type LivePingState = 'live' | 'recent' | 'stale' | 'checked-out' | 'demo' | 'offline';

export interface LiveStatusBadgeInfo {
  state: LivePingState;
  label: string;
  ageLabel: string;
  isLiveNow: boolean;
}

export function formatRelativeAge(recordedAt: unknown, nowMs: number): string {
  const ms = tsToMs(recordedAt);
  if (!ms) return 'Just now';
  const diffSec = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (diffSec < 30) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return formatTimestamp(recordedAt);
}

export function getLivePingStatusInfo(
  ping: LocationPing | undefined,
  nowMs: number
): LiveStatusBadgeInfo {
  if (!ping) {
    return {
      state: 'offline',
      label: 'No GPS Yet',
      ageLabel: 'Not shared yet',
      isLiveNow: false,
    };
  }
  if (ping.isDemo) {
    return {
      state: 'demo',
      label: 'Demo Ping',
      ageLabel: formatRelativeAge(ping.recordedAt, nowMs),
      isLiveNow: false,
    };
  }
  const ageLabel = formatRelativeAge(ping.recordedAt, nowMs);
  const ms = tsToMs(ping.recordedAt);
  const ageMs = ms > 0 ? Math.max(0, nowMs - ms) : 0;

  if (ping.status === 'Checked Out' || !ping.trackingActive) {
    return {
      state: 'checked-out',
      label: ping.status === 'Checked Out' ? 'Checked Out' : ping.status,
      ageLabel,
      isLiveNow: false,
    };
  }

  if (ageMs <= 5 * 60 * 1000) {
    return {
      state: 'live',
      label: 'Live GPS',
      ageLabel,
      isLiveNow: true,
    };
  }

  if (ageMs <= 30 * 60 * 1000) {
    return {
      state: 'recent',
      label: 'On Duty (Idle)',
      ageLabel,
      isLiveNow: true,
    };
  }

  return {
    state: 'stale',
    label: 'Signal Stale',
    ageLabel,
    isLiveNow: false,
  };
}
