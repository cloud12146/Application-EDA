/// <reference types="google.maps" />
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AdvancedMarker,
  AdvancedMarkerAnchorPoint,
  AdvancedMarkerProps,
  APIProvider,
  Circle,
  InfoWindow,
  Map as GoogleMap,
  Pin,
  Polyline,
  useAdvancedMarkerRef,
  useMap,
} from '@vis.gl/react-google-maps';
import { Customer, DoctorCallRecord, LocationPing } from '../types/erp';
import { formatTimeOnly, formatTimestamp, tsToMs } from '../lib/utils';
import {
  clusterLocationsForViewport,
  getLatestLocationsByUser,
  ViewportBoundsLiteral,
  ViewportLocationCluster,
} from '../lib/mapClustering';
import { LeafletFallbackMap } from './LeafletFallbackMap';

export interface MapClusterStats {
  totalEmployees: number;
  visibleMarkerCount: number;
  clusterCount: number;
  zoom: number;
  isClustered: boolean;
}

interface LiveMapProps {
  locations: LocationPing[];
  customers?: Customer[];
  doctorCalls?: DoctorCallRecord[];
  geofenceCenter?: { lat: number; lng: number; radiusM: number; label?: string };
  routeUserId?: string;
  visitHistoryMode?: boolean;
  clusterEmployees?: boolean;
  focusedCallId?: string | null;
  focusedEmployeeUid?: string | null;
  focusTick?: number;
  heightClass?: string;
  onTileCached?: () => void;
  onSelectCall?: (callId: string) => void;
  onSelectEmployee?: (userId: string) => void;
  onClusterStatsChange?: (stats: MapClusterStats) => void;
}

function getCallTimestampLabel(call: DoctorCallRecord): string {
  const ms = tsToMs(call.createdAt);
  if (ms > 0) {
    return formatTimestamp(call.createdAt);
  }
  return call.callDate || '—';
}

function getCallShortBadgeTime(call: DoctorCallRecord): string {
  const ms = tsToMs(call.createdAt);
  if (ms > 0) {
    const time = formatTimeOnly(call.createdAt);
    if (time && time !== '—') return time;
  }
  return call.callDate ? call.callDate.slice(5) : '';
}

type SelectedMapInfo =
  | {
      kind: 'employee';
      id: string;
      anchor: google.maps.marker.AdvancedMarkerElement;
      loc: LocationPing;
    }
  | {
      kind: 'cluster';
      id: string;
      anchor: google.maps.marker.AdvancedMarkerElement;
      cluster: ViewportLocationCluster;
    }
  | {
      kind: 'customer';
      id: string;
      anchor: google.maps.marker.AdvancedMarkerElement;
      customer: Customer;
    }
  | {
      kind: 'call';
      id: string;
      anchor: google.maps.marker.AdvancedMarkerElement;
      call: DoctorCallRecord;
      stopNo?: number;
    }
  | {
      kind: 'visit';
      id: string;
      anchor: google.maps.marker.AdvancedMarkerElement;
      loc: LocationPing;
    };

interface AdvancedMarkerWithRefProps extends Omit<AdvancedMarkerProps, 'onClick'> {
  onMarkerClick: (marker: google.maps.marker.AdvancedMarkerElement) => void;
  registerMarker?: (marker: google.maps.marker.AdvancedMarkerElement | null) => void;
}

const AdvancedMarkerWithRef: React.FC<AdvancedMarkerWithRefProps> = ({
  children,
  onMarkerClick,
  registerMarker,
  ...advancedMarkerProps
}) => {
  const [markerRef, marker] = useAdvancedMarkerRef();

  useEffect(() => {
    registerMarker?.(marker);
    return () => registerMarker?.(null);
  }, [marker, registerMarker]);

  return (
    <AdvancedMarker
      ref={markerRef}
      onClick={() => {
        if (marker) {
          onMarkerClick(marker);
        }
      }}
      {...advancedMarkerProps}
    >
      {children}
    </AdvancedMarker>
  );
};

