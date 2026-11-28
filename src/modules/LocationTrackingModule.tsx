import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  HardDrive,
  History,
  Info,
  Layers,
  Loader2,
  Map as MapIcon,
  MapPin,
  Navigation,
  ShieldAlert,
  Smartphone,
  Stethoscope,
  StopCircle,
  Trash2,
  User,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  calculateHaversineMeters,
  exportToCsv,
  formatTimestamp,
  generateId,
  todayIsoDate,
  tsToMs,
} from '../lib/utils';
import {
  captureCurrentGps,
  formatCallLocationSummary,
  reverseGeocodeCoords,
} from '../lib/callLocation';
import {
  formatRelativeAge,
  getLivePingStatusInfo,
  LiveTrackingController,
} from '../lib/liveLocation';
import { getRoleDisplayLabel } from '../lib/roles';
import { logActivity } from '../lib/erpActions';
import {
  clearCachedTerritoryTiles,
  getCachedTileStats,
  prefetchTerritoryTiles,
  TerritoryTileMeta,
  TilePrefetchProgress,
} from '../lib/offlineMapTiles';
import { LiveMap, MapClusterStats } from '../components/LiveMap';
import {
  CompanySettings,
  Customer,
  DoctorCallRecord,
  Employee,
  LocationPing,
  UserAccount,
} from '../types/erp';

interface LocationTrackingModuleProps {
  currentUser: UserAccount;
  isAdminView: boolean;
  locations: LocationPing[];
  employees: Employee[];
  customers: Customer[];
  doctorCalls?: DoctorCallRecord[];
  settings: CompanySettings | null;
  liveTracking: LiveTrackingController;
  initialFocusEmployeeUid?: string | null;
  onClearInitialFocus?: () => void;
}

