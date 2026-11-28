import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import { Customer, DoctorCallRecord, LocationPing } from '../types/erp';
import { formatTimeOnly, formatTimestamp, tsToMs } from '../lib/utils';
import {
  cacheSingleTileResponse,
  getCachedTileBlobUrl,
} from '../lib/offlineMapTiles';
import {
  clusterEmployeeLocations,
  getLatestLocationsByUser,
  LocationCluster,
} from '../lib/mapClustering';
import type { MapClusterStats } from './LiveMap';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

class CachedOsmTileLayer extends L.TileLayer {
  private onTileCached?: () => void;

  constructor(
    urlTemplate: string,
    options?: L.TileLayerOptions & { onTileCached?: () => void }
  ) {
    super(urlTemplate, options);
    this.onTileCached = options?.onTileCached;
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const tile = document.createElement('img');
    tile.alt = '';
    tile.setAttribute('role', 'presentation');
    if (this.options.crossOrigin || this.options.crossOrigin === '') {
      tile.crossOrigin =
        this.options.crossOrigin === true ? '' : this.options.crossOrigin;
    }

    const url = this.getTileUrl(coords);
    let objectUrl: string | null = null;
    let settled = false;

    const cleanup = () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    };

    tile.onload = () => {
      cleanup();
      if (!settled) {
        settled = true;
        done(undefined, tile);
      }
    };

    tile.onerror = () => {
      cleanup();
      if (!settled) {
        settled = true;
        done(new Error(`Tile unavailable: ${url}`), tile);
      }
    };

    (async () => {
      try {
        const cachedBlobUrl = await getCachedTileBlobUrl(url);
        if (cachedBlobUrl) {
          objectUrl = cachedBlobUrl;
          tile.src = cachedBlobUrl;
          return;
        }

        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          if (!settled) {
            settled = true;
            done(new Error('Offline and tile not cached'), tile);
          }
          return;
        }

        const res = await fetch(url, { mode: 'cors' });
        if (res.ok) {
          await cacheSingleTileResponse(url, res.clone());
          this.onTileCached?.();
          const blob = await res.blob();
          objectUrl = URL.createObjectURL(blob);
          tile.src = objectUrl;
          return;
        }
      } catch {
        // Fallback to standard browser image load
      }
      tile.src = url;
    })();

    return tile;
  }
}

export interface LeafletFallbackMapProps {
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
  badgeText?: string;
  onTileCached?: () => void;
  onSelectCall?: (callId: string) => void;
  onSelectEmployee?: (userId: string) => void;
  onClusterStatsChange?: (stats: MapClusterStats) => void;
}

