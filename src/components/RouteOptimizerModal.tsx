import React, { useEffect, useMemo, useRef, useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import {
  CheckSquare,
  Compass,
  Crosshair,
  ExternalLink,
  Loader2,
  MapPin,
  Navigation,
  Route,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  formatDistanceKm,
  GeoOrigin,
  getCurrentBrowserPosition,
  hasValidGps,
  optimizeCustomerVisitRoute,
} from '../lib/routeOptimizer';
import { calculateHaversineMeters } from '../lib/utils';
import { Customer, Employee } from '../types/erp';

interface RouteOptimizerModalProps {
  isOpen: boolean;
  onClose: () => void;
  staffName: string;
  staffEmployee?: Employee;
  customers: Customer[];
  targetDate: string;
  monthDays: string[];
  onApplyRoute: (params: {
    date: string;
    routeZone: string;
    placesToVisit: string;
    plannedCustomers: string;
    objective: string;
  }) => Promise<void> | void;
}

const CATEGORIES = [
  'ALL',
  'Retail Pharmacy',
  'Hospital',
  'Clinic',
  'Stockist',
  'Wholesaler',
] as const;

export const RouteOptimizerModal: React.FC<RouteOptimizerModalProps> = ({
  isOpen,
  onClose,
  staffName,
  staffEmployee,
  customers,
  targetDate,
  monthDays,
  onApplyRoute,
}) => {
  const [applyDate, setApplyDate] = useState(targetDate);
  const [origin, setOrigin] = useState<GeoOrigin | null>(null);
  const [locating, setLocating] = useState(false);
  const [gpsError, setGpsError] = useState('');
  const [radiusKm, setRadiusKm] = useState<number>(0); // 0 = All
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [showMissingGps, setShowMissingGps] = useState(false);
  const didAutoSelectRef = useRef(false);

  const gpsCustomers = useMemo(() => customers.filter(hasValidGps), [customers]);
  const missingGpsCustomers = useMemo(
    () => customers.filter((c) => !hasValidGps(c)),
    [customers]
  );

  useEffect(() => {
    if (isOpen) {
      setApplyDate(targetDate);
    }
  }, [isOpen, targetDate]);

  const setFallbackOrigin = () => {
    if (
      staffEmployee &&
      typeof staffEmployee.geofenceLat === 'number' &&
      typeof staffEmployee.geofenceLng === 'number'
    ) {
      setOrigin({
        lat: staffEmployee.geofenceLat,
        lng: staffEmployee.geofenceLng,
        label: `Base HQ (${staffEmployee.territory || 'Assigned Zone'})`,
        source: 'hq',
      });
      return;
    }
    if (gpsCustomers.length > 0) {
      const first = gpsCustomers[0];
      setOrigin({
        lat: first.lat,
        lng: first.lng,
        label: `Start: ${first.businessName}`,
        source: 'customer',
      });
      return;
    }
    setOrigin({
      lat: 19.076,
      lng: 72.8777,
      label: 'Corporate HQ (Default)',
      source: 'hq',
    });
  };

  const detectCurrentLocation = async () => {
    setLocating(true);
    setGpsError('');
    try {
      const pos = await getCurrentBrowserPosition();
      setOrigin({
        lat: pos.lat,
        lng: pos.lng,
        accuracy: pos.accuracy,
        label: `Live GPS (${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)})`,
        source: 'gps',
      });
    } catch (error: any) {
      setGpsError(error?.message || 'Unable to acquire live GPS location.');
      if (!origin) {
        setFallbackOrigin();
      }
    } finally {
      setLocating(false);
    }
  };

  // Auto-detect GPS when opened
  useEffect(() => {
    if (!isOpen) return;
    detectCurrentLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Sort GPS customers by proximity from active origin
  const proximitySortedCustomers = useMemo(() => {
    const activeOrigin = origin || {
      lat: 19.076,
      lng: 72.8777,
      label: 'HQ',
      source: 'hq' as const,
    };
    return gpsCustomers
      .map((c) => {
        const distM = calculateHaversineMeters(
          activeOrigin.lat,
          activeOrigin.lng,
          c.lat,
          c.lng
        );
        return { customer: c, distMeters: distM };
      })
      .filter((item) => {
        if (categoryFilter !== 'ALL' && item.customer.category !== categoryFilter) {
          return false;
        }
        if (radiusKm > 0 && item.distMeters > radiusKm * 1000) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.distMeters - b.distMeters);
  }, [gpsCustomers, origin, categoryFilter, radiusKm]);

  // Pre-select up to 6 nearest customers once when modal opens
  useEffect(() => {
    if (!isOpen) {
      didAutoSelectRef.current = false;
      return;
    }
    if (!didAutoSelectRef.current && proximitySortedCustomers.length > 0) {
      didAutoSelectRef.current = true;
      setSelectedIds(
        new Set(proximitySortedCustomers.slice(0, 6).map((x) => x.customer.id))
      );
    }
  }, [isOpen, proximitySortedCustomers]);

  const selectedCustomers = useMemo(
    () =>
      proximitySortedCustomers
        .map((item) => item.customer)
        .filter((c) => selectedIds.has(c.id)),
    [proximitySortedCustomers, selectedIds]
  );

  const routeResult = useMemo(() => {
    const activeOrigin: GeoOrigin = origin || {
      lat: 19.076,
      lng: 72.8777,
      label: 'Corporate HQ',
      source: 'hq',
    };
    return optimizeCustomerVisitRoute(activeOrigin, selectedCustomers);
  }, [origin, selectedCustomers]);

  const toggleCustomer = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePinGpsToCustomer = async (customer: Customer) => {
    setPinningId(customer.id);
    setGpsError('');
    try {
      const pos = await getCurrentBrowserPosition();
      await updateDoc(doc(db, 'customers', customer.id), {
        lat: pos.lat,
        lng: pos.lng,
        updatedAt: serverTimestamp(),
      });
      setSelectedIds((prev) => new Set(prev).add(customer.id));
    } catch (error: any) {
      if (error?.message?.includes('permission') || error?.code === 'permission-denied') {
        handleFirestoreError(error, OperationType.UPDATE, `customers/${customer.id}`);
      } else {
        setGpsError(error?.message || 'Unable to capture GPS coordinates.');
      }
    } finally {
      setPinningId(null);
    }
  };

  const handleApplyToPlan = async () => {
    if (routeResult.stops.length === 0) return;
    setApplying(true);
    try {
      const uniqueCities = Array.from(
        new Set(
          routeResult.stops.map((s) =>
            s.customer.address
              ? `${s.customer.city} (${s.customer.address.split(',')[0].trim()})`
              : s.customer.city
          )
        )
      );
      const placesToVisit = uniqueCities.join(', ').slice(0, 300);
      const plannedCustomers = routeResult.stops
        .map((s) => `${s.order}. ${s.customer.businessName}`)
        .join(' -> ')
        .slice(0, 300);
      const routeZone = `Optimal Route (${formatDistanceKm(
        routeResult.totalDistanceMeters
      )})`.slice(0, 120);
      const objective = `Geolocation-optimized ${routeResult.stops.length}-stop visit sequence (${formatDistanceKm(
        routeResult.totalDistanceMeters
      )}, ~${routeResult.estimatedTravelMinutes} min travel${
        routeResult.savedMeters > 0
          ? `, saved ${formatDistanceKm(routeResult.savedMeters)}`
          : ''
      }).`.slice(0, 400);

      await onApplyRoute({
        date: applyDate,
        routeZone,
        placesToVisit,
        plannedCustomers,
        objective,
      });
      onClose();
    } finally {
      setApplying(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 overflow-y-auto no-print">
      <div className="bg-white border border-slate-200 rounded-2xl max-w-4xl w-full max-h-[92vh] overflow-y-auto p-5 sm:p-6 shadow-xl my-auto space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-[#0F2744] flex items-center gap-2">
              <Route className="w-5 h-5 text-[#15803D]" />
              Smart Daily Visit Route Optimizer
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Uses browser Geolocation &amp; proximity clustering (Nearest-Neighbor + 2-opt) to suggest the shortest customer visit order for {staffName}.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Origin & GPS Controls */}
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <Compass className="w-4 h-4 text-[#15803D] shrink-0" />
              <div>
                <span className="font-semibold text-slate-800">Starting Location: </span>
                <span className="text-slate-700">
                  {locating
                    ? 'Acquiring live GPS fix...'
                    : origin
                    ? `${origin.label}${
                        origin.accuracy ? ` (±${Math.round(origin.accuracy)}m)` : ''
                      }`
                    : 'Not set'}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={locating}
                onClick={detectCurrentLocation}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg disabled:opacity-60"
              >
                {locating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Crosshair className="w-3.5 h-3.5" />
                )}
                Use My Live GPS
              </button>
              <button
                type="button"
                onClick={() => {
                  setGpsError('');
                  setFallbackOrigin();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#0F2744] bg-white border border-slate-300 hover:bg-slate-100 rounded-lg"
              >
                <MapPin className="w-3.5 h-3.5" />
                Use HQ / First Stop
              </button>
            </div>
          </div>

          {gpsError && (
            <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs">
              {gpsError}
            </div>
          )}
        </div>

        {/* Filter & Dual-Pane Selection + Route Preview */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Left: Candidate Customers by Proximity */}
          <div className="border border-slate-200 rounded-xl flex flex-col overflow-hidden">
            <div className="p-3.5 bg-slate-50 border-b border-slate-200 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-slate-900">
                  GPS-Tagged Customers ({proximitySortedCustomers.length})
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedIds(
                        new Set(
                          proximitySortedCustomers
                            .slice(0, 5)
                            .map((x) => x.customer.id)
                        )
                      )
                    }
                    className="font-semibold text-[#15803D] hover:underline"
                  >
                    Top 5 Nearest
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedIds(
                        new Set(proximitySortedCustomers.map((x) => x.customer.id))
                      )
                    }
                    className="font-medium text-[#0F2744] hover:underline"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                    className="text-slate-500 hover:underline"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <select
                  value={radiusKm}
                  onChange={(e) => setRadiusKm(Number(e.target.value))}
                  className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value={0}>Any Distance</option>
                  <option value={5}>Within 5 km</option>
                  <option value={10}>Within 10 km</option>
                  <option value={25}>Within 25 km</option>
                  <option value={50}>Within 50 km</option>
                </select>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat === 'ALL' ? 'All Categories' : cat}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="divide-y divide-slate-100 max-h-[300px] overflow-y-auto">
              {proximitySortedCustomers.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500">
                  No customers with GPS coordinates match this radius/category filter.
                </div>
              ) : (
                proximitySortedCustomers.map(({ customer, distMeters }) => {
                  const checked = selectedIds.has(customer.id);
                  return (
                    <button
                      key={customer.id}
                      type="button"
                      onClick={() => toggleCustomer(customer.id)}
                      className={`w-full px-3.5 py-2.5 text-left flex items-start justify-between gap-2.5 hover:bg-slate-50 transition-colors ${
                        checked ? 'bg-emerald-50/40' : ''
                      }`}
                    >
                      <div className="flex items-start gap-2.5 min-w-0">
                        {checked ? (
                          <CheckSquare className="w-4 h-4 text-[#15803D] shrink-0 mt-0.5" />
                        ) : (
                          <Square className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                        )}
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-900 truncate">
                            {customer.businessName}
                          </div>
                          <div className="text-[11px] text-slate-500 truncate">
                            {customer.category} · {customer.city}
                            {customer.address ? ` · ${customer.address}` : ''}
                          </div>
                        </div>
                      </div>
                      <span className="text-[11px] font-mono font-semibold text-[#0F2744] whitespace-nowrap shrink-0">
                        {formatDistanceKm(distMeters)}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            {missingGpsCustomers.length > 0 && (
              <div className="border-t border-slate-200 bg-slate-50 p-3">
                <button
                  type="button"
                  onClick={() => setShowMissingGps((v) => !v)}
                  className="w-full flex items-center justify-between text-[11px] font-semibold text-slate-700"
                >
                  <span>
                    {missingGpsCustomers.length} customer(s) missing GPS coordinates
                  </span>
                  <span className="text-[#0F2744] underline">
                    {showMissingGps ? 'Hide' : 'Pin GPS'}
                  </span>
                </button>
                {showMissingGps && (
                  <div className="mt-2 space-y-1.5 max-h-32 overflow-y-auto">
                    {missingGpsCustomers.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center justify-between gap-2 text-[11px] bg-white border border-slate-200 rounded-lg px-2.5 py-1.5"
                      >
                        <span className="truncate font-medium text-slate-800">
                          {c.businessName} ({c.city})
                        </span>
                        <button
                          type="button"
                          disabled={pinningId === c.id}
                          onClick={() => handlePinGpsToCustomer(c)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-white bg-[#0F2744] rounded shrink-0 disabled:opacity-50"
                        >
                          <MapPin className="w-3 h-3" />
                          {pinningId === c.id ? 'Pinning...' : 'Pin My GPS'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: Optimized Visit Sequence */}
          <div className="border border-slate-200 rounded-xl flex flex-col overflow-hidden">
            <div className="p-3.5 bg-[#0F2744] text-white">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-emerald-400" />
                  Suggested Optimal Visit Sequence
                </div>
                <span className="text-[11px] font-mono text-emerald-300">
                  {routeResult.stops.length} stop{routeResult.stops.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-3 pt-2.5 border-t border-white/15 text-xs">
                <div>
                  <div className="text-[10px] text-slate-300">Total Distance</div>
                  <div className="font-mono font-bold tabular-nums">
                    {formatDistanceKm(routeResult.totalDistanceMeters)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-300">Est. Drive Time</div>
                  <div className="font-mono font-bold tabular-nums">
                    ~{routeResult.estimatedTravelMinutes} min
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-300">Distance Saved</div>
                  <div className="font-mono font-bold tabular-nums text-emerald-300">
                    {routeResult.savedMeters > 0
                      ? `${formatDistanceKm(routeResult.savedMeters)} (${routeResult.savedPercent}%)`
                      : 'Optimal'}
                  </div>
                </div>
              </div>
            </div>

            <div className="divide-y divide-slate-100 max-h-[340px] overflow-y-auto flex-1 bg-white">
              {routeResult.stops.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  Select one or more GPS-tagged customers on the left to compute the shortest visit path.
                </div>
              ) : (
                routeResult.stops.map((stop) => (
                  <div
                    key={stop.customer.id}
                    className="px-3.5 py-2.5 flex items-start justify-between gap-3"
                  >
                    <div className="flex items-start gap-2.5 min-w-0">
                      <span className="w-6 h-6 rounded-lg bg-[#15803D] text-white text-[11px] font-mono font-bold flex items-center justify-center shrink-0 mt-0.5">
                        {stop.order}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-900 truncate">
                          {stop.customer.businessName}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {stop.customer.city}
                          {stop.customer.address ? ` · ${stop.customer.address}` : ''}
                        </div>
                        <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                          +{formatDistanceKm(stop.legMeters)} (~{stop.estimatedLegMinutes}m) ·
                          Total {formatDistanceKm(stop.cumulativeMeters)}
                        </div>
                      </div>
                    </div>

                    <a
                      href={`https://www.google.com/maps/dir/?api=1&destination=${stop.customer.lat},${stop.customer.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-[#0F2744] bg-slate-100 hover:bg-slate-200 rounded shrink-0"
                    >
                      <Navigation className="w-3 h-3" />
                      Map
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Apply to Tour Plan Day Footer */}
        <div className="border-t border-slate-200 pt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-slate-700 whitespace-nowrap">
              Target Tour Date:
            </label>
            <select
              value={applyDate}
              onChange={(e) => setApplyDate(e.target.value)}
              className="px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg bg-white"
            >
              {!monthDays.includes(applyDate) && (
                <option value={applyDate}>{applyDate}</option>
              )}
              {monthDays.map((d) => (
                <option key={d} value={d}>
                  {d} (
                  {new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', {
                    weekday: 'short',
                  })}
                  )
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={routeResult.stops.length === 0 || applying}
              onClick={handleApplyToPlan}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[40px] disabled:opacity-50"
            >
              <Route className="w-3.5 h-3.5" />
              {applying
                ? 'Applying Route...'
                : `Apply ${routeResult.stops.length}-Stop Route to ${applyDate}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