export const LocationTrackingModule: React.FC<LocationTrackingModuleProps> = ({
  currentUser,
  isAdminView,
  locations,
  employees,
  customers,
  doctorCalls = [],
  settings,
  liveTracking,
  initialFocusEmployeeUid = null,
  onClearInitialFocus,
}) => {
  const [showConsentDialog, setShowConsentDialog] = useState(false);
  const [gpsError, setGpsError] = useState('');
  const [gpsSuccess, setGpsSuccess] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [visitNote, setVisitNote] = useState('');
  const [routeUserId, setRouteUserId] = useState('');
  const [focusedEmployeeUid, setFocusedEmployeeUid] = useState<string | null>(
    initialFocusEmployeeUid
  );
  const [focusTick, setFocusTick] = useState(0);
  const [personnelSearch, setPersonnelSearch] = useState('');
  const [personnelFilter, setPersonnelFilter] = useState<'all' | 'live' | 'on-duty'>('all');
  const [showDemoPings, setShowDemoPings] = useState<boolean>(() => {
    const hasReal = locations.some((l) => !l.isDemo);
    return !hasReal;
  });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [showAndroidGuide, setShowAndroidGuide] = useState(false);
  const [historyTab, setHistoryTab] = useState<'pings' | 'calls'>('pings');
  const [pinningCallId, setPinningCallId] = useState<string | null>(null);

  // Dedicated Employee Visit History Map view state
  const [mapViewMode, setMapViewMode] = useState<'live' | 'visit-history'>('live');
  const [historyEmployeeUid, setHistoryEmployeeUid] = useState<string>('');
  const [historyDateFilter, setHistoryDateFilter] = useState<string>('');
  const [focusedCallId, setFocusedCallId] = useState<string | null>(null);
  const [clusterEmployees, setClusterEmployees] = useState(true);
  const [clusterStats, setClusterStats] = useState<MapClusterStats | null>(null);

  // Offline Territory Map Tile Cache state
  const [tileCacheSupported, setTileCacheSupported] = useState(true);
  const [cachedTileCount, setCachedTileCount] = useState(0);
  const [tileMeta, setTileMeta] = useState<TerritoryTileMeta | null>(null);
  const [cachingTiles, setCachingTiles] = useState(false);
  const [cacheProgress, setCacheProgress] = useState<TilePrefetchProgress | null>(null);
  const cacheAbortRef = useRef<AbortController | null>(null);
  const lastStatRefreshRef = useRef<number>(0);

  const {
    isTracking,
    permissionState,
    trackingError,
    lastPingAtMs,
    currentCoords,
    startLiveTracking: startAppLiveTracking,
    stopLiveTracking: stopAppLiveTracking,
    recordManualPing,
    clearTrackingError,
  } = liveTracking;

  const myEmployee = employees.find(
    (e) => e.uid === currentUser.uid || e.email.toLowerCase() === currentUser.email.toLowerCase()
  );

  const territoryLabel =
    myEmployee?.territory || currentUser.territory || 'Corporate HQ';
  const geofenceLat = myEmployee?.geofenceLat ?? settings?.officeLat ?? 19.076;
  const geofenceLng = myEmployee?.geofenceLng ?? settings?.officeLng ?? 72.8777;
  const geofenceRadius = myEmployee?.geofenceRadiusM ?? settings?.officeRadiusM ?? 500;

  const geofenceCenter = useMemo(
    () => ({
      lat: geofenceLat,
      lng: geofenceLng,
      radiusM: geofenceRadius,
      label: isAdminView ? 'Corporate HQ Geofence' : 'My Assigned Geofence',
    }),
    [geofenceLat, geofenceLng, geofenceRadius, isAdminView]
  );

  const handleClusterStatsChange = useCallback((next: MapClusterStats) => {
    setClusterStats((prev) => {
      if (
        prev &&
        prev.totalEmployees === next.totalEmployees &&
        prev.visibleMarkerCount === next.visibleMarkerCount &&
        prev.clusterCount === next.clusterCount &&
        prev.zoom === next.zoom &&
        prev.isClustered === next.isClustered
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const handleSelectCall = useCallback((callId: string) => {
    setFocusedCallId(callId);
  }, []);

  const handleSelectEmployee = useCallback((uid: string) => {
    setFocusedEmployeeUid(uid);
  }, []);

  const refreshTileStats = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now - lastStatRefreshRef.current < 1500) return;
    lastStatRefreshRef.current = now;
    const stats = await getCachedTileStats();
    setTileCacheSupported(stats.supported);
    setCachedTileCount(stats.count);
    setTileMeta(stats.meta);
  }, []);

  const handleTileCached = useCallback(() => {
    void refreshTileStats(false);
  }, [refreshTileStats]);

  useEffect(() => {
    refreshTileStats(true);
    const interval = window.setInterval(() => setNowMs(Date.now()), 10000);
    return () => {
      window.clearInterval(interval);
      if (cacheAbortRef.current) {
        cacheAbortRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    if (initialFocusEmployeeUid) {
      setMapViewMode('live');
      setFocusedEmployeeUid(initialFocusEmployeeUid);
      setFocusTick((t) => t + 1);
      onClearInitialFocus?.();
    }
  }, [initialFocusEmployeeUid, onClearInitialFocus]);

  const handleCacheTerritoryMap = async () => {
    setGpsError('');
    setGpsSuccess('');
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setGpsError('Cannot download new map tiles while offline. Existing cached tiles remain available.');
      return;
    }
    const controller = new AbortController();
    cacheAbortRef.current = controller;
    setCachingTiles(true);
    setCacheProgress({ completed: 0, total: 1, newlyCached: 0, alreadyCached: 0, failed: 0 });
    try {
      const meta = await prefetchTerritoryTiles({
        territoryLabel,
        centerLat: geofenceLat,
        centerLng: geofenceLng,
        radiusMeters: Math.max(geofenceRadius, 3500),
        customers,
        zoomLevels: [12, 13, 14, 15],
        signal: controller.signal,
        onProgress: (p) => setCacheProgress(p),
      });
      await refreshTileStats(true);
      setGpsSuccess(
        controller.signal.aborted
          ? `Map caching cancelled (${meta.tileCount} tiles retained offline).`
          : `Cached ${meta.tileCount} base map tiles for ${territoryLabel} (~${(
              Math.max(meta.approxBytes, meta.tileCount * 15000) /
              (1024 * 1024)
            ).toFixed(1)} MB) for offline use.`
      );
    } catch (err: any) {
      setGpsError(err?.message || 'Failed to cache base map tiles for this territory.');
    } finally {
      setCachingTiles(false);
      cacheAbortRef.current = null;
    }
  };

  const handleClearTileCache = async () => {
    await clearCachedTerritoryTiles();
    setCacheProgress(null);
    await refreshTileStats(true);
    setGpsSuccess('Cleared offline territory map tile cache.');
  };

  const startLiveTracking = () => {
    setShowConsentDialog(false);
    setGpsError('');
    clearTrackingError();
    startAppLiveTracking({
      note: 'Authorized work-hour live GPS tracking',
    });
    setGpsSuccess('Live work-hour GPS tracking active across all tabs.');
  };

  const stopLiveTracking = async () => {
    setGpsError('');
    await stopAppLiveTracking({
      recordCheckoutPing: true,
      note: 'Stopped duty tracking',
    });
    setGpsSuccess('Location tracking stopped.');
  };

  const handleCustomerVisitCheckIn = (e: React.FormEvent) => {
    e.preventDefault();
    setGpsError('');
    setGpsSuccess('');

    if (!('geolocation' in navigator)) {
      setGpsError('Device geolocation is unavailable.');
      return;
    }

    const customer = customers.find((c) => c.id === selectedCustomerId);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        await recordManualPing({
          coords: pos.coords,
          status: 'Customer Visit',
          trackingActive: isTracking,
          customer,
          note:
            visitNote.trim() ||
            (customer ? `Visited ${customer.businessName}` : 'Field customer visit'),
        });
        await logActivity({
          userId: currentUser.uid,
          employeeName: currentUser.displayName,
          action: 'Customer Visit',
          entityType: customer ? 'customer' : 'location',
          entityId: customer?.id,
          details: customer
            ? `GPS visit logged at ${customer.businessName} (±${Math.round(pos.coords.accuracy)}m)`
            : `Field visit logged (±${Math.round(pos.coords.accuracy)}m)`,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
        setVisitNote('');
        setSelectedCustomerId('');
        setGpsSuccess('Customer visit location recorded with GPS timestamp.');
      },
      (err) => {
        setGpsError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Cannot record fake coordinates.'
            : 'Unable to acquire GPS fix for customer visit.'
        );
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  };

  const visibleLocations = useMemo(
    () => (showDemoPings ? locations : locations.filter((l) => !l.isDemo)),
    [locations, showDemoPings]
  );

  // Deduplicate latest location per user for status list
  const latestPerUser = useMemo(() => {
    const map = new Map<string, LocationPing>();
    for (const l of locations) {
      if (!map.has(l.userId)) {
        map.set(l.userId, l);
      }
    }
    return map;
  }, [locations]);

  const activePersonnel = useMemo(() => {
    return Array.from(latestPerUser.values()).filter((l) =>
      showDemoPings ? true : !l.isDemo
    );
  }, [latestPerUser, showDemoPings]);

  const demoPingCount = useMemo(
    () => locations.filter((l) => l.isDemo).length,
    [locations]
  );

  const livePersonnelCount = useMemo(() => {
    let count = 0;
    for (const loc of latestPerUser.values()) {
      if (getLivePingStatusInfo(loc, nowMs).isLiveNow) count++;
    }
    return count;
  }, [latestPerUser, nowMs]);

  interface PersonnelLiveRow {
    uid: string;
    name: string;
    roleLabel: string;
    territory: string;
    phone?: string;
    latestPing?: LocationPing;
    statusInfo: ReturnType<typeof getLivePingStatusInfo>;
  }

  const personnelLiveRows = useMemo<PersonnelLiveRow[]>(() => {
    const map = new Map<string, PersonnelLiveRow>();

    for (const emp of employees) {
      const uid = emp.uid || emp.id;
      if (!uid) continue;
      if (!showDemoPings && emp.isDemo) continue;
      const ping = latestPerUser.get(uid);
      if (!showDemoPings && ping?.isDemo) continue;
      const statusInfo = getLivePingStatusInfo(ping, nowMs);
      map.set(uid, {
        uid,
        name: emp.fullName,
        roleLabel: emp.designation || getRoleDisplayLabel(emp.role),
        territory: emp.territory || ping?.territory || 'Field Zone',
        phone: emp.phone,
        latestPing: ping,
        statusInfo,
      });
    }

    for (const loc of activePersonnel) {
      if (!map.has(loc.userId)) {
        const statusInfo = getLivePingStatusInfo(loc, nowMs);
        map.set(loc.userId, {
          uid: loc.userId,
          name: loc.employeeName,
          roleLabel: loc.isDemo ? 'Demo Rep' : 'Field Staff',
          territory: loc.territory || 'Field Zone',
          latestPing: loc,
          statusInfo,
        });
      }
    }

    const statePriority: Record<string, number> = {
      live: 0,
      recent: 1,
      stale: 2,
      'checked-out': 3,
      offline: 4,
      demo: 5,
    };

    return Array.from(map.values()).sort((a, b) => {
      const pa = statePriority[a.statusInfo.state] ?? 9;
      const pb = statePriority[b.statusInfo.state] ?? 9;
      if (pa !== pb) return pa - pb;
      const ta = a.latestPing ? tsToMs(a.latestPing.recordedAt) : 0;
      const tb = b.latestPing ? tsToMs(b.latestPing.recordedAt) : 0;
      if (ta !== tb) return tb - ta;
      return a.name.localeCompare(b.name);
    });
  }, [employees, activePersonnel, latestPerUser, nowMs, showDemoPings]);

  const filteredPersonnelRows = useMemo(() => {
    const q = personnelSearch.trim().toLowerCase();
    return personnelLiveRows.filter((row) => {
      if (personnelFilter === 'live' && row.statusInfo.state !== 'live') return false;
      if (personnelFilter === 'on-duty' && !row.statusInfo.isLiveNow) return false;
      if (!q) return true;
      return (
        row.name.toLowerCase().includes(q) ||
        row.roleLabel.toLowerCase().includes(q) ||
        row.territory.toLowerCase().includes(q)
      );
    });
  }, [personnelLiveRows, personnelFilter, personnelSearch]);

  const focusedPersonnel = useMemo(() => {
    if (!focusedEmployeeUid) return null;
    const fromRows = personnelLiveRows.find((r) => r.uid === focusedEmployeeUid);
    if (fromRows) return fromRows;
    const ping = latestPerUser.get(focusedEmployeeUid);
    if (!ping) return null;
    return {
      uid: ping.userId,
      name: ping.employeeName,
      roleLabel: ping.isDemo ? 'Demo Rep' : 'Field Staff',
      territory: ping.territory || 'Field Zone',
      latestPing: ping,
      statusInfo: getLivePingStatusInfo(ping, nowMs),
    } as PersonnelLiveRow;
  }, [focusedEmployeeUid, personnelLiveRows, latestPerUser, nowMs]);

  const focusEmployeeOnMap = (uid: string) => {
    setMapViewMode('live');
    setFocusedEmployeeUid(uid);
    setFocusTick((t) => t + 1);
  };

  const gpsCallCount = doctorCalls.filter(
    (c) => typeof c.lat === 'number' && typeof c.lng === 'number'
  ).length;

  // Build unified employee options from employees directory, doctorCalls, and locations
  const employeeDirectoryOptions = useMemo(() => {
    const map = new Map<string, { uid: string; name: string; territory?: string }>();
    for (const emp of employees) {
      const uid = emp.uid || emp.id;
      if (uid) {
        map.set(uid, { uid, name: emp.fullName, territory: emp.territory });
      }
    }
    for (const c of doctorCalls) {
      if (c.employeeUid && !map.has(c.employeeUid)) {
        map.set(c.employeeUid, { uid: c.employeeUid, name: c.employeeName });
      }
    }
    for (const l of locations) {
      if (l.userId && !map.has(l.userId)) {
        map.set(l.userId, { uid: l.userId, name: l.employeeName, territory: l.territory });
      }
    }
    if (!map.has(currentUser.uid)) {
      map.set(currentUser.uid, {
        uid: currentUser.uid,
        name: currentUser.displayName,
        territory: currentUser.territory,
      });
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [employees, doctorCalls, locations, currentUser.uid, currentUser.displayName, currentUser.territory]);

  const effectiveHistoryUid = useMemo(() => {
    if (!isAdminView) return currentUser.uid;
    if (historyEmployeeUid && employeeDirectoryOptions.some((e) => e.uid === historyEmployeeUid)) {
      return historyEmployeeUid;
    }
    if (routeUserId && employeeDirectoryOptions.some((e) => e.uid === routeUserId)) {
      return routeUserId;
    }
    const firstWithCalls = doctorCalls.find((c) => c.employeeUid)?.employeeUid;
    return firstWithCalls || employeeDirectoryOptions[0]?.uid || currentUser.uid;
  }, [isAdminView, historyEmployeeUid, routeUserId, employeeDirectoryOptions, doctorCalls, currentUser.uid]);

  const selectedHistoryEmployee = useMemo(
    () => employeeDirectoryOptions.find((e) => e.uid === effectiveHistoryUid),
    [employeeDirectoryOptions, effectiveHistoryUid]
  );

  // Employee-scoped visit history (doctor calls + GPS pings), optionally filtered by date
  const employeeHistoryCalls = useMemo(() => {
    return doctorCalls
      .filter((c) => {
        if (c.employeeUid !== effectiveHistoryUid) return false;
        if (historyDateFilter) {
          const callIso =
            c.callDate ||
            (tsToMs(c.createdAt) ? new Date(tsToMs(c.createdAt)).toISOString().slice(0, 10) : '');
          if (callIso !== historyDateFilter) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const diff = tsToMs(a.createdAt) - tsToMs(b.createdAt);
        if (diff !== 0) return diff;
        return (a.callDate || '').localeCompare(b.callDate || '');
      });
  }, [doctorCalls, effectiveHistoryUid, historyDateFilter]);

  const employeeHistoryLocations = useMemo(() => {
    return locations
      .filter((l) => {
        if (l.userId !== effectiveHistoryUid) return false;
        if (historyDateFilter) {
          const ms = tsToMs(l.recordedAt);
          if (!ms) return false;
          const pingIso = new Date(ms).toISOString().slice(0, 10);
          if (pingIso !== historyDateFilter) return false;
        }
        return true;
      })
      .sort((a, b) => tsToMs(a.recordedAt) - tsToMs(b.recordedAt));
  }, [locations, effectiveHistoryUid, historyDateFilter]);

  const employeeGpsHistoryCalls = useMemo(
    () =>
      employeeHistoryCalls.filter(
        (c) => typeof c.lat === 'number' && typeof c.lng === 'number'
      ),
    [employeeHistoryCalls]
  );

  useEffect(() => {
    setFocusedCallId(null);
  }, [effectiveHistoryUid, historyDateFilter, mapViewMode]);

  const handleQuickPinCallLocation = async (call: DoctorCallRecord) => {
    setGpsError('');
    setGpsSuccess('');
    setPinningCallId(call.id);
    try {
      const pt = await captureCurrentGps(10000);
      const place =
        (await reverseGeocodeCoords(pt.lat, pt.lng)) ||
        [call.areaBeat, call.clinicName].filter(Boolean).join(', ') ||
        'Field GPS Location';

      const batch = writeBatch(db);
      batch.update(doc(db, 'doctorCalls', call.id), {
        lat: pt.lat,
        lng: pt.lng,
        accuracy: pt.accuracy,
        locationName: place.slice(0, 200),
      });

      const canCreatePingForOwner =
        call.employeeUid === currentUser.uid ||
        ['Super Admin', 'Admin'].includes(currentUser.role);
      if (canCreatePingForOwner) {
        const locId = generateId('loc');
        const dist = calculateHaversineMeters(
          pt.lat,
          pt.lng,
          geofenceLat,
          geofenceLng
        );
        batch.set(doc(db, 'locations', locId), {
          id: locId,
          userId: call.employeeUid,
          employeeName: call.employeeName.slice(0, 120),
          territory: place.slice(0, 120),
          lat: pt.lat,
          lng: pt.lng,
          accuracy: pt.accuracy,
          trackingActive: false,
          status: 'Customer Visit',
          customerId: call.doctorId,
          customerName: `${call.doctorName}${
            call.clinicName ? ` (${call.clinicName})` : ''
          }`.slice(0, 140),
          withinGeofence: dist <= geofenceRadius,
          note: `Doctor Call: ${place}`.slice(0, 240),
          recordedAt: serverTimestamp(),
        });
      }

      await batch.commit();
      setGpsSuccess(`Pinned GPS location (${place}) for ${call.doctorName}'s call.`);
    } catch (err: any) {
      if (err?.code === 'permission-denied') {
        handleFirestoreError(err, OperationType.UPDATE, `doctorCalls/${call.id}`);
      } else {
        setGpsError(err?.message || 'Unable to capture GPS for this call.');
      }
    } finally {
      setPinningCallId(null);
    }
  };

  const visitHistoryRecordCount =
    employeeHistoryCalls.length + employeeHistoryLocations.length;

  const handleDownloadVisitHistoryCsv = () => {
    const safeCellText = (val?: string): string => {
      const str = (val || '').trim();
      return /^[=+\-@]/.test(str) ? `'${str}` : str;
    };

    const empName =
      selectedHistoryEmployee?.name || currentUser.displayName || 'Employee';
    const empTerritory = selectedHistoryEmployee?.territory || '';

    interface CombinedExportRow {
      sortMs: number;
      cells: (string | number | boolean | undefined)[];
    }

    const combined: CombinedExportRow[] = [];

    for (const c of employeeHistoryCalls) {
      const ms = tsToMs(c.createdAt);
      const hasCoords = typeof c.lat === 'number' && typeof c.lng === 'number';
      const timestampLabel = ms > 0 ? formatTimestamp(c.createdAt) : c.callDate || '—';
      const isoTimestamp = ms > 0 ? new Date(ms).toISOString() : '';
      const dateStr =
        c.callDate || (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '');
      const place =
        c.locationName || c.areaBeat || c.clinicName || 'GPS not captured';

      combined.push({
        sortMs: ms > 0 ? ms : dateStr ? new Date(dateStr).getTime() : 0,
        cells: [
          'Doctor Call',
          safeCellText(c.employeeName || empName),
          c.employeeUid || effectiveHistoryUid,
          safeCellText(empTerritory || c.areaBeat),
          dateStr,
          timestampLabel,
          isoTimestamp,
          safeCellText(
            c.clinicName ? `${c.doctorName} (${c.clinicName})` : c.doctorName
          ),
          safeCellText(place),
          hasCoords ? Number((c.lat as number).toFixed(6)) : '',
          hasCoords ? Number((c.lng as number).toFixed(6)) : '',
          typeof c.accuracy === 'number' ? Math.round(c.accuracy) : '',
          safeCellText(c.callOutcome),
          safeCellText(
            [
              c.productsShown?.length
                ? `Products: ${c.productsShown.join('; ')}`
                : '',
              c.doctorRemark ? `Remark: ${c.doctorRemark}` : '',
            ]
              .filter(Boolean)
              .join(' | ')
          ),
        ],
      });
    }

    for (const loc of employeeHistoryLocations) {
      const ms = tsToMs(loc.recordedAt);
      const timestampLabel = ms > 0 ? formatTimestamp(loc.recordedAt) : '—';
      const isoTimestamp = ms > 0 ? new Date(ms).toISOString() : '';
      const dateStr = ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '';

      combined.push({
        sortMs: ms,
        cells: [
          'GPS Ping',
          safeCellText(loc.employeeName || empName),
          loc.userId || effectiveHistoryUid,
          safeCellText(loc.territory || empTerritory),
          dateStr,
          timestampLabel,
          isoTimestamp,
          safeCellText(loc.customerName || loc.status),
          safeCellText(loc.territory || loc.customerName || 'Field Zone'),
          Number(loc.lat.toFixed(6)),
          Number(loc.lng.toFixed(6)),
          Math.round(loc.accuracy || 0),
          `${loc.status} · ${loc.withinGeofence ? 'Inside Geofence' : 'Outside Geofence'}`,
          safeCellText(loc.note),
        ],
      });
    }

    combined.sort((a, b) => a.sortMs - b.sortMs);

    const headers = [
      'Record Type',
      'Employee',
      'Employee UID',
      'Territory',
      'Date',
      'Timestamp',
      'ISO Timestamp',
      'Visit / Target',
      'Location Name',
      'Latitude',
      'Longitude',
      'Accuracy (m)',
      'Outcome / Geofence',
      'Notes / Products',
    ];

    const slug = empName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'employee';
    const dateSlug = historyDateFilter || 'all-dates';

    exportToCsv(
      `glacetor-visit-history-${slug}-${dateSlug}.csv`,
      headers,
      combined.map((r) => r.cells)
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            {isAdminView ? 'Live Field Force GPS Map' : 'My Work Location & Customer Visits'}
          </h2>
          <p className="text-xs text-slate-500">
            Transparent, permission-based work-hour location tracking and geofence verification.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAndroidGuide((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
          >
            <Smartphone className="w-4 h-4" />
            Android Background GPS Info
          </button>

          {!isTracking ? (
            <button
              type="button"
              onClick={() => setShowConsentDialog(true)}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[40px]"
            >
              <Navigation className="w-4 h-4" />
              Start Duty GPS Tracking
            </button>
          ) : (
            <button
              type="button"
              onClick={stopLiveTracking}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 rounded-lg min-h-[40px]"
            >
              <StopCircle className="w-4 h-4" />
              Stop Tracking
            </button>
          )}
        </div>
      </div>

      {/* Explicit Active Tracking Indicator */}
      {isTracking && (
        <div className="bg-emerald-50 border border-emerald-300 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs text-emerald-900">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-600 animate-pulse shrink-0" />
            <div className="min-w-0">
              <strong>Live Location Tracking Active across all tabs:</strong> Your work coordinates are streaming transparently during this shift.
              {currentCoords && (
                <span className="ml-1.5 font-mono text-[11px] text-emerald-800">
                  ({currentCoords.lat.toFixed(5)}, {currentCoords.lng.toFixed(5)} · ±{Math.round(currentCoords.accuracy)}m
                  {lastPingAtMs ? ` · Synced ${formatRelativeAge(lastPingAtMs, nowMs)}` : ''})
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={stopLiveTracking}
            className="font-semibold underline shrink-0"
          >
            Pause / Stop
          </button>
        </div>
      )}

      {permissionState === 'denied' && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 text-xs text-amber-900 flex items-start gap-2.5">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Browser location permission is currently blocked. Live tracking is disabled and no synthetic coordinates will be generated. Enable Location in Chrome/Android site settings and retry.
          </span>
        </div>
      )}

      {(gpsError || trackingError) && (
        <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{gpsError || trackingError}</span>
        </div>
      )}

      {gpsSuccess && (
        <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{gpsSuccess}</span>
        </div>
      )}

      {showAndroidGuide && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 text-xs text-slate-700 space-y-2">
          <h3 className="text-sm font-bold text-[#0F2744]">
            Android PWA vs. Native Background Location Architecture
          </h3>
          <p>
            Standard browser PWAs (including Chrome on Android) restrict the <code className="font-mono">Geolocation API</code> to active foreground/screen-on sessions for battery and privacy protection. When the phone is locked or Chrome is backgrounded, OS power management pauses <code className="font-mono">watchPosition()</code>.
          </p>
          <p className="font-semibold text-slate-900 pt-1">
            Required Android Native Configuration for Continuous Background Route Tracking:
          </p>
          <ul className="list-disc list-inside space-y-1 text-slate-600">
            <li>Wrap this PWA with Capacitor (<code className="font-mono">@capacitor-community/background-geolocation</code>) or Trusted Web Activity + Foreground Service.</li>
            <li>Declare <code className="font-mono">ACCESS_FINE_LOCATION</code>, <code className="font-mono">ACCESS_COARSE_LOCATION</code>, <code className="font-mono">ACCESS_BACKGROUND_LOCATION</code>, and <code className="font-mono">FOREGROUND_SERVICE_LOCATION</code> in <code className="font-mono">AndroidManifest.xml</code>.</li>
            <li>Display a persistent Android Foreground Service notification while duty tracking is active.</li>
          </ul>
        </div>
      )}

      {/* Map + Customer Visit Check-In / Dedicated Employee Visit History */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-3">
          {/* Mode Switcher + Context Controls */}
          <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
            <div className="inline-flex rounded-lg bg-slate-100 p-1 text-xs font-semibold self-start">
              <button
                type="button"
                onClick={() => setMapViewMode('live')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                  mapViewMode === 'live'
                    ? 'bg-[#0F2744] text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <MapIcon className="w-3.5 h-3.5" />
                Live Field Map
              </button>
              <button
                type="button"
                onClick={() => {
                  if (routeUserId && !historyEmployeeUid) {
                    setHistoryEmployeeUid(routeUserId);
                  }
                  setMapViewMode('visit-history');
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                  mapViewMode === 'visit-history'
                    ? 'bg-[#5B21B6] text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <History className="w-3.5 h-3.5" />
                Employee Visit History
              </button>
            </div>

            {mapViewMode === 'live' ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-medium text-slate-500 tabular-nums">
                  <strong className="text-[#15803D]">{livePersonnelCount} live</strong> · {activePersonnel.length} tracked · {customers.length} customers
                  {clusterStats?.isClustered
                    ? ` · ${clusterStats.clusterCount} clusters (Z${clusterStats.zoom})`
                    : ''}
                </span>
                <button
                  type="button"
                  onClick={() => setClusterEmployees((v) => !v)}
                  aria-pressed={clusterEmployees}
                  title="Group nearby employee location pins when zoomed out"
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                    clusterEmployees
                      ? 'bg-[#0F2744] text-white border-[#0F2744]'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <Layers className="w-3.5 h-3.5" />
                  Cluster Pins
                </button>
                {isAdminView && (
                  <select
                    aria-label="Check employee live location"
                    value={focusedEmployeeUid || ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (!val) {
                        setFocusedEmployeeUid(null);
                      } else {
                        focusEmployeeOnMap(val);
                      }
                    }}
                    className="px-2.5 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-800 max-w-[230px]"
                  >
                    <option value="">Check Employee Live Location...</option>
                    {personnelLiveRows.map((row) => (
                      <option key={row.uid} value={row.uid}>
                        {row.statusInfo.state === 'live'
                          ? '● LIVE · '
                          : row.statusInfo.isLiveNow
                          ? '◐ '
                          : ''}
                        {row.name} ({row.statusInfo.label})
                      </option>
                    ))}
                  </select>
                )}
                {isAdminView && demoPingCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowDemoPings((v) => !v)}
                    className={`px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border transition-colors whitespace-nowrap ${
                      showDemoPings
                        ? 'bg-slate-800 text-white border-slate-800'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {showDemoPings ? 'Hide Demo' : 'Show Demo'}
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {isAdminView ? (
                  <div className="inline-flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-slate-500" />
                    <select
                      aria-label="Select employee for visit history"
                      value={effectiveHistoryUid}
                      onChange={(e) => setHistoryEmployeeUid(e.target.value)}
                      className="px-2.5 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-800"
                    >
                      {employeeDirectoryOptions.map((emp) => (
                        <option key={emp.uid} value={emp.uid}>
                          {emp.name}
                          {emp.territory ? ` (${emp.territory})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 text-xs font-semibold text-[#0F2744]">
                    <User className="w-3.5 h-3.5" />
                    {currentUser.displayName}
                  </span>
                )}

                <div className="inline-flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-slate-500" />
                  <input
                    type="date"
                    aria-label="Filter visit history by date"
                    value={historyDateFilter}
                    onChange={(e) => setHistoryDateFilter(e.target.value)}
                    className="px-2 py-1 text-xs font-mono border border-slate-300 rounded-lg bg-white"
                  />
                  {historyDateFilter ? (
                    <button
                      type="button"
                      onClick={() => setHistoryDateFilter('')}
                      className="text-[11px] font-medium text-slate-600 hover:text-slate-900 underline"
                    >
                      All Dates
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setHistoryDateFilter(todayIsoDate())}
                      className="px-2 py-1 text-[11px] font-semibold text-[#0F2744] bg-slate-100 hover:bg-slate-200 rounded-md"
                    >
                      Today
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleDownloadVisitHistoryCsv}
                  disabled={visitHistoryRecordCount === 0}
                  title={
                    visitHistoryRecordCount === 0
                      ? 'No visit history records for the current filter'
                      : `Download CSV report for ${selectedHistoryEmployee?.name || 'employee'}`
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download CSV</span>
                </button>
              </div>
            )}
          </div>

          {/* Dedicated Visit History Summary Strip */}
          {mapViewMode === 'visit-history' && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div className="bg-white border border-slate-200 rounded-xl px-3.5 py-2.5">
                <div className="text-[11px] text-slate-500">Doctor Calls</div>
                <div className="text-base font-bold font-mono tabular-nums text-[#0F2744]">
                  {employeeHistoryCalls.length}
                </div>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl px-3.5 py-2.5">
                <div className="text-[11px] text-slate-500">Plotted Call Pins</div>
                <div className="text-base font-bold font-mono tabular-nums text-[#5B21B6]">
                  {employeeGpsHistoryCalls.length}
                </div>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl px-3.5 py-2.5">
                <div className="text-[11px] text-slate-500">Missing GPS</div>
                <div className="text-base font-bold font-mono tabular-nums text-amber-700">
                  {employeeHistoryCalls.length - employeeGpsHistoryCalls.length}
                </div>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl px-3.5 py-2.5">
                <div className="text-[11px] text-slate-500">GPS Trail Pings</div>
                <div className="text-base font-bold font-mono tabular-nums text-[#15803D]">
                  {employeeHistoryLocations.length}
                </div>
              </div>
            </div>
          )}

          {/* Focused Employee Live Location Inspector Card */}
          {mapViewMode === 'live' && focusedPersonnel && (
            <div className="bg-white border-2 border-[#0F2744]/25 rounded-xl p-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-[#0F2744]">
                    {focusedPersonnel.name}
                  </span>
                  <span className="text-[11px] font-medium text-slate-500">
                    {focusedPersonnel.roleLabel} · {focusedPersonnel.territory}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold ${
                      focusedPersonnel.statusInfo.state === 'live'
                        ? 'bg-emerald-100 text-[#15803D]'
                        : focusedPersonnel.statusInfo.state === 'recent'
                        ? 'bg-sky-100 text-sky-800'
                        : focusedPersonnel.statusInfo.state === 'stale'
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {focusedPersonnel.statusInfo.state === 'live' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[#15803D] animate-pulse" />
                    )}
                    {focusedPersonnel.statusInfo.label} · {focusedPersonnel.statusInfo.ageLabel}
                  </span>
                </div>

                {focusedPersonnel.latestPing ? (
                  <div className="text-xs text-slate-600 space-y-0.5">
                    <div className="font-mono text-[11px] tabular-nums text-slate-700">
                      {focusedPersonnel.latestPing.lat.toFixed(6)},{' '}
                      {focusedPersonnel.latestPing.lng.toFixed(6)} (±
                      {Math.round(focusedPersonnel.latestPing.accuracy)}m) ·{' '}
                      <span
                        className={
                          focusedPersonnel.latestPing.withinGeofence
                            ? 'text-[#15803D] font-semibold'
                            : 'text-amber-700 font-semibold'
                        }
                      >
                        {focusedPersonnel.latestPing.withinGeofence
                          ? 'Inside Geofence'
                          : 'Outside Geofence'}
                      </span>
                    </div>
                    {(focusedPersonnel.latestPing.customerName ||
                      focusedPersonnel.latestPing.note) && (
                      <div className="text-[11px] text-slate-500 truncate">
                        {[
                          focusedPersonnel.latestPing.customerName,
                          focusedPersonnel.latestPing.note,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-amber-700">
                    This employee has not shared a GPS ping yet today. Ask them to tap GPS Check-In or Start Duty GPS Tracking.
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                {focusedPersonnel.latestPing && (
                  <>
                    <button
                      type="button"
                      onClick={() => setFocusTick((t) => t + 1)}
                      className="px-2.5 py-1.5 text-[11px] font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg"
                    >
                      Center Pin
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setRouteUserId((cur) =>
                          cur === focusedPersonnel.uid ? '' : focusedPersonnel.uid
                        )
                      }
                      className={`px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border ${
                        routeUserId === focusedPersonnel.uid
                          ? 'bg-[#15803D] text-white border-[#15803D]'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {routeUserId === focusedPersonnel.uid ? 'Hide Route' : 'Show Route'}
                    </button>
                    <a
                      href={`https://www.google.com/maps?q=${focusedPersonnel.latestPing.lat.toFixed(
                        6
                      )},${focusedPersonnel.latestPing.lng.toFixed(6)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-[#0F2744] bg-slate-100 hover:bg-slate-200 rounded-lg"
                    >
                      Google Maps <ExternalLink className="w-3 h-3" />
                    </a>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setHistoryEmployeeUid(focusedPersonnel.uid);
                    setMapViewMode('visit-history');
                  }}
                  className="px-2.5 py-1.5 text-[11px] font-semibold text-[#5B21B6] bg-violet-50 hover:bg-violet-100 border border-violet-200 rounded-lg"
                >
                  Visit History
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFocusedEmployeeUid(null);
                    if (routeUserId === focusedPersonnel.uid) setRouteUserId('');
                  }}
                  className="px-2 py-1.5 text-[11px] font-medium text-slate-500 hover:text-slate-800"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          <LiveMap
            locations={
              mapViewMode === 'visit-history' ? employeeHistoryLocations : visibleLocations
            }
            customers={customers}
            doctorCalls={mapViewMode === 'visit-history' ? employeeHistoryCalls : doctorCalls}
            geofenceCenter={geofenceCenter}
            routeUserId={mapViewMode === 'live' ? routeUserId : undefined}
            visitHistoryMode={mapViewMode === 'visit-history'}
            clusterEmployees={clusterEmployees}
            focusedCallId={focusedCallId}
            focusedEmployeeUid={mapViewMode === 'live' ? focusedEmployeeUid : null}
            focusTick={focusTick}
            onSelectCall={handleSelectCall}
            onSelectEmployee={handleSelectEmployee}
            onClusterStatsChange={handleClusterStatsChange}
            onTileCached={handleTileCached}
          />

          {/* Map Legend */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-600 px-1">
            {mapViewMode === 'visit-history' ? (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-[#5B21B6] border border-white shadow-sm" />
                  Doctor Call Pin (#Order · Timestamp)
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-[#0EA5E9] border border-[#0F2744]" />
                  Customer / Field GPS Ping
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-4 h-0.5 bg-[#6D28D9]" />
                  Call Visit Sequence
                </span>
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-[#15803D]" />
                  Live Personnel / Customer Pin
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3.5 h-3.5 rounded-full bg-[#0F2744] border border-[#15803D]" />
                  Employee Cluster (Click to zoom or list)
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-[#7C3AED]" />
                  Doctor Call Pin
                </span>
              </>
            )}
          </div>

          {/* Offline Territory Base Map Cache Panel */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2.5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-start gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-[#0F2744]/10 text-[#0F2744] flex items-center justify-center shrink-0">
                  <HardDrive className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-bold text-slate-900 flex items-center gap-2 flex-wrap">
                    <span>Offline Territory Map Cache ({territoryLabel})</span>
                    {cachedTileCount > 0 && (
                      <span className="font-mono text-[11px] font-semibold text-[#15803D] bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                        {cachedTileCount} tiles ready
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {!tileCacheSupported
                      ? 'Browser Cache Storage API unavailable.'
                      : tileMeta
                      ? `Zoom ${tileMeta.zoomLevels.join(', ')} · Last synced ${formatTimestamp(
                          tileMeta.cachedAt
                        )}`
                      : 'Recently viewed map tiles cache automatically, or download your full territory grid for offline field coverage.'}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {cachingTiles ? (
                  <button
                    type="button"
                    onClick={() => cacheAbortRef.current?.abort()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg min-h-[38px]"
                  >
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Cancel ({cacheProgress?.completed || 0}/{cacheProgress?.total || 0})
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!tileCacheSupported}
                    onClick={handleCacheTerritoryMap}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-slate-800 rounded-lg min-h-[38px] disabled:opacity-50"
                  >
                    <Download className="w-3.5 h-3.5" />
                    {cachedTileCount > 0 ? 'Refresh Territory Tiles' : 'Cache Territory Map'}
                  </button>
                )}
                {cachedTileCount > 0 && !cachingTiles && (
                  <button
                    type="button"
                    onClick={handleClearTileCache}
                    title="Clear cached map tiles"
                    className="p-2 text-slate-500 hover:text-red-700 hover:bg-red-50 border border-slate-200 rounded-lg min-h-[38px] min-w-[38px] flex items-center justify-center"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {cachingTiles && cacheProgress && cacheProgress.total > 0 && (
              <div className="space-y-1">
                <progress
                  value={cacheProgress.completed}
                  max={cacheProgress.total}
                  className="w-full h-1.5 rounded overflow-hidden accent-[#15803D]"
                />
                <div className="text-[11px] font-mono text-slate-500 flex items-center justify-between">
                  <span>
                    Caching base map tiles: {cacheProgress.completed} / {cacheProgress.total}
                  </span>
                  <span>
                    +{cacheProgress.newlyCached} new · {cacheProgress.alreadyCached} cached
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Employee Visit History Timeline OR Customer Visit Check-In + Status */}
        <div className="space-y-4">
          {mapViewMode === 'visit-history' ? (
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-[#0F2744] flex items-center gap-1.5">
                    <Stethoscope className="w-4 h-4 text-[#5B21B6]" />
                    {selectedHistoryEmployee?.name || 'Employee'} · Call Timeline
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {historyDateFilter
                      ? `Doctor calls on ${historyDateFilter}`
                      : 'All recorded doctor calls in chronological order'}
                  </p>
                </div>
                <span className="px-2 py-0.5 rounded-md bg-violet-50 text-[#5B21B6] border border-violet-200 font-mono text-[11px] font-semibold shrink-0">
                  {employeeHistoryCalls.length} calls
                </span>
              </div>

              {employeeHistoryCalls.length === 0 ? (
                <div className="py-10 text-center space-y-1.5">
                  <Stethoscope className="w-8 h-8 text-slate-300 mx-auto" />
                  <p className="text-xs font-medium text-slate-600">
                    No doctor calls recorded for this employee
                    {historyDateFilter ? ` on ${historyDateFilter}` : ''}.
                  </p>
                  {historyDateFilter && (
                    <button
                      type="button"
                      onClick={() => setHistoryDateFilter('')}
                      className="text-xs font-semibold text-[#0F2744] hover:underline"
                    >
                      Show all dates
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2.5 max-h-[540px] overflow-y-auto pr-1">
                  {(() => {
                    let gpsStopIndex = 0;
                    return employeeHistoryCalls.map((c) => {
                      const summary = formatCallLocationSummary(c);
                      const stopNumber = summary.hasGps ? ++gpsStopIndex : null;
                      const isFocused = focusedCallId === c.id;
                      const canPin = isAdminView || c.employeeUid === currentUser.uid;
                      const exactTimestamp =
                        tsToMs(c.createdAt) > 0
                          ? formatTimestamp(c.createdAt)
                          : c.callDate;

                      return (
                        <div
                          key={c.id}
                          onClick={() => {
                            if (summary.hasGps) setFocusedCallId(c.id);
                          }}
                          className={`p-3 rounded-xl border text-xs space-y-1.5 transition-colors ${
                            summary.hasGps ? 'cursor-pointer' : ''
                          } ${
                            isFocused
                              ? 'border-[#5B21B6] bg-violet-50/60 ring-1 ring-[#5B21B6]'
                              : 'border-slate-200 bg-white hover:border-slate-300'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold shrink-0 ${
                                  stopNumber
                                    ? 'bg-[#5B21B6] text-white'
                                    : 'bg-amber-100 text-amber-800'
                                }`}
                              >
                                {stopNumber ? `#${stopNumber}` : 'No GPS'}
                              </span>
                              <span className="font-bold text-[#0F2744] truncate">
                                {c.doctorName}
                              </span>
                            </div>
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 shrink-0">
                              {c.callOutcome}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 text-[11px] font-mono text-[#5B21B6] font-semibold">
                            <Clock className="w-3 h-3 shrink-0" />
                            <span>{exactTimestamp}</span>
                          </div>

                          <div className="flex items-start justify-between gap-2 text-[11px] text-slate-700">
                            <span className="inline-flex items-start gap-1">
                              <MapPin
                                className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                                  summary.hasGps ? 'text-[#15803D]' : 'text-amber-600'
                                }`}
                              />
                              <span>{summary.label}</span>
                            </span>
                            {summary.hasGps && summary.mapsUrl ? (
                              <a
                                href={summary.mapsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-0.5 font-semibold text-[#0F2744] hover:underline shrink-0"
                              >
                                Map <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : (
                              canPin && (
                                <button
                                  type="button"
                                  disabled={pinningCallId === c.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleQuickPinCallLocation(c);
                                  }}
                                  className="inline-flex items-center gap-1 font-semibold text-[#15803D] hover:underline shrink-0 disabled:opacity-50"
                                >
                                  {pinningCallId === c.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Navigation className="w-3 h-3" />
                                  )}
                                  Pin GPS
                                </button>
                              )
                            )}
                          </div>

                          {c.productsShown.length > 0 && (
                            <div className="text-[11px] text-slate-600 truncate">
                              Detailed: {c.productsShown.join(', ')}
                            </div>
                          )}

                          {summary.hasGps && (
                            <div className="font-mono text-[10px] text-slate-400 tabular-nums">
                              {summary.coordsText}
                              {typeof c.accuracy === 'number'
                                ? ` (±${Math.round(c.accuracy)}m)`
                                : ''}
                            </div>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          ) : (
            <>
              <form
                onSubmit={handleCustomerVisitCheckIn}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
              >
                <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-[#15803D]" />
                  Log GPS Customer Visit
                </h3>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Customer / Pharmacy / Hospital
                  </label>
                  <select
                    value={selectedCustomerId}
                    onChange={(e) => setSelectedCustomerId(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="">General field check-in...</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.businessName} ({c.city})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Visit Summary
                  </label>
                  <input
                    type="text"
                    value={visitNote}
                    onChange={(e) => setVisitNote(e.target.value)}
                    placeholder="e.g. Sample drop & stock discussion"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2.5 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg min-h-[44px]"
                >
                  Capture Current GPS Visit
                </button>
              </form>

              {/* Latest Personnel / Call Locations List */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {historyTab === 'calls'
                      ? 'Doctor Call Locations'
                      : isAdminView
                      ? 'Authorized Field Force Status'
                      : 'My Recent Location History'}
                  </h3>
                  <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-[11px] font-semibold">
                    <button
                      type="button"
                      onClick={() => setHistoryTab('pings')}
                      className={`px-2.5 py-1 rounded-md ${
                        historyTab === 'pings'
                          ? 'bg-white text-[#0F2744] shadow-sm'
                          : 'text-slate-600'
                      }`}
                    >
                      Live GPS
                    </button>
                    <button
                      type="button"
                      onClick={() => setHistoryTab('calls')}
                      className={`px-2.5 py-1 rounded-md inline-flex items-center gap-1 ${
                        historyTab === 'calls'
                          ? 'bg-white text-[#0F2744] shadow-sm'
                          : 'text-slate-600'
                      }`}
                    >
                      <Stethoscope className="w-3 h-3" />
                      Calls ({doctorCalls.length})
                    </button>
                  </div>
                </div>

                {historyTab === 'pings' ? (
                  isAdminView ? (
                    <div className="space-y-2.5">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={personnelSearch}
                          onChange={(e) => setPersonnelSearch(e.target.value)}
                          placeholder="Search employee or territory..."
                          className="flex-1 px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#0F2744]"
                        />
                      </div>
                      <div className="flex items-center gap-1 text-[11px] font-semibold">
                        {(
                          [
                            { id: 'all', label: `All (${personnelLiveRows.length})` },
                            { id: 'live', label: `Live (${livePersonnelCount})` },
                            {
                              id: 'on-duty',
                              label: `On Duty (${
                                personnelLiveRows.filter((r) => r.statusInfo.isLiveNow).length
                              })`,
                            },
                          ] as const
                        ).map((f) => (
                          <button
                            key={f.id}
                            type="button"
                            onClick={() => setPersonnelFilter(f.id)}
                            className={`px-2 py-1 rounded-md border ${
                              personnelFilter === f.id
                                ? 'bg-[#0F2744] text-white border-[#0F2744]'
                                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                            }`}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>

                      {filteredPersonnelRows.length === 0 ? (
                        <p className="text-xs text-slate-400 py-4 text-center">
                          No matching employees found.
                        </p>
                      ) : (
                        <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                          {filteredPersonnelRows.map((row) => {
                            const loc = row.latestPing;
                            const isSelected = focusedEmployeeUid === row.uid;
                            return (
                              <div
                                key={row.uid}
                                onClick={() => focusEmployeeOnMap(row.uid)}
                                className={`p-3 rounded-xl border text-xs space-y-1 cursor-pointer transition-colors ${
                                  isSelected
                                    ? 'border-[#0F2744] bg-slate-50 ring-1 ring-[#0F2744]'
                                    : 'border-slate-200 bg-white hover:border-slate-300'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-semibold text-slate-900 truncate">
                                    {row.name}
                                  </span>
                                  <span
                                    className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                                      row.statusInfo.state === 'live'
                                        ? 'bg-emerald-100 text-[#15803D]'
                                        : row.statusInfo.state === 'recent'
                                        ? 'bg-sky-100 text-sky-800'
                                        : row.statusInfo.state === 'stale'
                                        ? 'bg-amber-100 text-amber-800'
                                        : 'bg-slate-100 text-slate-600'
                                    }`}
                                  >
                                    {row.statusInfo.state === 'live' && (
                                      <span className="w-1.5 h-1.5 rounded-full bg-[#15803D] animate-pulse" />
                                    )}
                                    {row.statusInfo.label}
                                  </span>
                                </div>
                                <div className="text-[11px] text-slate-500 flex items-center justify-between gap-2">
                                  <span className="truncate">
                                    {row.roleLabel} · {row.territory}
                                  </span>
                                  <span className="font-mono text-[10px] text-slate-400 shrink-0">
                                    {row.statusInfo.ageLabel}
                                  </span>
                                </div>
                                {loc ? (
                                  <>
                                    {loc.note && (
                                      <div className="text-[11px] text-slate-500 truncate">
                                        {loc.customerName || loc.note}
                                      </div>
                                    )}
                                    <div className="flex items-center justify-between gap-2 pt-0.5 font-mono text-[10px] text-slate-500 tabular-nums">
                                      <span>
                                        {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)} (±
                                        {Math.round(loc.accuracy)}m)
                                      </span>
                                      <span className="font-sans font-semibold text-[#0F2744]">
                                        Check on Map →
                                      </span>
                                    </div>
                                  </>
                                ) : (
                                  <div className="text-[11px] text-slate-400 italic">
                                    No live GPS ping recorded yet
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : visibleLocations.length === 0 ? (
                    <p className="text-xs text-slate-400 py-4 text-center">
                      No GPS records available yet.
                    </p>
                  ) : (
                    <div className="space-y-2.5 max-h-[280px] overflow-y-auto pr-1">
                      {visibleLocations.slice(0, 12).map((loc) => (
                        <div
                          key={loc.id}
                          onClick={() => focusEmployeeOnMap(loc.userId)}
                          className="p-3 rounded-lg border border-slate-200 text-xs space-y-1 cursor-pointer hover:border-slate-300"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-slate-900">
                              {loc.employeeName}
                            </span>
                            <span
                              className={`font-semibold ${
                                loc.trackingActive && loc.status !== 'Checked Out'
                                  ? 'text-[#15803D]'
                                  : 'text-slate-600'
                              }`}
                            >
                              {loc.trackingActive && loc.status !== 'Checked Out'
                                ? `Live · ${formatRelativeAge(loc.recordedAt, nowMs)}`
                                : loc.status}
                            </span>
                          </div>
                          <div className="text-slate-600 font-medium">
                            {loc.customerName || loc.territory || 'Field Zone'} ·{' '}
                            {loc.withinGeofence ? 'Inside Geofence' : 'Outside Geofence'}
                          </div>
                          {loc.note && (
                            <div className="text-[11px] text-slate-500 truncate">{loc.note}</div>
                          )}
                          <div className="font-mono text-[11px] text-slate-400 tabular-nums">
                            {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)} (±{Math.round(loc.accuracy)}m) ·{' '}
                            {formatTimestamp(loc.recordedAt)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                ) : doctorCalls.length === 0 ? (
                  <p className="text-xs text-slate-400 py-4 text-center">
                    No doctor calls logged yet.
                  </p>
                ) : (
                  <div className="space-y-2.5 max-h-[280px] overflow-y-auto pr-1">
                    {doctorCalls.slice(0, 20).map((c) => {
                      const summary = formatCallLocationSummary(c);
                      const canPin = isAdminView || c.employeeUid === currentUser.uid;
                      return (
                        <div
                          key={c.id}
                          className="p-3 rounded-lg border border-slate-200 text-xs space-y-1"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-[#0F2744] truncate">
                              {c.doctorName}
                            </span>
                            <span className="font-mono text-[10px] text-slate-500 shrink-0">
                              {tsToMs(c.createdAt) > 0
                                ? formatTimestamp(c.createdAt)
                                : c.callDate}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-600 flex items-center justify-between gap-2">
                            <span>
                              Rep:{' '}
                              <strong className="font-medium text-slate-800">
                                {c.employeeName}
                              </strong>
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setHistoryEmployeeUid(c.employeeUid);
                                setMapViewMode('visit-history');
                                if (summary.hasGps) setFocusedCallId(c.id);
                              }}
                              className="text-[10px] font-semibold text-[#5B21B6] hover:underline shrink-0"
                            >
                              View History Map
                            </button>
                          </div>
                          <div className="flex items-start justify-between gap-2 pt-0.5">
                            <span className="inline-flex items-start gap-1 text-[11px] text-slate-700">
                              <MapPin
                                className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                                  summary.hasGps ? 'text-[#15803D]' : 'text-amber-600'
                                }`}
                              />
                              <span>{summary.label}</span>
                            </span>
                            {summary.hasGps && summary.mapsUrl ? (
                              <a
                                href={summary.mapsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-[#0F2744] hover:underline shrink-0"
                              >
                                Map <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : (
                              canPin && (
                                <button
                                  type="button"
                                  disabled={pinningCallId === c.id}
                                  onClick={() => handleQuickPinCallLocation(c)}
                                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#15803D] hover:underline shrink-0 disabled:opacity-50"
                                >
                                  {pinningCallId === c.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Navigation className="w-3 h-3" />
                                  )}
                                  Pin GPS
                                </button>
                              )
                            )}
                          </div>
                          {summary.hasGps && (
                            <div className="font-mono text-[10px] text-slate-400 tabular-nums">
                              {summary.coordsText}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Consent Explanation Dialog before requesting Geolocation */}
      {showConsentDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 shadow-xl">
            <div className="flex items-center gap-2.5 text-[#0F2744] mb-3">
              <Info className="w-5 h-5" />
              <h3 className="text-base font-bold">Work Location Permission Notice</h3>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed mb-4">
              Glacetor Remedies Pvt. Ltd. requests your device GPS location transparently only during authorized working hours to verify attendance check-in, customer pharmacy visits, and territory geofencing. Tracking never runs covertly and stops immediately when you check out or tap Stop Tracking.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowConsentDialog(false)}
                className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={startLiveTracking}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg"
              >
                Allow & Start Tracking
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