export const LeafletFallbackMap: React.FC<LeafletFallbackMapProps> = ({
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
  heightClass = 'h-[420px]',
  badgeText,
  onTileCached,
  onSelectCall,
  onSelectEmployee,
  onClusterStatsChange,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const employeeLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const callMarkersRef = useRef<Record<string, L.Layer>>({});
  const employeeMarkersRef = useRef<Record<string, L.Marker>>({});
  const latestLocationsRef = useRef<LocationPing[]>([]);
  const lastFitKeyRef = useRef<string>('');
  const lastClusterStatsRef = useRef<MapClusterStats | null>(null);
  const onTileCachedRef = useRef(onTileCached);
  onTileCachedRef.current = onTileCached;
  const onSelectCallRef = useRef(onSelectCall);
  onSelectCallRef.current = onSelectCall;
  const onSelectEmployeeRef = useRef(onSelectEmployee);
  onSelectEmployeeRef.current = onSelectEmployee;
  const onClusterStatsChangeRef = useRef(onClusterStatsChange);
  onClusterStatsChangeRef.current = onClusterStatsChange;

  const emitClusterStats = (stats: MapClusterStats) => {
    const prev = lastClusterStatsRef.current;
    if (
      prev &&
      prev.totalEmployees === stats.totalEmployees &&
      prev.visibleMarkerCount === stats.visibleMarkerCount &&
      prev.clusterCount === stats.clusterCount &&
      prev.zoom === stats.zoom &&
      prev.isClustered === stats.isClustered
    ) {
      return;
    }
    lastClusterStatsRef.current = stats;
    onClusterStatsChangeRef.current?.(stats);
  };

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const initialCenter: [number, number] = geofenceCenter
      ? [geofenceCenter.lat, geofenceCenter.lng]
      : [19.076, 72.8777];

    const map = L.map(containerRef.current, {
      center: initialCenter,
      zoom: 12,
      zoomControl: true,
    });

    new CachedOsmTileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
      crossOrigin: 'anonymous',
      onTileCached: () => onTileCachedRef.current?.(),
    }).addTo(map);

    const group = L.layerGroup().addTo(map);
    const empGroup = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerGroupRef.current = group;
    employeeLayerGroupRef.current = empGroup;

    return () => {
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
      employeeLayerGroupRef.current = null;
      callMarkersRef.current = {};
    };
  }, []);

  const renderEmployeeClusters = (
    map: L.Map,
    empGroup: L.LayerGroup,
    isClusterEnabled: boolean,
    isHistoryMode: boolean,
    activeRouteUserId?: string,
    activeFocusedUserId?: string | null
  ) => {
    empGroup.clearLayers();
    employeeMarkersRef.current = {};
    if (isHistoryMode) {
      emitClusterStats({
        totalEmployees: 0,
        visibleMarkerCount: 0,
        clusterCount: 0,
        zoom: map.getZoom(),
        isClustered: false,
      });
      return;
    }

    const result = clusterEmployeeLocations(latestLocationsRef.current, map, {
      enabled: isClusterEnabled,
      maxClusterZoom: 14,
      excludeUserId: activeFocusedUserId || activeRouteUserId || undefined,
    });

    const zoom = result.zoom;

    result.clusters.forEach((cluster: LocationCluster) => {
      if (cluster.count === 1) {
        const loc = cluster.items[0];
        const isLive = loc.trackingActive && !loc.isDemo && loc.status !== 'Checked Out';
        const isSelectedRoute = Boolean(activeRouteUserId && loc.userId === activeRouteUserId);
        const isFocusedEmp = Boolean(activeFocusedUserId && loc.userId === activeFocusedUserId);
        const color = isLive ? '#15803D' : loc.isDemo ? '#64748B' : '#0F2744';

        if (zoom >= 12 || isSelectedRoute) {
          L.circle([loc.lat, loc.lng], {
            radius: Math.min(loc.accuracy || 30, 500),
            color,
            fillColor: color,
            fillOpacity: 0.12,
            weight: 1,
          }).addTo(empGroup);
        }

        const ringStyle = isFocusedEmp
          ? 'box-shadow:0 0 0 4px rgba(22,163,74,0.45), 0 4px 10px rgba(15,23,42,0.35);'
          : isSelectedRoute
          ? 'box-shadow:0 0 0 3px rgba(15,39,68,0.35), 0 2px 6px rgba(15,23,42,0.3);'
          : 'box-shadow:0 2px 6px rgba(15,23,42,0.25);';

        const liveDotHtml = isLive
          ? '<span style="display:inline-block;width:7px;height:7px;border-radius:9999px;background:#86EFAC;margin-right:4px"></span>'
          : '';

        const divIcon = L.divIcon({
          className: 'custom-emp-pin',
          html: `<div style="display:inline-flex;align-items:center;background:${color};color:#fff;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;white-space:nowrap;border:2px solid #fff;${ringStyle}">${liveDotHtml}${escapeHtml(
            loc.employeeName.split(' ')[0]
          )}</div>`,
          iconSize: [96, 26],
          iconAnchor: [48, 13],
        });

        const visitDetails = loc.customerName
          ? `<span>Place/Call: ${escapeHtml(loc.customerName)}</span><br/>`
          : '';
        const noteLine = loc.note ? `<span>Note: ${escapeHtml(loc.note)}</span><br/>` : '';
        const mapsHref = `https://www.google.com/maps?q=${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}`;

        const marker = L.marker([loc.lat, loc.lng], {
          icon: divIcon,
          zIndexOffset: isFocusedEmp ? 800 : isSelectedRoute ? 500 : isLive ? 200 : 0,
        })
          .bindPopup(
            `<div style="font-size:12px;line-height:1.45;min-width:190px">
              <strong>${escapeHtml(loc.employeeName)}</strong><br/>
              <span style="font-weight:600;color:${isLive ? '#15803D' : '#334155'}">${
                isLive ? '● LIVE GPS' : escapeHtml(loc.status)
              }${loc.isDemo ? ' (Sample Demo)' : ''}</span><br/>
              ${visitDetails}${noteLine}<span>Territory: ${escapeHtml(loc.territory || 'Assigned')}</span><br/>
              <span>Coords: ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)} (±${Math.round(loc.accuracy)}m)</span><br/>
              <span>Updated: ${escapeHtml(formatTimestamp(loc.recordedAt))}</span><br/>
              <a href="${mapsHref}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:4px;color:#0F2744;font-weight:600;text-decoration:underline">Open in Google Maps ↗</a>
            </div>`
          )
          .on('click', () => onSelectEmployeeRef.current?.(loc.userId))
          .addTo(empGroup);

        employeeMarkersRef.current[loc.userId] = marker;
      } else {
        const size = cluster.count >= 50 ? 48 : cluster.count >= 10 ? 42 : 36;
        const fontSize = cluster.count >= 50 ? 13 : 12;
        const bgColor =
          cluster.liveCount > 0
            ? '#0F2744'
            : cluster.demoCount === cluster.count
            ? '#475569'
            : '#1E293B';
        const borderAccent = cluster.liveCount > 0 ? '#15803D' : '#CBD5E1';

        const clusterIcon = L.divIcon({
          className: 'custom-emp-cluster-pin',
          html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${bgColor};color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;border:3px solid #fff;box-shadow:0 0 0 2px ${borderAccent}, 0 4px 12px rgba(15,23,42,0.3);font-family:var(--font-mono);font-variant-numeric:tabular-nums;line-height:1;cursor:pointer">
            <span style="font-size:${fontSize}px;font-weight:700">${cluster.count}</span>
            ${
              cluster.liveCount > 0
                ? `<span style="font-size:9px;font-weight:600;color:#86EFAC;margin-top:1px">${cluster.liveCount} live</span>`
                : ''
            }
          </div>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });

        const previewRows = cluster.items
          .slice(0, 30)
          .map((emp) => {
            const isLive = emp.trackingActive && !emp.isDemo;
            const statusText = isLive ? 'Live' : emp.status;
            const statusColor = isLive ? '#15803D' : '#475569';
            return `<div style="padding:5px 0;border-bottom:1px solid #E2E8F0;display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
              <div style="min-width:0">
                <div style="font-weight:600;color:#0F172A">${escapeHtml(emp.employeeName)}</div>
                <div style="font-size:11px;color:#64748B">${escapeHtml(
                  emp.territory || 'Field Zone'
                )} · ${escapeHtml(formatTimestamp(emp.recordedAt))}</div>
              </div>
              <span style="font-size:10px;font-weight:700;color:${statusColor};white-space:nowrap">${escapeHtml(
              statusText
            )}</span>
            </div>`;
          })
          .join('');

        const overflowNotice =
          cluster.count > 30
            ? `<div style="padding-top:6px;font-size:11px;color:#64748B;text-align:center">+${
                cluster.count - 30
              } more employees in this cluster</div>`
            : '';

        const popupHtml = `<div style="font-size:12px;min-width:230px;max-width:280px">
          <div style="font-weight:700;color:#0F2744;padding-bottom:6px;border-bottom:1px solid #CBD5E1">
            ${cluster.count} Field Personnel · ${cluster.liveCount} Live
          </div>
          <div style="max-height:210px;overflow-y:auto">${previewRows}${overflowNotice}</div>
        </div>`;

        const marker = L.marker([cluster.lat, cluster.lng], {
          icon: clusterIcon,
          zIndexOffset: 300,
        })
          .bindTooltip(
            `${cluster.count} employees (${cluster.liveCount} live) · ${
              cluster.hasGeographicSpread && zoom < 15
                ? 'Click to zoom in'
                : 'Click to view roster'
            }`,
            { direction: 'top', offset: [0, -Math.round(size / 2)] }
          )
          .bindPopup(popupHtml)
          .on('click', (e) => {
            if (cluster.hasGeographicSpread && map.getZoom() < 15) {
              e.target.closePopup();
              map.fitBounds(cluster.bounds, {
                padding: [56, 56],
                maxZoom: 15,
                animate: true,
              });
            }
          });

        marker.addTo(empGroup);
      }
    });

    emitClusterStats({
      totalEmployees: result.totalEmployees,
      visibleMarkerCount: result.visibleMarkerCount,
      clusterCount: result.clusterCount,
      zoom: result.zoom,
      isClustered: result.isClustered,
    });
  };

  useEffect(() => {
    const map = mapRef.current;
    const group = layerGroupRef.current;
    const empGroup = employeeLayerGroupRef.current;
    if (!map || !group || !empGroup) return;

    group.clearLayers();
    callMarkersRef.current = {};
    const bounds: L.LatLngExpression[] = [];

    if (geofenceCenter && !visitHistoryMode) {
      L.circle([geofenceCenter.lat, geofenceCenter.lng], {
        radius: geofenceCenter.radiusM,
        color: '#0F2744',
        fillColor: '#0F2744',
        fillOpacity: 0.08,
        weight: 1.5,
        dashArray: '4 4',
      })
        .bindPopup(
          `<strong>${escapeHtml(geofenceCenter.label || 'Authorized Geofence')}</strong><br/>Radius: ${geofenceCenter.radiusM}m`
        )
        .addTo(group);
      bounds.push([geofenceCenter.lat, geofenceCenter.lng]);
    }

    if (!visitHistoryMode) {
      for (const c of customers) {
        if (typeof c.lat === 'number' && typeof c.lng === 'number') {
          const marker = L.circleMarker([c.lat, c.lng], {
            radius: 6,
            color: '#15803D',
            fillColor: '#16A34A',
            fillOpacity: 0.85,
            weight: 2,
          }).bindPopup(
            `<div style="font-size:12px">
              <strong>${escapeHtml(c.businessName)}</strong><br/>
              <span>${escapeHtml(c.category)} · ${escapeHtml(c.city)}</span><br/>
              <span>Rep: ${escapeHtml(c.assignedEmployeeName)}</span>
            </div>`
          );
          marker.addTo(group);
          bounds.push([c.lat, c.lng]);
        }
      }
    }

    if (visitHistoryMode) {
      latestLocationsRef.current = [];
      const sortedPings = [...locations].sort(
        (a, b) => tsToMs(a.recordedAt) - tsToMs(b.recordedAt)
      );
      const pingCoords: L.LatLngExpression[] = sortedPings.map((l) => [l.lat, l.lng]);

      if (pingCoords.length > 1) {
        L.polyline(pingCoords, {
          color: '#0F2744',
          weight: 2.5,
          opacity: 0.55,
          dashArray: '5 5',
        }).addTo(group);
      }

      for (const loc of sortedPings) {
        if (loc.status === 'Customer Visit') {
          const timeLabel = escapeHtml(formatTimestamp(loc.recordedAt));
          const title = escapeHtml(loc.customerName || loc.territory || 'Field Check-in');
          const noteHtml = loc.note ? `<br/><span>${escapeHtml(loc.note)}</span>` : '';
          L.circleMarker([loc.lat, loc.lng], {
            radius: 5,
            color: '#0F2744',
            fillColor: '#0EA5E9',
            fillOpacity: 0.85,
            weight: 1.5,
          })
            .bindPopup(
              `<div style="font-size:12px;line-height:1.4">
                <strong>Visit Ping: ${title}</strong><br/>
                <span>Time: ${timeLabel}</span>${noteHtml}<br/>
                <span>Accuracy: ±${Math.round(loc.accuracy)}m</span>
              </div>`
            )
            .addTo(group);
        }
        bounds.push([loc.lat, loc.lng]);
      }

      const gpsCalls = doctorCalls
        .filter((c) => typeof c.lat === 'number' && typeof c.lng === 'number')
        .sort((a, b) => {
          const diff = tsToMs(a.createdAt) - tsToMs(b.createdAt);
          if (diff !== 0) return diff;
          return (a.callDate || '').localeCompare(b.callDate || '');
        });

      const callTrailCoords: L.LatLngExpression[] = gpsCalls.map((c) => [
        c.lat as number,
        c.lng as number,
      ]);
      if (callTrailCoords.length > 1) {
        L.polyline(callTrailCoords, {
          color: '#6D28D9',
          weight: 3,
          opacity: 0.8,
        }).addTo(group);
      }

      gpsCalls.forEach((c, idx) => {
        const lat = c.lat as number;
        const lng = c.lng as number;
        const stopNo = idx + 1;
        const shortTime = getCallShortBadgeTime(c);
        const fullTime = getCallTimestampLabel(c);
        const place = escapeHtml(
          c.locationName || c.areaBeat || c.clinicName || 'Call Location'
        );

        const pinIcon = L.divIcon({
          className: 'doctor-call-history-pin',
          html: `<div style="display:inline-flex;align-items:center;gap:4px;background:#5B21B6;color:#fff;padding:3px 8px;border-radius:9999px;font-size:11px;font-weight:700;white-space:nowrap;border:2px solid #fff;box-shadow:0 3px 8px rgba(15,23,42,0.32)"><span>#${stopNo}</span>${
            shortTime
              ? `<span style="font-weight:500;opacity:0.92;font-size:10px">${escapeHtml(
                  shortTime
                )}</span>`
              : ''
          }</div>`,
          iconSize: [92, 26],
          iconAnchor: [46, 13],
        });

        const popupHtml = `<div style="font-size:12px;line-height:1.45;min-width:210px">
          <div style="font-weight:700;color:#0F2744">#${stopNo} · ${escapeHtml(
          c.doctorName
        )}</div>
          <div style="color:#5B21B6;font-weight:600;margin-top:2px">⏱ ${escapeHtml(
            fullTime
          )}</div>
          <div><strong>Rep:</strong> ${escapeHtml(c.employeeName)}</div>
          <div><strong>Place:</strong> ${place}</div>
          ${
            c.clinicName
              ? `<div><strong>Clinic:</strong> ${escapeHtml(c.clinicName)}</div>`
              : ''
          }
          <div><strong>Outcome:</strong> ${escapeHtml(c.callOutcome)}</div>
          <div><strong>Products:</strong> ${escapeHtml(
            c.productsShown.slice(0, 4).join(', ')
          )}</div>
          <div style="margin-top:3px;color:#334155;font-style:italic">&ldquo;${escapeHtml(
            c.doctorRemark
          )}&rdquo;</div>
        </div>`;

        const marker = L.marker([lat, lng], { icon: pinIcon })
          .bindPopup(popupHtml)
          .on('click', () => onSelectCallRef.current?.(c.id))
          .addTo(group);

        callMarkersRef.current[c.id] = marker;
        bounds.push([lat, lng]);
      });

      if (bounds.length === 0 && geofenceCenter) {
        bounds.push([geofenceCenter.lat, geofenceCenter.lng]);
      }
    } else {
      for (const c of doctorCalls) {
        if (typeof c.lat === 'number' && typeof c.lng === 'number') {
          const place = escapeHtml(
            c.locationName || c.areaBeat || c.clinicName || 'Call GPS Tagged'
          );
          const fullTime = escapeHtml(getCallTimestampLabel(c));
          const marker = L.circleMarker([c.lat, c.lng], {
            radius: 7,
            color: '#5B21B6',
            fillColor: '#7C3AED',
            fillOpacity: 0.9,
            weight: 2,
          }).bindPopup(
            `<div style="font-size:12px;line-height:1.4">
              <strong>Call: ${escapeHtml(c.doctorName)}</strong><br/>
              <span>Rep: ${escapeHtml(c.employeeName)}</span><br/>
              <span>Time: ${fullTime}</span><br/>
              <span>Place: ${place}</span><br/>
              <span>Outcome: ${escapeHtml(c.callOutcome)}</span><br/>
              <span style="color:#475569">${escapeHtml(
                c.productsShown.slice(0, 3).join(', ')
              )}</span>
            </div>`
          );
          marker.addTo(group);
          callMarkersRef.current[c.id] = marker;
          bounds.push([c.lat, c.lng]);
        }
      }

      const latestLocations = getLatestLocationsByUser(locations);
      latestLocationsRef.current = latestLocations;

      const routeCoords: L.LatLngExpression[] = [];
      if (routeUserId) {
        for (const loc of locations) {
          if (loc.userId === routeUserId) {
            routeCoords.push([loc.lat, loc.lng]);
          }
        }
      }

      if (routeCoords.length > 1) {
        L.polyline(routeCoords, {
          color: '#0F2744',
          weight: 3,
          opacity: 0.75,
        }).addTo(group);
      }

      for (const loc of latestLocations) {
        bounds.push([loc.lat, loc.lng]);
      }
    }

    const fitKey = visitHistoryMode
      ? `history:${locations.map((l) => l.id).join(',')}:${doctorCalls.map((c) => c.id).join(',')}`
      : `live:${routeUserId || ''}:${latestLocationsRef.current.length > 0 ? 'hasLoc' : 'noLoc'}:${
          customers.length > 0 ? 'hasCust' : 'noCust'
        }`;

    if (bounds.length > 0 && lastFitKeyRef.current !== fitKey) {
      lastFitKeyRef.current = fitKey;
      map.fitBounds(L.latLngBounds(bounds), {
        padding: [40, 40],
        maxZoom: visitHistoryMode ? 15 : 14,
      });
    }

    renderEmployeeClusters(
      map,
      empGroup,
      clusterEmployees,
      visitHistoryMode,
      routeUserId,
      focusedEmployeeUid
    );
  }, [
    locations,
    customers,
    doctorCalls,
    geofenceCenter?.lat,
    geofenceCenter?.lng,
    geofenceCenter?.radiusM,
    geofenceCenter?.label,
    routeUserId,
    visitHistoryMode,
    focusedEmployeeUid,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    const empGroup = employeeLayerGroupRef.current;
    if (!map || !empGroup) return;

    renderEmployeeClusters(
      map,
      empGroup,
      clusterEmployees,
      visitHistoryMode,
      routeUserId,
      focusedEmployeeUid
    );

    if (visitHistoryMode) return;

    let rafId: number | null = null;
    const scheduleClusterRefresh = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!mapRef.current || !employeeLayerGroupRef.current) return;
        renderEmployeeClusters(
          mapRef.current,
          employeeLayerGroupRef.current,
          clusterEmployees,
          visitHistoryMode,
          routeUserId,
          focusedEmployeeUid
        );
      });
    };

    map.on('zoomend', scheduleClusterRefresh);
    map.on('moveend', scheduleClusterRefresh);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      map.off('zoomend', scheduleClusterRefresh);
      map.off('moveend', scheduleClusterRefresh);
    };
  }, [clusterEmployees, visitHistoryMode, routeUserId, focusedEmployeeUid]);

  useEffect(() => {
    if (!focusedCallId || !mapRef.current) return;
    const marker = callMarkersRef.current[focusedCallId] as
      | (L.Marker & { getLatLng?: () => L.LatLng; openPopup?: () => void })
      | undefined;
    if (!marker) return;
    const latLng = marker.getLatLng?.();
    if (latLng) {
      mapRef.current.setView(latLng, Math.max(mapRef.current.getZoom(), 14), {
        animate: true,
      });
    }
    marker.openPopup?.();
  }, [focusedCallId]);

  useEffect(() => {
    if (visitHistoryMode || !focusedEmployeeUid || !mapRef.current) return;
    const latestLoc = latestLocationsRef.current.find(
      (l) => l.userId === focusedEmployeeUid
    );
    if (!latestLoc) return;
    const map = mapRef.current;
    map.setView([latestLoc.lat, latestLoc.lng], Math.max(map.getZoom(), 15), {
      animate: true,
    });
    const timer = window.setTimeout(() => {
      const marker = employeeMarkersRef.current[focusedEmployeeUid];
      marker?.openPopup();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [focusedEmployeeUid, focusTick, visitHistoryMode]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className={`w-full ${heightClass} rounded-xl border border-slate-200 overflow-hidden bg-slate-100`}
      />
      {badgeText && (
        <div className="absolute top-2.5 right-2.5 z-[400] px-2.5 py-1 rounded-lg bg-[#0F2744]/90 text-white text-[11px] font-semibold shadow-sm pointer-events-none">
          {badgeText}
        </div>
      )}
    </div>
  );
};
