import React, { useEffect, useMemo, useRef, useState } from 'react';
import { waitForPendingWrites } from 'firebase/firestore';
import {
  CheckCircle2,
  CloudCheck,
  CloudOff,
  Database,
  RefreshCw,
  WifiOff,
  X,
} from 'lucide-react';
import { db, offlinePersistenceEnabled, testConnection } from '../lib/firebase';
import { useOnlineStatus } from '../hooks/usePWAInstall';

export interface CollectionSyncState {
  pendingWrites: number;
  fromCache: boolean;
}

interface SyncStatusIndicatorProps {
  syncMap: Record<string, CollectionSyncState>;
  snapshotsInSyncTick: number;
}

const COLLECTION_LABELS: Record<string, string> = {
  settings: 'Company Settings',
  users: 'User Accounts',
  employees: 'Employees',
  attendance: 'Attendance',
  leaveRequests: 'Leave Requests',
  locations: 'GPS Locations',
  tasks: 'Tasks',
  taskUpdates: 'Task Updates',
  activityLogs: 'Activity Logs',
  products: 'Products',
  stockMovements: 'Stock Movements',
  stockAllocations: 'Stock Allocations',
  customers: 'Customers',
  salesOrders: 'Sales Orders',
  payments: 'Payments',
  distributors: 'Distributors',
  notifications: 'Notifications',
  tourPlans: 'Tour Plans',
  doctors: 'Doctors',
  doctorCalls: 'Doctor Calls',
  biometricCredentials: 'Biometric Devices',
};