interface GoogleLiveMapInnerProps extends LiveMapProps {
  onMapsLoadError: () => void;
}

const GoogleLiveMapInner: React.FC<GoogleLiveMapInnerProps> = ({
  locations,
  customers = [],
  doctorCalls = [],
  geofenceCenter,
  routeUserId,
  visitHistoryMode = false,
  clusterEmployees = true,
  focusedCallId = null,
  focusedEmployeeUid = null,
  focusTick = 0,
  onSelectCall,
  onSelectEmployee,
  onClusterStatsChange,
}) => {
  const map = useMap();
  const [zoom, setZoom] = useState(12);
  const [boundsLiteral, setBoundsLiteral] = useState<ViewportBoundsLiteral | null>(null);
  const [selectedInfo, setSelectedInfo] = useState<SelectedMapInfo | null>(null);

  const callMarkerInstancesRef = useRef<
    Record<string, google.maps.marker.AdvancedMarkerElement>
  >({});
  const empMarkerInstancesRef = useRef<
    Record<string, google.maps.marker.AdvancedMarkerElement>
  >({});
  const lastFitKeyRef = useRef<string>('');
  const lastClusterStatsRef = useRef<MapClusterStats | null>(null);
  const onClusterStatsChangeRef = useRef(onClusterStatsChange);
  onClusterStatsChangeRef.current = onClusterStatsChange;

  const syncCameraMetrics = useCallback(() => {
    if (!map) return;
    const nextZoom = map.getZoom();
    if (typeof nextZoom === 'number') {
      setZoom(nextZoom);
    }
    const b = map.getBounds();
    if (b) {
      const ne = b.getNorthEast();
      const sw = b.getSouthWest();
      setBoundsLiteral({
        north: ne.lat(),
        east: ne.lng(),
        south: sw.lat(),
        west: sw.lng(),
      });
    }
  }, [map]);

  const sortedHistoryPings = useMemo(() => {
    if (!visitHistoryMode) return [];
    return [...locations].sort(
      (a, b) => tsToMs(a.recordedAt) - tsToMs(b.recordedAt)
    );
  }, [visitHistoryMode, locations]);

  const historyVisitPings = useMemo(
    () => sortedHistoryPings.filter((l) => l.status === 'Customer Visit'),
    [sortedHistoryPings]
  );

  const historyGpsCalls = useMemo(() => {
    if (!visitHistoryMode) return [];
    return doctorCalls
      .filter((c) => typeof c.lat === 'number' && typeof c.lng === 'number')
      .sort((a, b) => {
        const diff = tsToMs(a.createdAt) - tsToMs(b.createdAt);
        if (diff !== 0) return diff;
        return (a.callDate || '').localeCompare(b.callDate || '');
      });
  }, [visitHistoryMode, doctorCalls]);

  const liveGpsCalls = useMemo(() => {
    if (visitHistoryMode) return [];
    return doctorCalls.filter(
      (c) => typeof c.lat === 'number' && typeof c.lng === 'number'
    );
  }, [visitHistoryMode, doctorCalls]);

  const latestLocations = useMemo(() => {
    if (visitHistoryMode) return [];
    return getLatestLocationsByUser(locations);
  }, [visitHistoryMode, locations]);

  const routeCoords = useMemo(() => {
    if (visitHistoryMode || !routeUserId) return [];
    return locations
      .filter((l) => l.userId === routeUserId)
      .map((l) => ({ lat: l.lat, lng: l.lng }));
  }, [visitHistoryMode, routeUserId, locations]);

  const clusterResult = useMemo(() => {
    if (visitHistoryMode) {
      return {
        clusters: [] as ViewportLocationCluster[],
        totalEmployees: 0,
        visibleMarkerCount: 0,
        clusterCount: 0,
        zoom,
        isClustered: false,
      };
    }
    return clusterLocationsForViewport(latestLocations, zoom, boundsLiteral, {
      enabled: clusterEmployees,
      maxClusterZoom: 14,
      excludeUserId: focusedEmployeeUid || routeUserId || undefined,
    });
  }, [
    visitHistoryMode,
    latestLocations,
    zoom,
    boundsLiteral,
    clusterEmployees,
    focusedEmployeeUid,
    routeUserId,
  ]);

  useEffect(() => {
    const nextStats: MapClusterStats = {
      totalEmployees: clusterResult.totalEmployees,
      visibleMarkerCount: clusterResult.visibleMarkerCount,
      clusterCount: clusterResult.clusterCount,
      zoom: clusterResult.zoom,
      isClustered: clusterResult.isClustered,
    };
    const prev = lastClusterStatsRef.current;
    if (
      prev &&
      prev.totalEmployees === nextStats.totalEmployees &&
      prev.visibleMarkerCount === nextStats.visibleMarkerCount &&
      prev.clusterCount === nextStats.clusterCount &&
      prev.zoom === nextStats.zoom &&
      prev.isClustered === nextStats.isClustered
    ) {
      return;
    }
    lastClusterStatsRef.current = nextStats;
    onClusterStatsChangeRef.current?.(nextStats);
  }, [clusterResult]);

  // Fit map bounds automatically when dataset or mode changes
  useEffect(() => {
    if (!map) return;

    const points: google.maps.LatLngLiteral[] = [];
    if (geofenceCenter && !visitHistoryMode) {
      points.push({ lat: geofenceCenter.lat, lng: geofenceCenter.lng });
    }
    if (!visitHistoryMode) {
      for (const c of customers) {
        if (typeof c.lat === 'number' && typeof c.lng === 'number') {
          points.push({ lat: c.lat, lng: c.lng });
        }
      }
      for (const c of liveGpsCalls) {
        points.push({ lat: c.lat as number, lng: c.lng as number });
      }
      for (const loc of latestLocations) {
        points.push({ lat: loc.lat, lng: loc.lng });
      }
    } else {
      for (const loc of sortedHistoryPings) {
        points.push({ lat: loc.lat, lng: loc.lng });
      }
      for (const c of historyGpsCalls) {
        points.push({ lat: c.lat as number, lng: c.lng as number });
      }
      if (points.length === 0 && geofenceCenter) {
        points.push({ lat: geofenceCenter.lat, lng: geofenceCenter.lng });
      }
    }

    const fitKey = visitHistoryMode
      ? `history:${locations.map((l) => l.id).join(',')}:${doctorCalls.map((c) => c.id).join(',')}`
      : `live:${routeUserId || ''}:${latestLocations.length > 0 ? 'hasLoc' : 'noLoc'}:${
          customers.length > 0 ? 'hasCust' : 'noCust'
        }`;

    if (points.length > 0 && lastFitKeyRef.current !== fitKey) {
      lastFitKeyRef.current = fitKey;
      if (points.length === 1) {
        map.panTo(points[0]);
        map.setZoom(visitHistoryMode ? 15 : 13);
      } else {
        const bounds = new window.google.maps.LatLngBounds();
        points.forEach((pt) => bounds.extend(pt));
        map.fitBounds(bounds, 48);
      }
    }
  }, [
    map,
    visitHistoryMode,
    geofenceCenter?.lat,
    geofenceCenter?.lng,
    customers,
    liveGpsCalls,
    latestLocations,
    sortedHistoryPings,
    historyGpsCalls,
    locations,
    doctorCalls,
    routeUserId,
  ]);

  // Focus selected doctor call
  useEffect(() => {
    if (!focusedCallId || !map) return;
    const call = doctorCalls.find((c) => c.id === focusedCallId);
    if (!call || typeof call.lat !== 'number' || typeof call.lng !== 'number') {
      return;
    }
    map.panTo({ lat: call.lat, lng: call.lng });
    if ((map.getZoom() ?? 12) < 14) {
      map.setZoom(14);
    }
    const anchor = callMarkerInstancesRef.current[focusedCallId];
    if (anchor) {
      const stopIndex = historyGpsCalls.findIndex((c) => c.id === focusedCallId);
      setSelectedInfo({
        kind: 'call',
        id: call.id,
        anchor,
        call,
        stopNo: stopIndex >= 0 ? stopIndex + 1 : undefined,
      });
    }
  }, [focusedCallId, map, doctorCalls, historyGpsCalls]);

  // Focus selected employee in Live Map mode
  useEffect(() => {
    if (visitHistoryMode || !focusedEmployeeUid || !map) return;
    const latestLoc = latestLocations.find((l) => l.userId === focusedEmployeeUid);
    if (!latestLoc) return;
    map.panTo({ lat: latestLoc.lat, lng: latestLoc.lng });
    if ((map.getZoom() ?? 12) < 15) {
      map.setZoom(15);
    }
    const timer = window.setTimeout(() => {
      const anchor = empMarkerInstancesRef.current[focusedEmployeeUid];
      if (anchor) {
        setSelectedInfo({
          kind: 'employee',
          id: latestLoc.userId,
          anchor,
          loc: latestLoc,
        });
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [focusedEmployeeUid, focusTick, visitHistoryMode, map, latestLocations]);

  const initialCenter = useMemo(
    () =>
      geofenceCenter
        ? { lat: geofenceCenter.lat, lng: geofenceCenter.lng }
        : { lat: 19.076, lng: 72.8777 },
    [geofenceCenter?.lat, geofenceCenter?.lng]
  );

  return (
    <GoogleMap
      mapId="DEMO_MAP_ID"
      internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
      defaultCenter={initialCenter}
      defaultZoom={12}
      gestureHandling="greedy"
      style={{ width: '100%', height: '100%' }}
      onIdle={syncCameraMetrics}
      onZoomChanged={syncCameraMetrics}
    >
      {/* Geofence Circle */}
      {geofenceCenter && !visitHistoryMode && (
        <Circle
          center={{ lat: geofenceCenter.lat, lng: geofenceCenter.lng }}
          radius={geofenceCenter.radiusM}
          strokeColor="#0F2744"
          strokeOpacity={0.8}
          strokeWeight={1.5}
          fillColor="#0F2744"
          fillOpacity={0.08}
        />
      )}

      {/* Customer Pins (Live Mode) */}
      {!visitHistoryMode &&
        customers.map((c) => {
          if (typeof c.lat !== 'number' || typeof c.lng !== 'number') return null;
          return (
            <AdvancedMarkerWithRef
              key={`cust_${c.id}`}
              position={{ lat: c.lat, lng: c.lng }}
              title={c.businessName}
              zIndex={40}
              onMarkerClick={(marker) =>
                setSelectedInfo({
                  kind: 'customer',
                  id: c.id,
                  anchor: marker,
                  customer: c,
                })
              }
            >
              <Pin
                background="#16A34A"
                borderColor="#15803D"
                glyphColor="#FFFFFF"
                scale={0.75}
              />
            </AdvancedMarkerWithRef>
          );
        })}

      {/* Visit History Mode Overlays */}
      {visitHistoryMode && sortedHistoryPings.length > 1 && (
        <Polyline
          path={sortedHistoryPings.map((l) => ({ lat: l.lat, lng: l.lng }))}
          strokeColor="#0F2744"
          strokeOpacity={0.6}
          strokeWeight={2.5}
        />
      )}

      {visitHistoryMode &&
        historyVisitPings.map((loc) => (
          <AdvancedMarkerWithRef
            key={`visit_${loc.id}`}
            position={{ lat: loc.lat, lng: loc.lng }}
            anchorPoint={AdvancedMarkerAnchorPoint.CENTER}
            title={loc.customerName || loc.territory || 'Customer Visit'}
            zIndex={60}
            onMarkerClick={(marker) =>
              setSelectedInfo({
                kind: 'visit',
                id: loc.id,
                anchor: marker,
                loc,
              })
            }
          >
            <div className="w-3.5 h-3.5 rounded-full bg-sky-500 border-2 border-[#0F2744] shadow-sm" />
          </AdvancedMarkerWithRef>
        ))}

      {visitHistoryMode && historyGpsCalls.length > 1 && (
        <Polyline
          path={historyGpsCalls.map((c) => ({
            lat: c.lat as number,
            lng: c.lng as number,
          }))}
          strokeColor="#6D28D9"
          strokeOpacity={0.85}
          strokeWeight={3}
        />
      )}

      {visitHistoryMode &&
        historyGpsCalls.map((c, idx) => {
          const stopNo = idx + 1;
          const shortTime = getCallShortBadgeTime(c);
          return (
            <AdvancedMarkerWithRef
              key={`hist_call_${c.id}`}
              position={{ lat: c.lat as number, lng: c.lng as number }}
              anchorPoint={AdvancedMarkerAnchorPoint.CENTER}
              title={`#${stopNo} ${c.doctorName}`}
              zIndex={200 + stopNo}
              registerMarker={(marker) => {
                if (marker) callMarkerInstancesRef.current[c.id] = marker;
                else delete callMarkerInstancesRef.current[c.id];
              }}
              onMarkerClick={(marker) => {
                onSelectCall?.(c.id);
                setSelectedInfo({
                  kind: 'call',
                  id: c.id,
                  anchor: marker,
                  call: c,
                  stopNo,
                });
              }}
            >
              <div className="inline-flex items-center gap-1 bg-[#5B21B6] text-white px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap border-2 border-white shadow-md cursor-pointer">
                <span>#{stopNo}</span>
                {shortTime && (
                  <span className="font-medium opacity-90 text-[10px]">
                    {shortTime}
                  </span>
                )}
              </div>
            </AdvancedMarkerWithRef>
          );
        })}

      {/* Live Mode Doctor Call Pins */}
      {!visitHistoryMode &&
        liveGpsCalls.map((c) => (
          <AdvancedMarkerWithRef
            key={`live_call_${c.id}`}
            position={{ lat: c.lat as number, lng: c.lng as number }}
            title={`Call: ${c.doctorName}`}
            zIndex={80}
            registerMarker={(marker) => {
              if (marker) callMarkerInstancesRef.current[c.id] = marker;
              else delete callMarkerInstancesRef.current[c.id];
            }}
            onMarkerClick={(marker) => {
              onSelectCall?.(c.id);
              setSelectedInfo({
                kind: 'call',
                id: c.id,
                anchor: marker,
                call: c,
              });
            }}
          >
            <Pin
              background="#7C3AED"
              borderColor="#5B21B6"
              glyphColor="#FFFFFF"
              scale={0.8}
            />
          </AdvancedMarkerWithRef>
        ))}

      {/* Live Route Polyline */}
      {!visitHistoryMode && routeCoords.length > 1 && (
        <Polyline
          path={routeCoords}
          strokeColor="#0F2744"
          strokeOpacity={0.78}
          strokeWeight={3}
        />
      )}

      {/* Employee Accuracy Circles (zoomed in or selected route) */}
      {!visitHistoryMode &&
        clusterResult.clusters.map((cluster) => {
          if (cluster.count !== 1) return null;
          const loc = cluster.items[0];
          const isSelectedRoute = Boolean(routeUserId && loc.userId === routeUserId);
          if (zoom < 12 && !isSelectedRoute) return null;
          const isLive = loc.trackingActive && !loc.isDemo && loc.status !== 'Checked Out';
          const color = isLive ? '#15803D' : loc.isDemo ? '#64748B' : '#0F2744';
          return (
            <Circle
              key={`acc_${loc.userId}`}
              center={{ lat: loc.lat, lng: loc.lng }}
              radius={Math.min(loc.accuracy || 30, 500)}
              strokeColor={color}
              strokeOpacity={0.6}
              strokeWeight={1}
              fillColor={color}
              fillOpacity={0.12}
            />
          );
        })}

      {/* Employee Individual & Clustered Pins */}
      {!visitHistoryMode &&
        clusterResult.clusters.map((cluster) => {
          if (cluster.count === 1) {
            const loc = cluster.items[0];
            const isLive = loc.trackingActive && !loc.isDemo && loc.status !== 'Checked Out';
            const isSelectedRoute = Boolean(routeUserId && loc.userId === routeUserId);
            const isFocusedEmp = Boolean(
              focusedEmployeeUid && loc.userId === focusedEmployeeUid
            );
            const bgColor = isLive
              ? '#15803D'
              : loc.isDemo
              ? '#64748B'
              : '#0F2744';
            const zIdx = isFocusedEmp ? 800 : isSelectedRoute ? 500 : isLive ? 250 : 120;

            return (
              <AdvancedMarkerWithRef
                key={`emp_${loc.userId}`}
                position={{ lat: loc.lat, lng: loc.lng }}
                anchorPoint={AdvancedMarkerAnchorPoint.CENTER}
                title={loc.employeeName}
                zIndex={zIdx}
                registerMarker={(marker) => {
                  if (marker) empMarkerInstancesRef.current[loc.userId] = marker;
                  else delete empMarkerInstancesRef.current[loc.userId];
                }}
                onMarkerClick={(marker) => {
                  onSelectEmployee?.(loc.userId);
                  setSelectedInfo({
                    kind: 'employee',
                    id: loc.userId,
                    anchor: marker,
                    loc,
                  });
                }}
              >
                <div
                  className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold text-white whitespace-nowrap border-2 border-white cursor-pointer ${
                    isFocusedEmp
                      ? 'ring-4 ring-emerald-500/45 shadow-lg'
                      : isSelectedRoute
                      ? 'ring-3 ring-[#0F2744]/35 shadow-md'
                      : 'shadow'
                  }`}
                  style={{ backgroundColor: bgColor }}
                >
                  {isLive && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-300 mr-1" />
                  )}
                  {loc.employeeName.split(' ')[0]}
                </div>
              </AdvancedMarkerWithRef>
            );
          }

          const sizePx = cluster.count >= 50 ? 48 : cluster.count >= 10 ? 42 : 36;
          const bgColor =
            cluster.liveCount > 0
              ? '#0F2744'
              : cluster.demoCount === cluster.count
              ? '#475569'
              : '#1E293B';
          const borderAccent = cluster.liveCount > 0 ? '#15803D' : '#CBD5E1';

          return (
            <AdvancedMarkerWithRef
              key={cluster.id}
              position={{ lat: cluster.lat, lng: cluster.lng }}
              anchorPoint={AdvancedMarkerAnchorPoint.CENTER}
              title={`${cluster.count} employees (${cluster.liveCount} live)`}
              zIndex={300}
              onMarkerClick={(marker) => {
                if (cluster.hasGeographicSpread && map && (map.getZoom() ?? 12) < 15) {
                  setSelectedInfo(null);
                  const b = new window.google.maps.LatLngBounds(
                    { lat: cluster.bounds.south, lng: cluster.bounds.west },
                    { lat: cluster.bounds.north, lng: cluster.bounds.east }
                  );
                  map.fitBounds(b, 56);
                  return;
                }
                setSelectedInfo({
                  kind: 'cluster',
                  id: cluster.id,
                  anchor: marker,
                  cluster,
                });
              }}
            >
              <div
                className="rounded-full text-white flex flex-col items-center justify-center border-[3px] border-white font-mono tabular-nums leading-none cursor-pointer shadow-lg"
                style={{
                  width: `${sizePx}px`,
                  height: `${sizePx}px`,
                  backgroundColor: bgColor,
                  boxShadow: `0 0 0 2px ${borderAccent}, 0 4px 12px rgba(15,23,42,0.3)`,
                }}
              >
                <span className={cluster.count >= 50 ? 'text-[13px] font-bold' : 'text-xs font-bold'}>
                  {cluster.count}
                </span>
                {cluster.liveCount > 0 && (
                  <span className="text-[9px] font-semibold text-emerald-300 mt-0.5">
                    {cluster.liveCount} live
                  </span>
                )}
              </div>
            </AdvancedMarkerWithRef>
          );
        })}

      {/* Anchored InfoWindow */}
      {selectedInfo && (
        <InfoWindow
          anchor={selectedInfo.anchor}
          pixelOffset={[0, -4]}
          onCloseClick={() => setSelectedInfo(null)}
        >
          {selectedInfo.kind === 'employee' && (
            <div className="text-xs leading-relaxed min-w-[195px] text-slate-800 space-y-0.5">
              <div className="font-bold text-[#0F2744]">
                {selectedInfo.loc.employeeName}
              </div>
              <div
                className={`font-semibold ${
                  selectedInfo.loc.trackingActive &&
                  !selectedInfo.loc.isDemo &&
                  selectedInfo.loc.status !== 'Checked Out'
                    ? 'text-[#15803D]'
                    : 'text-slate-700'
                }`}
              >
                {selectedInfo.loc.trackingActive &&
                !selectedInfo.loc.isDemo &&
                selectedInfo.loc.status !== 'Checked Out'
                  ? '● LIVE GPS'
                  : selectedInfo.loc.status}
                {selectedInfo.loc.isDemo ? ' (Sample Demo)' : ''}
              </div>
              {selectedInfo.loc.customerName && (
                <div>Place/Call: {selectedInfo.loc.customerName}</div>
              )}
              {selectedInfo.loc.note && <div>Note: {selectedInfo.loc.note}</div>}
              <div>Territory: {selectedInfo.loc.territory || 'Assigned'}</div>
              <div className="font-mono text-[11px]">
                Coords: {selectedInfo.loc.lat.toFixed(5)},{' '}
                {selectedInfo.loc.lng.toFixed(5)} (±
                {Math.round(selectedInfo.loc.accuracy)}m)
              </div>
              <div>Updated: {formatTimestamp(selectedInfo.loc.recordedAt)}</div>
              <a
                href={`https://www.google.com/maps?q=${selectedInfo.loc.lat.toFixed(
                  6
                )},${selectedInfo.loc.lng.toFixed(6)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block mt-1 text-[#0F2744] font-semibold underline"
              >
                Open in Google Maps ↗
              </a>
            </div>
          )}

          {selectedInfo.kind === 'cluster' && (
            <div className="text-xs min-w-[230px] max-w-[280px] text-slate-800">
              <div className="font-bold text-[#0F2744] pb-1.5 border-b border-slate-200">
                {selectedInfo.cluster.count} Field Personnel ·{' '}
                {selectedInfo.cluster.liveCount} Live
              </div>
              <div className="max-h-[210px] overflow-y-auto divide-y divide-slate-100">
                {selectedInfo.cluster.items.slice(0, 30).map((emp) => {
                  const isLive = emp.trackingActive && !emp.isDemo;
                  return (
                    <div
                      key={emp.userId}
                      className="py-1.5 flex justify-between gap-2 items-start"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900 truncate">
                          {emp.employeeName}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {emp.territory || 'Field Zone'} ·{' '}
                          {formatTimestamp(emp.recordedAt)}
                        </div>
                      </div>
                      <span
                        className={`text-[10px] font-bold whitespace-nowrap ${
                          isLive ? 'text-[#15803D]' : 'text-slate-600'
                        }`}
                      >
                        {isLive ? 'Live' : emp.status}
                      </span>
                    </div>
                  );
                })}
              </div>
              {selectedInfo.cluster.count > 30 && (
                <div className="pt-1.5 text-[11px] text-slate-500 text-center">
                  +{selectedInfo.cluster.count - 30} more employees in this cluster
                </div>
              )}
            </div>
          )}

          {selectedInfo.kind === 'customer' && (
            <div className="text-xs leading-relaxed text-slate-800">
              <div className="font-bold text-[#0F2744]">
                {selectedInfo.customer.businessName}
              </div>
              <div>
                {selectedInfo.customer.category} · {selectedInfo.customer.city}
              </div>
              <div>Rep: {selectedInfo.customer.assignedEmployeeName}</div>
            </div>
          )}

          {selectedInfo.kind === 'visit' && (
            <div className="text-xs leading-relaxed text-slate-800">
              <div className="font-bold text-[#0F2744]">
                Visit Ping:{' '}
                {selectedInfo.loc.customerName ||
                  selectedInfo.loc.territory ||
                  'Field Check-in'}
              </div>
              <div>Time: {formatTimestamp(selectedInfo.loc.recordedAt)}</div>
              {selectedInfo.loc.note && <div>{selectedInfo.loc.note}</div>}
              <div>Accuracy: ±{Math.round(selectedInfo.loc.accuracy)}m</div>
            </div>
          )}

          {selectedInfo.kind === 'call' && (
            <div className="text-xs leading-relaxed min-w-[210px] text-slate-800 space-y-0.5">
              <div className="font-bold text-[#0F2744]">
                {selectedInfo.stopNo ? `#${selectedInfo.stopNo} · ` : 'Call: '}
                {selectedInfo.call.doctorName}
              </div>
              <div className="text-[#5B21B6] font-semibold">
                ⏱ {getCallTimestampLabel(selectedInfo.call)}
              </div>
              <div>
                <strong>Rep:</strong> {selectedInfo.call.employeeName}
              </div>
              <div>
                <strong>Place:</strong>{' '}
                {selectedInfo.call.locationName ||
                  selectedInfo.call.areaBeat ||
                  selectedInfo.call.clinicName ||
                  'Call Location'}
              </div>
              {selectedInfo.call.clinicName && (
                <div>
                  <strong>Clinic:</strong> {selectedInfo.call.clinicName}
                </div>
              )}
              <div>
                <strong>Outcome:</strong> {selectedInfo.call.callOutcome}
              </div>
              {selectedInfo.call.productsShown.length > 0 && (
                <div>
                  <strong>Products:</strong>{' '}
                  {selectedInfo.call.productsShown.slice(0, 4).join(', ')}
                </div>
              )}
              {selectedInfo.call.doctorRemark && (
                <div className="pt-0.5 text-slate-600 italic">
                  &ldquo;{selectedInfo.call.doctorRemark}&rdquo;
                </div>
              )}
            </div>
          )}
        </InfoWindow>
      )}
    </GoogleMap>
  );
};

export const LiveMap: React.FC<LiveMapProps> = (props) => {
  const { heightClass = 'h-[420px]' } = props;
  const apiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();

  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [mapsQuotaExceeded, setMapsQuotaExceeded] = useState(false);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    const handleQuotaExceeded = () => setMapsQuotaExceeded(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('gmp-quota-exceeded', handleQuotaExceeded);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('gmp-quota-exceeded', handleQuotaExceeded);
    };
  }, []);

  if (!isOnline || !apiKey || mapsQuotaExceeded) {
    const badge = !isOnline
      ? 'Offline Map · Serving Cached Tiles'
      : mapsQuotaExceeded
      ? 'Cached Fallback Map · Google Maps Quota/Auth Limit'
      : 'Cached Base Map (No Google Maps API Key Configured)';
    return <LeafletFallbackMap {...props} badgeText={badge} />;
  }

  return (
    <div className="relative">
      <div
        className={`w-full ${heightClass} rounded-xl border border-slate-200 overflow-hidden bg-slate-100`}
      >
        <APIProvider
          apiKey={apiKey}
          libraries={['marker']}
          language="en"
          region="IN"
          onError={() => setMapsQuotaExceeded(true)}
        >
          <GoogleLiveMapInner
            {...props}
            onMapsLoadError={() => setMapsQuotaExceeded(true)}
          />
        </APIProvider>
      </div>
    </div>
  );
};