export const SyncStatusIndicator: React.FC<SyncStatusIndicatorProps> = ({
  syncMap,
  snapshotsInSyncTick,
}) => {
  const isOnline = useOnlineStatus();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [justSynced, setJustSynced] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const hadPendingOrOfflineRef = useRef(false);
  const justSyncedTimerRef = useRef<number | null>(null);

  const { pendingCount, pendingCollections, anyFromCache, listenerCount } = useMemo(() => {
    const entries = Object.entries(syncMap) as [string, CollectionSyncState][];
    let totalPending = 0;
    const pendingList: { key: string; label: string; count: number }[] = [];
    let cached = false;

    for (const [key, state] of entries) {
      if (state.pendingWrites > 0) {
        totalPending += state.pendingWrites;
        pendingList.push({
          key,
          label: COLLECTION_LABELS[key] || key,
          count: state.pendingWrites,
        });
      }
      if (state.fromCache) {
        cached = true;
      }
    }

    return {
      pendingCount: totalPending,
      pendingCollections: pendingList,
      anyFromCache: cached,
      listenerCount: entries.length,
    };
  }, [syncMap]);

  useEffect(() => {
    if (!isOnline || pendingCount > 0 || anyFromCache) {
      hadPendingOrOfflineRef.current = true;
    }

    if (!isOnline || pendingCount > 0) {
      return;
    }

    if (listenerCount > 0 && !anyFromCache) {
      setLastSyncedAt(new Date());
      if (hadPendingOrOfflineRef.current) {
        hadPendingOrOfflineRef.current = false;
        setJustSynced(true);
        if (justSyncedTimerRef.current) {
          window.clearTimeout(justSyncedTimerRef.current);
        }
        justSyncedTimerRef.current = window.setTimeout(() => {
          setJustSynced(false);
        }, 4500);
      }
    }
  }, [isOnline, pendingCount, anyFromCache, listenerCount, snapshotsInSyncTick]);

  // Flush and confirm offline database sync automatically when network returns
  useEffect(() => {
    if (!isOnline || !hadPendingOrOfflineRef.current) return;
    let cancelled = false;
    waitForPendingWrites(db)
      .then(() => {
        if (cancelled) return;
        setLastSyncedAt(new Date());
        if (pendingCount === 0 && !anyFromCache) {
          hadPendingOrOfflineRef.current = false;
          setJustSynced(true);
          if (justSyncedTimerRef.current) {
            window.clearTimeout(justSyncedTimerRef.current);
          }
          justSyncedTimerRef.current = window.setTimeout(() => {
            setJustSynced(false);
          }, 4500);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOnline, pendingCount, anyFromCache]);

  useEffect(() => {
    return () => {
      if (justSyncedTimerRef.current) {
        window.clearTimeout(justSyncedTimerRef.current);
      }
    };
  }, []);

  // Close popover on outside click
  useEffect(() => {
    if (!popoverOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [popoverOpen]);

  const handleVerifySync = async () => {
    setVerifyMsg('');
    if (!isOnline) {
      setVerifyMsg(
        pendingCount > 0
          ? `Device is offline. ${pendingCount} local change(s) are safely stored in IndexedDB and will upload automatically when connected.`
          : 'Device is offline. Local ERP data is served from the offline cache.'
      );
      return;
    }

    setVerifying(true);
    try {
      await waitForPendingWrites(db);
      const res = await testConnection();
      if (res.online) {
        setLastSyncedAt(new Date());
        setJustSynced(true);
        if (justSyncedTimerRef.current) {
          window.clearTimeout(justSyncedTimerRef.current);
        }
        justSyncedTimerRef.current = window.setTimeout(() => {
          setJustSynced(false);
        }, 4500);
        setVerifyMsg('Offline cache and all pending writes are synchronized with Firestore.');
      } else {
        setVerifyMsg(res.error || 'Firestore server unreachable right now.');
      }
    } catch {
      setVerifyMsg('Sync verification timed out while waiting for network.');
    } finally {
      setVerifying(false);
    }
  };

  // Determine visual state
  let btnStyle =
    'text-[#15803D] bg-emerald-50 hover:bg-emerald-100 border-emerald-200';
  let IconComponent: React.ComponentType<{ className?: string }> = CloudCheck;
  let desktopLabel = justSynced ? 'Synced with Firestore' : 'Synced';
  let mobileLabel = justSynced ? 'Synced ✓' : 'Synced';
  let iconSpin = false;

  if (!isOnline) {
    btnStyle = 'text-amber-800 bg-amber-50 hover:bg-amber-100 border-amber-200';
    IconComponent = pendingCount > 0 ? CloudOff : WifiOff;
    desktopLabel =
      pendingCount > 0 ? `Offline · ${pendingCount} pending` : 'Offline (Cached)';
    mobileLabel = pendingCount > 0 ? `${pendingCount} queued` : 'Offline';
  } else if (verifying || pendingCount > 0) {
    btnStyle = 'text-[#0F2744] bg-sky-50 hover:bg-sky-100 border-sky-200';
    IconComponent = RefreshCw;
    desktopLabel =
      pendingCount > 0 ? `Syncing (${pendingCount})...` : 'Verifying sync...';
    mobileLabel = pendingCount > 0 ? `Sync (${pendingCount})` : 'Syncing';
    iconSpin = true;
  } else if (anyFromCache && listenerCount > 0) {
    btnStyle = 'text-slate-700 bg-slate-100 hover:bg-slate-200 border-slate-200';
    IconComponent = Database;
    desktopLabel = 'Syncing cache...';
    mobileLabel = 'Cached';
  }

  const formattedLastSync = lastSyncedAt
    ? lastSyncedAt.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : 'Awaiting server';

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setVerifyMsg('');
          setPopoverOpen((v) => !v);
        }}
        aria-expanded={popoverOpen}
        aria-label={`Firestore sync status: ${desktopLabel}`}
        title={desktopLabel}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[36px] ${btnStyle}`}
      >
        <IconComponent
          className={`w-3.5 h-3.5 shrink-0 ${iconSpin ? 'animate-spin' : ''}`}
        />
        <span className="hidden sm:inline font-mono tabular-nums text-[11px]">
          {desktopLabel}
        </span>
        <span className="sm:hidden font-mono tabular-nums text-[11px]">
          {mobileLabel}
        </span>
      </button>

      {popoverOpen && (
        <div className="fixed sm:absolute right-3 sm:right-0 top-14 sm:top-full sm:mt-2 w-[calc(100vw-24px)] max-w-xs sm:w-80 bg-white border border-slate-200 rounded-xl shadow-lg p-4 z-50 space-y-3 text-left">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs font-bold text-[#0F2744]">
                Offline Database &amp; Cloud Sync
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {offlinePersistenceEnabled
                  ? 'IndexedDB persistent offline cache active'
                  : 'Session memory cache active'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPopoverOpen(false)}
              className="p-1 text-slate-400 hover:text-slate-700 rounded"
              aria-label="Close sync details"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Connection</span>
              <span
                className={`font-semibold ${
                  isOnline ? 'text-[#15803D]' : 'text-amber-700'
                }`}
              >
                {isOnline ? 'Online · Firestore Ready' : 'Offline Mode'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Pending Local Writes</span>
              <span className="font-mono tabular-nums font-semibold text-slate-900">
                {pendingCount}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Last Confirmed Sync</span>
              <span className="font-mono tabular-nums text-slate-700">
                {formattedLastSync}
              </span>
            </div>
          </div>

          {pendingCollections.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold text-slate-700">
                Queued Local Changes ({pendingCount})
              </div>
              <ul className="space-y-1 max-h-32 overflow-y-auto">
                {pendingCollections.map((item) => (
                  <li
                    key={item.key}
                    className="flex items-center justify-between text-xs px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-900"
                  >
                    <span className="truncate">{item.label}</span>
                    <span className="font-mono tabular-nums font-semibold shrink-0 ml-2">
                      {item.count} pending
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-[#15803D] bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>
                All {listenerCount} active modules are synchronized with Firestore.
              </span>
            </div>
          )}

          {verifyMsg && (
            <div className="text-[11px] text-slate-700 bg-slate-100 rounded-lg px-2.5 py-2 leading-relaxed">
              {verifyMsg}
            </div>
          )}

          <button
            type="button"
            disabled={verifying}
            onClick={handleVerifySync}
            className="w-full py-2 px-3 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg flex items-center justify-center gap-1.5 min-h-[38px] disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${verifying ? 'animate-spin' : ''}`} />
            <span>{verifying ? 'Verifying Firestore Sync...' : 'Verify Sync Now'}</span>
          </button>
        </div>
      )}
    </div>
  );
};
