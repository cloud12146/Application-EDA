import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { doc, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import {
  AlertTriangle,
  ArrowRight,
  CalendarCheck,
  Camera,
  CheckCircle2,
  ClipboardList,
  Download,
  FileImage,
  Loader2,
  MapPin,
  Package,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  ShoppingCart,
  Stethoscope,
  X,
  Zap,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { isManagementRole } from '../lib/roles';
import { executeAtomicStockMovement, logActivity } from '../lib/erpActions';
import {
  captureCurrentGps,
  CapturedGpsPoint,
  reverseGeocodeCoords,
} from '../lib/callLocation';
import {
  calculateHaversineMeters,
  daysUntilDate,
  formatCurrency,
  formatMinutesAsHours,
  generateId,
  todayIsoDate,
} from '../lib/utils';
import {
  AppTab,
  AttendanceRecord,
  CompanySettings,
  Customer,
  Doctor,
  DoctorCallOutcome,
  Employee,
  Product,
  StockAllocation,
  StockMovementType,
  UserAccount,
} from '../types/erp';

interface QuickActionMenuProps {
  currentUser: UserAccount;
  attendance: AttendanceRecord[];
  customers: Customer[];
  doctors: Doctor[];
  products: Product[];
  allocations: StockAllocation[];
  employees: Employee[];
  settings: CompanySettings | null;
  onNavigate: (tab: AppTab) => void;
  onShiftCheckIn?: (pos: GeolocationPosition, workMode: 'Field' | 'Office') => Promise<void> | void;
  onShiftCheckOut?: (pos: GeolocationPosition) => Promise<void> | void;
}

type ActiveQuickModal = null | 'attendance' | 'visit' | 'qr-scanner';

const DOCTOR_OUTCOMES: DoctorCallOutcome[] = [
  'Prescribing',
  'Interested',
  'Follow-up Required',
  'Sample Requested',
  'Not Available',
  'Declined',
];

function parseQrPayloadToProduct(
  rawText: string,
  products: Product[]
): { product: Product | null; queryLabel: string } {
  const trimmed = rawText.trim();
  if (!trimmed) return { product: null, queryLabel: '' };

  let skuCandidate = '';
  let batchCandidate = '';
  let idCandidate = '';

  // 1. JSON payload: {"productId":"...","sku":"...","batch":"..."}
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.productId === 'string') idCandidate = parsed.productId.trim();
      if (typeof parsed.sku === 'string') skuCandidate = parsed.sku.trim();
      if (typeof parsed.batch === 'string') batchCandidate = parsed.batch.trim();
      if (typeof parsed.batchNumber === 'string') batchCandidate = parsed.batchNumber.trim();
    } catch {
      // fall through to other parsers
    }
  }

  // 2. URL query string (?sku=...&batch=...&productId=...)
  if (!idCandidate && !skuCandidate && !batchCandidate && trimmed.includes('://')) {
    try {
      const u = new URL(trimmed);
      idCandidate = u.searchParams.get('productId') || u.searchParams.get('id') || '';
      skuCandidate = u.searchParams.get('sku') || '';
      batchCandidate = u.searchParams.get('batch') || '';
    } catch {
      // ignore invalid URL
    }
  }

  // 3. Colon/pipe separated: GLACETOR:SKU:BATCH
  if (!idCandidate && !skuCandidate && !batchCandidate && /^GLACETOR[:|]/i.test(trimmed)) {
    const parts = trimmed.split(/[:|]/).map((s) => s.trim());
    if (parts[1]) skuCandidate = parts[1];
    if (parts[2]) batchCandidate = parts[2];
  }

  const lower = trimmed.toLowerCase();

  // Exact ID match
  if (idCandidate) {
    const byId = products.find((p) => p.id === idCandidate);
    if (byId) return { product: byId, queryLabel: byId.sku };
  }

  // Exact SKU + Batch match
  if (skuCandidate && batchCandidate) {
    const both = products.find(
      (p) =>
        p.sku.toLowerCase() === skuCandidate.toLowerCase() &&
        p.batchNumber.toLowerCase() === batchCandidate.toLowerCase()
    );
    if (both) return { product: both, queryLabel: `${both.sku} / ${both.batchNumber}` };
  }

  // Exact SKU or Batch match from structured payload or direct input
  const targetSku = (skuCandidate || trimmed).toLowerCase();
  const targetBatch = (batchCandidate || trimmed).toLowerCase();

  const exactMatch =
    products.find((p) => p.id.toLowerCase() === lower) ||
    products.find((p) => p.sku.toLowerCase() === targetSku) ||
    products.find((p) => p.batchNumber.toLowerCase() === targetBatch);

  if (exactMatch) {
    return { product: exactMatch, queryLabel: trimmed };
  }

  // Fallback partial match on SKU, batch, or product name
  const partial = products.find(
    (p) =>
      p.sku.toLowerCase().includes(lower) ||
      p.batchNumber.toLowerCase().includes(lower) ||
      p.name.toLowerCase().includes(lower)
  );

  return { product: partial || null, queryLabel: trimmed };
}

export const QuickActionMenu: React.FC<QuickActionMenuProps> = ({
  currentUser,
  attendance,
  customers,
  doctors,
  products,
  allocations,
  employees,
  settings,
  onNavigate,
  onShiftCheckIn,
  onShiftCheckOut,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeModal, setActiveModal] = useState<ActiveQuickModal>(null);

  const today = todayIsoDate();
  const isDistributor = currentUser.role === 'Distributor';
  const isStockMgr = currentUser.role === 'Stock Manager';
  const isAdminOrMgr = isManagementRole(currentUser.role);
  const isStockAuthorized = isAdminOrMgr || isStockMgr;

  const todayAttendance = useMemo(
    () => attendance.find((a) => a.userId === currentUser.uid && a.date === today),
    [attendance, currentUser.uid, today]
  );

  const isCheckedIn = Boolean(todayAttendance?.checkInTime);
  const isCheckedOut = Boolean(todayAttendance?.checkOutTime);

  const openModal = (modal: ActiveQuickModal) => {
    setMenuOpen(false);
    setActiveModal(modal);
  };

  const closeModal = () => {
    setActiveModal(null);
  };

  const handleSecondaryRoute = () => {
    setMenuOpen(false);
    if (isAdminOrMgr) {
      onNavigate('tasks');
    } else if (isStockMgr) {
      onNavigate('stock-movements');
    } else if (isDistributor) {
      onNavigate('my-orders');
    } else {
      onNavigate('my-sales');
    }
  };

  const attendanceSublabel = !isCheckedIn
    ? 'Start shift with GPS'
    : !isCheckedOut
    ? `Checked in at ${todayAttendance?.checkInTime}`
    : `Done (${todayAttendance?.checkInTime} – ${todayAttendance?.checkOutTime})`;

  return (
    <>
      {/* Backdrop when speed-dial menu is open */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/35 backdrop-blur-[1px] transition-opacity duration-150 no-print"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Floating Quick Action Speed Dial */}
      <div className="fixed right-4 bottom-[72px] md:bottom-6 md:right-6 z-40 flex flex-col items-end gap-2.5 no-print">
        {menuOpen && (
          <div
            role="menu"
            aria-label="Quick Actions"
            className="flex flex-col items-end gap-2 mb-1 animate-[fadeIn_140ms_ease-out]"
          >
            {!isDistributor && (
              <QuickMenuItem
                icon={CalendarCheck}
                title={
                  !isCheckedIn
                    ? 'Mark Check-In'
                    : !isCheckedOut
                    ? 'Mark Check-Out'
                    : 'Today Attendance'
                }
                subtitle={attendanceSublabel}
                accentClass="bg-[#15803D] text-white"
                onClick={() => openModal('attendance')}
              />
            )}

            {!isDistributor && !isStockMgr && (
              <QuickMenuItem
                icon={MapPin}
                title="Log New Visit"
                subtitle="Customer GPS or Doctor call"
                accentClass="bg-[#0F2744] text-white"
                onClick={() => openModal('visit')}
              />
            )}

            <QuickMenuItem
              icon={QrCode}
              title="Scan Product QR"
              subtitle="Camera scan, SKU lookup or label"
              accentClass="bg-slate-800 text-white"
              onClick={() => openModal('qr-scanner')}
            />

            <QuickMenuItem
              icon={isAdminOrMgr ? ClipboardList : ShoppingCart}
              title={
                isAdminOrMgr
                  ? 'Assign Field Task'
                  : isStockMgr
                  ? 'Record Stock Move'
                  : isDistributor
                  ? 'Place Stock Order'
                  : 'New Sale / Order'
              }
              subtitle={
                isAdminOrMgr
                  ? 'Open task scheduler'
                  : isStockMgr
                  ? 'Open stock movement ledger'
                  : 'Create commercial order'
              }
              accentClass="bg-slate-700 text-white"
              onClick={handleSecondaryRoute}
            />
          </div>
        )}

        <button
          type="button"
          onClick={() => setMenuOpen((prev) => !prev)}
          aria-expanded={menuOpen}
          aria-label={menuOpen ? 'Close Quick Actions' : 'Open Quick Actions'}
          className={`h-12 px-4 rounded-2xl shadow-lg flex items-center gap-2 text-xs font-semibold tracking-tight transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#0F2744] active:scale-[0.97] whitespace-nowrap shrink-0 ${
            menuOpen
              ? 'bg-slate-900 text-white'
              : 'bg-[#16A34A] hover:bg-[#15803D] text-white'
          }`}
        >
          {menuOpen ? (
            <>
              <X className="w-4 h-4 shrink-0" />
              <span>Close</span>
            </>
          ) : (
            <>
              <Zap className="w-4 h-4 shrink-0" />
              <span>Quick Action</span>
            </>
          )}
        </button>
      </div>

      {/* Modal 1: Quick Attendance */}
      {activeModal === 'attendance' && (
        <QuickAttendanceModal
          currentUser={currentUser}
          todayRecord={todayAttendance}
          settings={settings}
          onClose={closeModal}
          onOpenFullModule={() => {
            closeModal();
            onNavigate(isAdminOrMgr ? 'attendance' : 'my-attendance');
          }}
          onShiftCheckIn={onShiftCheckIn}
          onShiftCheckOut={onShiftCheckOut}
        />
      )}

      {/* Modal 2: Quick Visit / Doctor Call */}
      {activeModal === 'visit' && (
        <QuickVisitModal
          currentUser={currentUser}
          customers={customers}
          doctors={doctors}
          products={products}
          employees={employees}
          settings={settings}
          onClose={closeModal}
          onOpenModule={(tab) => {
            closeModal();
            onNavigate(tab);
          }}
        />
      )}

      {/* Modal 3: Product QR Scanner & Batch Lookup */}
      {activeModal === 'qr-scanner' && (
        <ProductQrScannerModal
          currentUser={currentUser}
          isStockAuthorized={isStockAuthorized}
          products={products}
          allocations={allocations}
          onClose={closeModal}
          onNavigateToProduct={(tab) => {
            closeModal();
            onNavigate(tab);
          }}
        />
      )}
    </>
  );
};

const QuickMenuItem: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  accentClass: string;
  onClick: () => void;
}> = ({ icon: Icon, title, subtitle, accentClass, onClick }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    className="group flex items-center gap-3 bg-white hover:bg-slate-50 border border-slate-200 rounded-2xl pl-4 pr-2.5 py-2 shadow-lg min-h-[48px] transition-transform duration-150 active:scale-[0.98]"
  >
    <div className="text-right min-w-0">
      <div className="text-xs font-semibold text-slate-900 whitespace-nowrap">
        {title}
      </div>
      <div className="text-[11px] text-slate-500 whitespace-nowrap">
        {subtitle}
      </div>
    </div>
    <div
      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${accentClass}`}
    >
      <Icon className="w-4 h-4" />
    </div>
  </button>
);

// ============================================================================
// Modal 1: Quick Attendance Check-In / Check-Out
// ============================================================================

const QuickAttendanceModal: React.FC<{
  currentUser: UserAccount;
  todayRecord?: AttendanceRecord;
  settings: CompanySettings | null;
  onClose: () => void;
  onOpenFullModule: () => void;
  onShiftCheckIn?: (pos: GeolocationPosition, workMode: 'Field' | 'Office') => Promise<void> | void;
  onShiftCheckOut?: (pos: GeolocationPosition) => Promise<void> | void;
}> = ({
  currentUser,
  todayRecord,
  settings,
  onClose,
  onOpenFullModule,
  onShiftCheckIn,
  onShiftCheckOut,
}) => {
  const today = todayIsoDate();
  const [workMode, setWorkMode] = useState<'Field' | 'Office'>('Field');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const getPosition = (): Promise<GeolocationPosition> =>
    new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('Device geolocation is not supported on this browser.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12000,
      });
    });

  const handleCheckIn = async () => {
    setErr('');
    setMsg('');
    setBusy(true);
    try {
      const pos = await getPosition();
      const nowStr = new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const officeLat = settings?.officeLat ?? 19.076;
      const officeLng = settings?.officeLng ?? 72.8777;
      const radius = settings?.officeRadiusM ?? 500;
      const dist = calculateHaversineMeters(
        pos.coords.latitude,
        pos.coords.longitude,
        officeLat,
        officeLng
      );
      const locationLabel =
        workMode === 'Office'
          ? dist <= radius
            ? `Office Verified (${dist}m from HQ)`
            : `Off-site Check-In (${dist}m from HQ)`
          : `Field GPS (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)})`;

      const startHour = Number((settings?.workStartTime || '09:30').split(':')[0]) || 9;
      const startMin = Number((settings?.workStartTime || '09:30').split(':')[1]) || 30;
      const now = new Date();
      const isLate =
        now.getHours() > startHour ||
        (now.getHours() === startHour && now.getMinutes() > startMin + 15);

      const attId = `att_${currentUser.uid}_${today}`.slice(0, 120);
      await setDoc(doc(db, 'attendance', attId), {
        id: attId,
        userId: currentUser.uid,
        employeeId: currentUser.employeeId || `emp_${currentUser.uid}`,
        employeeName: currentUser.displayName,
        department: currentUser.department || 'Field Sales',
        date: today,
        workMode,
        status: isLate ? 'Late' : 'Present',
        checkInTime: nowStr,
        checkInLat: pos.coords.latitude,
        checkInLng: pos.coords.longitude,
        checkInAccuracy: Math.round(pos.coords.accuracy || 0),
        locationLabel,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (onShiftCheckIn) {
        await onShiftCheckIn(pos, workMode);
      } else {
        const locId = generateId('loc');
        await setDoc(doc(db, 'locations', locId), {
          id: locId,
          userId: currentUser.uid,
          employeeName: currentUser.displayName,
          territory: currentUser.territory || 'Assigned',
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy || 0),
          trackingActive: true,
          status: 'On Duty',
          withinGeofence: dist <= radius,
          note: `${workMode} Attendance Check-In`,
          recordedAt: serverTimestamp(),
        });
      }

      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: 'Attendance Check-In',
        entityType: 'attendance',
        entityId: attId,
        details: `${workMode} check-in at ${nowStr} · ${locationLabel}`,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      });

      setMsg(`Checked in (${workMode}) at ${nowStr}. Live GPS sharing is active.`);
    } catch (error: any) {
      if (error?.code === 1) {
        setErr('Location permission denied. Enable GPS access to mark attendance.');
      } else {
        setErr(error?.message || 'Unable to acquire GPS coordinates.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCheckOut = async () => {
    if (!todayRecord) return;
    setErr('');
    setMsg('');
    setBusy(true);
    try {
      const pos = await getPosition();
      const nowStr = new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const createdMs =
        typeof todayRecord.createdAt?.toMillis === 'function'
          ? todayRecord.createdAt.toMillis()
          : Date.now() - 60000;
      const workingMinutes = Math.max(1, Math.round((Date.now() - createdMs) / 60000));

      await updateDoc(doc(db, 'attendance', todayRecord.id), {
        checkOutTime: nowStr,
        checkOutLat: pos.coords.latitude,
        checkOutLng: pos.coords.longitude,
        workingMinutes,
        updatedAt: serverTimestamp(),
      });

      if (onShiftCheckOut) {
        await onShiftCheckOut(pos);
      } else {
        const locId = generateId('loc');
        await setDoc(doc(db, 'locations', locId), {
          id: locId,
          userId: currentUser.uid,
          employeeName: currentUser.displayName,
          territory: currentUser.territory || 'Assigned',
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy || 0),
          trackingActive: false,
          status: 'Checked Out',
          withinGeofence: false,
          note: `Checked Out at ${nowStr}`,
          recordedAt: serverTimestamp(),
        });
      }

      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: 'Attendance Check-Out',
        entityType: 'attendance',
        entityId: todayRecord.id,
        details: `Checked out at ${nowStr} (${formatMinutesAsHours(workingMinutes)})`,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      });

      setMsg(`Checked out at ${nowStr}. Total: ${formatMinutesAsHours(workingMinutes)}.`);
    } catch (error: any) {
      if (error?.code === 1) {
        setErr('Location permission denied. Enable GPS access to mark check-out.');
      } else {
        setErr(error?.message || 'Unable to acquire GPS coordinates.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-0 sm:p-4 no-print">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border border-slate-200 shadow-xl p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-50 text-[#15803D] flex items-center justify-center">
              <CalendarCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Quick Attendance</h3>
              <p className="text-[11px] text-slate-500 font-mono tabular-nums">
                {today} · {currentUser.displayName}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-500 hover:text-slate-900 rounded-lg"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Today&apos;s Status</span>
            <span className="font-semibold text-[#0F2744]">
              {todayRecord
                ? todayRecord.checkOutTime
                  ? 'Shift Completed'
                  : `${todayRecord.status} (${todayRecord.workMode})`
                : 'Not Checked In'}
            </span>
          </div>
          {todayRecord?.checkInTime && (
            <div className="flex items-center justify-between font-mono tabular-nums text-slate-600">
              <span>Check-In / Out</span>
              <span>
                {todayRecord.checkInTime}
                {todayRecord.checkOutTime ? ` → ${todayRecord.checkOutTime}` : ' → Active'}
              </span>
            </div>
          )}
          {todayRecord?.locationLabel && (
            <div className="text-[11px] text-slate-500 pt-0.5 truncate">
              {todayRecord.locationLabel}
            </div>
          )}
        </div>

        {!todayRecord && (
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Work Mode
            </label>
            <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-xl">
              {(['Field', 'Office'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setWorkMode(m)}
                  className={`py-2 text-xs font-semibold rounded-lg transition-colors min-h-[40px] ${
                    workMode === m
                      ? 'bg-white text-[#0F2744] shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {m === 'Field' ? 'Field Visit Mode' : 'Office / HQ Mode'}
                </button>
              ))}
            </div>
          </div>
        )}

        {err && (
          <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs">
            {err}
          </div>
        )}
        {msg && (
          <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{msg}</span>
          </div>
        )}

        <div className="flex flex-col gap-2 pt-1">
          {!todayRecord ? (
            <button
              type="button"
              disabled={busy}
              onClick={handleCheckIn}
              className="w-full py-3 px-4 text-xs font-semibold text-white bg-[#16A34A] hover:bg-[#15803D] rounded-xl min-h-[46px] flex items-center justify-center gap-2 disabled:opacity-60"
            >
              <MapPin className="w-4 h-4" />
              {busy ? 'Acquiring GPS & Checking In...' : `GPS Check-In (${workMode})`}
            </button>
          ) : !todayRecord.checkOutTime ? (
            <button
              type="button"
              disabled={busy}
              onClick={handleCheckOut}
              className="w-full py-3 px-4 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-xl min-h-[46px] flex items-center justify-center gap-2 disabled:opacity-60"
            >
              <MapPin className="w-4 h-4" />
              {busy ? 'Acquiring GPS & Checking Out...' : 'Mark GPS Check-Out Now'}
            </button>
          ) : null}

          <button
            type="button"
            onClick={onOpenFullModule}
            className="w-full py-2.5 text-xs font-medium text-[#0F2744] hover:bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-center gap-1.5 min-h-[42px]"
          >
            <span>Open Attendance &amp; Leave Register</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Modal 2: Quick Visit Logger (Customer GPS Visit + Doctor Detailing Call)
// ============================================================================

const QuickVisitModal: React.FC<{
  currentUser: UserAccount;
  customers: Customer[];
  doctors: Doctor[];
  products: Product[];
  employees: Employee[];
  settings: CompanySettings | null;
  onClose: () => void;
  onOpenModule: (tab: AppTab) => void;
}> = ({
  currentUser,
  customers,
  doctors,
  products,
  employees,
  settings,
  onClose,
  onOpenModule,
}) => {
  const today = todayIsoDate();
  const isAdminOrMgr = isManagementRole(currentUser.role);
  const [visitType, setVisitType] = useState<'customer' | 'doctor'>('customer');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Customer visit state
  const [customerId, setCustomerId] = useState('');
  const [visitNote, setVisitNote] = useState('');

  // Doctor call state
  const [doctorId, setDoctorId] = useState('');
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [callOutcome, setCallOutcome] = useState<DoctorCallOutcome>('Interested');
  const [doctorRemark, setDoctorRemark] = useState('');
  const [samplesGiven, setSamplesGiven] = useState('');
  const [nextFollowUpDate, setNextFollowUpDate] = useState('');
  const [callGps, setCallGps] = useState<CapturedGpsPoint | null>(null);
  const [callLocationName, setCallLocationName] = useState('');
  const [gpsCapturing, setGpsCapturing] = useState(false);
  const [gpsStatus, setGpsStatus] = useState('');

  const myEmployee = employees.find(
    (e) =>
      e.uid === currentUser.uid ||
      e.email.toLowerCase() === currentUser.email.toLowerCase()
  );

  const uniqueProductNames = useMemo(
    () => Array.from(new Set(products.map((p) => p.name))).sort(),
    [products]
  );

  const captureDoctorCallLocation = useCallback(async (fallbackPlace = '') => {
    setGpsCapturing(true);
    setGpsStatus('Capturing current GPS location...');
    try {
      const pt = await captureCurrentGps(10000);
      setCallGps(pt);
      const place = await reverseGeocodeCoords(pt.lat, pt.lng);
      if (place) {
        setCallLocationName((prev) =>
          !prev.trim() || prev.trim() === fallbackPlace ? place : prev
        );
        setGpsStatus(
          `GPS ready: ${place} (${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)} ±${pt.accuracy}m)`
        );
      } else {
        setGpsStatus(
          `GPS ready: ${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)} (±${pt.accuracy}m)`
        );
      }
    } catch (geoErr: any) {
      setGpsStatus(geoErr?.message || 'Unable to acquire GPS.');
    } finally {
      setGpsCapturing(false);
    }
  }, []);

  useEffect(() => {
    if (visitType === 'doctor' && !callGps) {
      void captureDoctorCallLocation();
    }
  }, [visitType, callGps, captureDoctorCallLocation]);

  const handleLogCustomerVisit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');

    if (!('geolocation' in navigator)) {
      setErr('Device geolocation is unavailable on this browser.');
      return;
    }

    setSaving(true);
    const selectedCust = customers.find((c) => c.id === customerId);
    const geofenceLat = myEmployee?.geofenceLat ?? settings?.officeLat ?? 19.076;
    const geofenceLng = myEmployee?.geofenceLng ?? settings?.officeLng ?? 72.8777;
    const geofenceRadius = myEmployee?.geofenceRadiusM ?? settings?.officeRadiusM ?? 500;

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const locId = generateId('loc');
        const dist = calculateHaversineMeters(
          pos.coords.latitude,
          pos.coords.longitude,
          geofenceLat,
          geofenceLng
        );
        const noteText =
          visitNote.trim() ||
          (selectedCust ? `Visited ${selectedCust.businessName}` : 'Field customer visit');

        try {
          await setDoc(doc(db, 'locations', locId), {
            id: locId,
            userId: currentUser.uid,
            employeeName: currentUser.displayName,
            territory: currentUser.territory || myEmployee?.territory || 'Field Zone',
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy || 0),
            trackingActive: true,
            status: 'Customer Visit',
            ...(selectedCust
              ? { customerId: selectedCust.id, customerName: selectedCust.businessName }
              : {}),
            withinGeofence: dist <= geofenceRadius,
            note: noteText.slice(0, 240),
            recordedAt: serverTimestamp(),
          });

          await logActivity({
            userId: currentUser.uid,
            employeeName: currentUser.displayName,
            action: 'Customer Visit',
            entityType: selectedCust ? 'customer' : 'location',
            entityId: selectedCust?.id || locId,
            details: selectedCust
              ? `GPS visit logged at ${selectedCust.businessName} (±${Math.round(
                  pos.coords.accuracy || 0
                )}m)`
              : `Field visit logged (±${Math.round(pos.coords.accuracy || 0)}m): ${noteText}`,
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          });

          setVisitNote('');
          setCustomerId('');
          setMsg(
            selectedCust
              ? `GPS visit logged for ${selectedCust.businessName}.`
              : 'Field visit logged with GPS coordinates.'
          );
        } catch (error) {
          handleFirestoreError(error, OperationType.CREATE, `locations/${locId}`);
        } finally {
          setSaving(false);
        }
      },
      (geoErr) => {
        setSaving(false);
        setErr(
          geoErr.code === geoErr.PERMISSION_DENIED
            ? 'Location permission denied. Enable GPS access to log a verified visit.'
            : 'Unable to acquire GPS signal for visit check-in.'
        );
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  };

  const handleLogDoctorCall = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');

    const docItem = doctors.find((d) => d.id === doctorId);
    if (!docItem) {
      setErr('Select a doctor from your directory.');
      return;
    }
    if (selectedProducts.length === 0) {
      setErr('Select at least one product shown during the call.');
      return;
    }
    if (!doctorRemark.trim()) {
      setErr('Enter the doctor remark / feedback.');
      return;
    }

    setSaving(true);
    const callId = generateId('dcall');
    const cleanProducts = selectedProducts.slice(0, 20).map((p) => p.slice(0, 120));
    const cleanRemark = doctorRemark.trim().slice(0, 600);
    const summaryProducts = cleanProducts.join(', ').slice(0, 300);

    let finalGps = callGps;
    let finalPlace = callLocationName.trim();
    if (!finalGps) {
      try {
        finalGps = await captureCurrentGps(5000);
        if (finalGps && !finalPlace) {
          finalPlace = await reverseGeocodeCoords(finalGps.lat, finalGps.lng);
        }
      } catch {
        // Proceed with clinic/area fallback if GPS unavailable
      }
    } else if (!finalPlace) {
      finalPlace = await reverseGeocodeCoords(finalGps.lat, finalGps.lng);
    }
    if (!finalPlace) {
      finalPlace = [docItem.areaBeat, docItem.city].filter(Boolean).join(', ');
    }
    const cleanLocationName = finalPlace.slice(0, 200);

    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'doctorCalls', callId), {
        id: callId,
        doctorId: docItem.id,
        doctorName: docItem.name.slice(0, 120),
        clinicName: docItem.clinicName.slice(0, 160),
        specialty: docItem.specialty.slice(0, 80),
        ...(docItem.areaBeat ? { areaBeat: docItem.areaBeat.slice(0, 120) } : {}),
        employeeUid: currentUser.uid,
        employeeName: currentUser.displayName.slice(0, 120),
        callDate: today,
        productsShown: cleanProducts,
        ...(samplesGiven.trim() ? { samplesGiven: samplesGiven.trim().slice(0, 240) } : {}),
        callOutcome,
        doctorRemark: cleanRemark,
        ...(nextFollowUpDate ? { nextFollowUpDate } : {}),
        ...(finalGps
          ? {
              lat: finalGps.lat,
              lng: finalGps.lng,
              accuracy: finalGps.accuracy,
            }
          : {}),
        ...(cleanLocationName ? { locationName: cleanLocationName } : {}),
        isDemo: false,
        createdAt: serverTimestamp(),
      });

      batch.update(doc(db, 'doctors', docItem.id), {
        totalCalls: (docItem.totalCalls || 0) + 1,
        lastVisitedDate: today,
        lastCallOutcome: callOutcome,
        lastDoctorRemark: cleanRemark,
        lastProductsShown: summaryProducts,
        ...(finalGps ? { lastCallLat: finalGps.lat, lastCallLng: finalGps.lng } : {}),
        ...(cleanLocationName ? { lastCallLocation: cleanLocationName } : {}),
        updatedAt: serverTimestamp(),
      });

      if (finalGps) {
        const locId = generateId('loc');
        const geofenceLat = myEmployee?.geofenceLat ?? settings?.officeLat ?? 19.076;
        const geofenceLng = myEmployee?.geofenceLng ?? settings?.officeLng ?? 72.8777;
        const geofenceRadius =
          myEmployee?.geofenceRadiusM ?? settings?.officeRadiusM ?? 500;
        const dist = calculateHaversineMeters(
          finalGps.lat,
          finalGps.lng,
          geofenceLat,
          geofenceLng
        );
        batch.set(doc(db, 'locations', locId), {
          id: locId,
          userId: currentUser.uid,
          employeeName: currentUser.displayName.slice(0, 120),
          territory: (
            cleanLocationName ||
            currentUser.territory ||
            myEmployee?.territory ||
            docItem.city
          ).slice(0, 120),
          lat: finalGps.lat,
          lng: finalGps.lng,
          accuracy: finalGps.accuracy,
          trackingActive: false,
          status: 'Customer Visit',
          customerId: docItem.id,
          customerName: `${docItem.name} (${docItem.clinicName})`.slice(0, 140),
          withinGeofence: dist <= geofenceRadius,
          note: `Doctor Call at ${cleanLocationName || docItem.clinicName}`.slice(0, 240),
          recordedAt: serverTimestamp(),
        });
      }

      await batch.commit();

      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: 'Doctor Call',
        entityType: 'doctorCalls',
        entityId: callId,
        details: `Met ${docItem.name}${
          cleanLocationName ? ` @ ${cleanLocationName}` : ''
        } · Shown: ${summaryProducts} · Remark: ${cleanRemark.slice(0, 100)}`,
        lat: finalGps?.lat,
        lng: finalGps?.lng,
      });

      setDoctorId('');
      setSelectedProducts([]);
      setDoctorRemark('');
      setSamplesGiven('');
      setNextFollowUpDate('');
      setMsg(
        `Doctor detailing call saved for ${docItem.name}${
          cleanLocationName ? ` (${cleanLocationName})` : ''
        }.`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `doctorCalls/${callId}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-0 sm:p-4 no-print">
      <div className="bg-white w-full sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-t-3xl sm:rounded-2xl border border-slate-200 shadow-xl p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#0F2744]/10 text-[#0F2744] flex items-center justify-center">
              {visitType === 'customer' ? (
                <MapPin className="w-5 h-5" />
              ) : (
                <Stethoscope className="w-5 h-5" />
              )}
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Log New Field Visit</h3>
              <p className="text-[11px] text-slate-500">
                Customer GPS check-in or Doctor product detailing call
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-500 hover:text-slate-900 rounded-lg"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-xl">
          <button
            type="button"
            onClick={() => {
              setVisitType('customer');
              setErr('');
              setMsg('');
            }}
            className={`py-2 text-xs font-semibold rounded-lg transition-colors min-h-[40px] ${
              visitType === 'customer'
                ? 'bg-white text-[#0F2744] shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Pharmacy / Customer GPS
          </button>
          <button
            type="button"
            onClick={() => {
              setVisitType('doctor');
              setErr('');
              setMsg('');
            }}
            className={`py-2 text-xs font-semibold rounded-lg transition-colors min-h-[40px] ${
              visitType === 'doctor'
                ? 'bg-white text-[#0F2744] shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Doctor Detailing Call
          </button>
        </div>

        {err && (
          <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs">
            {err}
          </div>
        )}
        {msg && (
          <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{msg}</span>
          </div>
        )}

        {visitType === 'customer' ? (
          <form onSubmit={handleLogCustomerVisit} className="space-y-3.5">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Assigned Customer / Pharmacy
              </label>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-xl bg-white"
              >
                <option value="">General Territory Field Visit</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.businessName} ({c.city})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Visit Summary / Notes
              </label>
              <textarea
                rows={3}
                value={visitNote}
                onChange={(e) => setVisitNote(e.target.value)}
                placeholder="Order discussion, stock check, payment follow-up..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
              />
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full py-3 px-4 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-xl min-h-[46px] flex items-center justify-center gap-2 disabled:opacity-60"
            >
              <MapPin className="w-4 h-4" />
              {saving ? 'Capturing GPS...' : 'Capture GPS & Log Visit'}
            </button>

            <button
              type="button"
              onClick={() => onOpenModule(isAdminOrMgr ? 'live-location' : 'my-visits')}
              className="w-full py-2.5 text-xs font-medium text-[#0F2744] hover:bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-center gap-1.5"
            >
              <span>Open Live GPS &amp; Visit History</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </form>
        ) : (
          <form onSubmit={handleLogDoctorCall} className="space-y-3.5">
            {doctors.length === 0 ? (
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600 space-y-2">
                <p>No doctors in your directory yet. Add doctors first to log detailing calls.</p>
                <button
                  type="button"
                  onClick={() => onOpenModule(isAdminOrMgr ? 'doctors' : 'my-doctors')}
                  className="px-3.5 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
                >
                  Open Doctors &amp; Calls
                </button>
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Select Doctor
                  </label>
                  <select
                    required
                    value={doctorId}
                    onChange={(e) => setDoctorId(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-xl bg-white"
                  >
                    <option value="">Choose doctor...</option>
                    {doctors.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} · {d.specialty} ({d.clinicName})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Products Detailed ({selectedProducts.length} selected)
                  </label>
                  {uniqueProductNames.length === 0 ? (
                    <p className="text-xs text-slate-500">No products in catalog yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto p-2 bg-slate-50 border border-slate-200 rounded-xl">
                      {uniqueProductNames.map((pName) => {
                        const active = selectedProducts.includes(pName);
                        return (
                          <button
                            key={pName}
                            type="button"
                            onClick={() =>
                              setSelectedProducts((prev) =>
                                prev.includes(pName)
                                  ? prev.filter((x) => x !== pName)
                                  : [...prev, pName]
                              )
                            }
                            className={`px-2.5 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                              active
                                ? 'bg-[#0F2744] text-white border-[#0F2744]'
                                : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400'
                            }`}
                          >
                            {pName}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Call Outcome
                    </label>
                    <select
                      value={callOutcome}
                      onChange={(e) => setCallOutcome(e.target.value as DoctorCallOutcome)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl bg-white"
                    >
                      {DOCTOR_OUTCOMES.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Next Follow-up (Optional)
                    </label>
                    <input
                      type="date"
                      value={nextFollowUpDate}
                      onChange={(e) => setNextFollowUpDate(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-xl"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Doctor Remark / Feedback
                  </label>
                  <textarea
                    required
                    rows={2}
                    value={doctorRemark}
                    onChange={(e) => setDoctorRemark(e.target.value)}
                    placeholder="What did the doctor say about the product?"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Samples Given (Optional)
                  </label>
                  <input
                    type="text"
                    value={samplesGiven}
                    onChange={(e) => setSamplesGiven(e.target.value)}
                    placeholder="e.g. 2 strips Glaceclav 625"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl"
                  />
                </div>

                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                      {gpsCapturing ? (
                        <Loader2 className="w-3.5 h-3.5 text-[#15803D] animate-spin" />
                      ) : (
                        <MapPin
                          className={`w-3.5 h-3.5 ${
                            callGps ? 'text-[#15803D]' : 'text-amber-600'
                          }`}
                        />
                      )}
                      Call Location (Place &amp; GPS)
                    </span>
                    <button
                      type="button"
                      disabled={gpsCapturing}
                      onClick={() => {
                        const docItem = doctors.find((d) => d.id === doctorId);
                        const fallback = docItem
                          ? [docItem.areaBeat, docItem.city].filter(Boolean).join(', ')
                          : '';
                        void captureDoctorCallLocation(fallback);
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-60"
                    >
                      <RefreshCw
                        className={`w-3 h-3 ${gpsCapturing ? 'animate-spin' : ''}`}
                      />
                      {callGps ? 'Refresh GPS' : 'Capture GPS'}
                    </button>
                  </div>
                  <input
                    type="text"
                    value={callLocationName}
                    onChange={(e) => setCallLocationName(e.target.value)}
                    placeholder="Call area / landmark / city (auto-filled from GPS)"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                  />
                  <div className="text-[11px] text-slate-500">
                    {gpsStatus || 'GPS auto-captures where the call occurred.'}
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={saving}
                  className="w-full py-3 px-4 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-xl min-h-[46px] disabled:opacity-60"
                >
                  {saving ? 'Saving Doctor Call...' : 'Save Doctor Detailing Call'}
                </button>
              </>
            )}

            <button
              type="button"
              onClick={() => onOpenModule(isAdminOrMgr ? 'doctors' : 'my-doctors')}
              className="w-full py-2.5 text-xs font-medium text-[#0F2744] hover:bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-center gap-1.5"
            >
              <span>Open Full Doctors Directory</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Modal 3: Product QR Scanner, Batch Lookup & Printable Batch QR Labels
// ============================================================================

const ProductQrScannerModal: React.FC<{
  currentUser: UserAccount;
  isStockAuthorized: boolean;
  products: Product[];
  allocations: StockAllocation[];
  onClose: () => void;
  onNavigateToProduct: (tab: AppTab) => void;
}> = ({
  currentUser,
  isStockAuthorized,
  products,
  allocations,
  onClose,
  onNavigateToProduct,
}) => {
  const [tab, setTab] = useState<'scan' | 'generate'>('scan');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [manualInput, setManualInput] = useState('');
  const [lastScannedRaw, setLastScannedRaw] = useState('');
  const [matchedProduct, setMatchedProduct] = useState<Product | null>(null);
  const [lookupStatus, setLookupStatus] = useState('');

  // Quick stock adjustment from scanned product
  const [adjustType, setAdjustType] = useState<StockMovementType>('Stock In');
  const [adjustQty, setAdjustQty] = useState('10');
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [adjustMsg, setAdjustMsg] = useState('');
  const [adjustErr, setAdjustErr] = useState('');

  // QR label generator tab state
  const [labelProductId, setLabelProductId] = useState<string>(products[0]?.id || '');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopCamera = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  // Generate QR Data URL when product selected in Label Generator tab
  useEffect(() => {
    if (tab !== 'generate') return;
    const target = products.find((p) => p.id === labelProductId) || products[0];
    if (!target) {
      setQrDataUrl('');
      return;
    }
    const payload = JSON.stringify({
      app: 'glacetor',
      productId: target.id,
      sku: target.sku,
      batch: target.batchNumber,
    });
    QRCode.toDataURL(payload, {
      width: 240,
      margin: 2,
      color: { dark: '#0F2744', light: '#FFFFFF' },
    })
      .then((url) => setQrDataUrl(url))
      .catch(() => setQrDataUrl(''));
  }, [tab, labelProductId, products]);

  const handleDecodedValue = useCallback(
    (rawValue: string) => {
      const clean = rawValue.trim();
      if (!clean) return;

      setLastScannedRaw(clean);
      setManualInput(clean);
      setAdjustMsg('');
      setAdjustErr('');

      const { product } = parseQrPayloadToProduct(clean, products);
      setMatchedProduct(product);

      if (product) {
        setLookupStatus(`Matched ${product.name} · Batch ${product.batchNumber}`);
        stopCamera();
        logActivity({
          userId: currentUser.uid,
          employeeName: currentUser.displayName,
          action: 'Product QR Scanned',
          entityType: 'product',
          entityId: product.id,
          details: `Scanned SKU ${product.sku} (Batch ${product.batchNumber})`,
        }).catch(() => {});
      } else {
        setLookupStatus(`No inventory batch matched "${clean}". Verify SKU or batch code.`);
      }
    },
    [products, stopCamera, currentUser.uid, currentUser.displayName]
  );

  const startCamera = async () => {
    setCameraError('');
    setLookupStatus('');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        'Live camera is not available in this browser context. Use "Scan Photo" or enter SKU/Batch manually below.'
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraActive(true);

      // Attach stream once video element mounts
      setTimeout(() => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});

        const BarcodeDetectorCtor = (window as any).BarcodeDetector;
        const detector =
          typeof BarcodeDetectorCtor === 'function'
            ? new BarcodeDetectorCtor({
                formats: ['qr_code', 'code_128', 'ean_13', 'ean_8', 'data_matrix'],
              })
            : null;

        let lastDetectorAt = 0;

        const scanFrame = async () => {
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (!video || !canvas || !streamRef.current) return;

          if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

              // 1. Fast pure-JS QR decode
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const decoded = jsQR(imgData.data, imgData.width, imgData.height, {
                inversionAttempts: 'dontInvert',
              });
              if (decoded?.data) {
                handleDecodedValue(decoded.data);
                return;
              }

              // 2. Native BarcodeDetector fallback (handles 1D barcodes & rotated QRs)
              const now = Date.now();
              if (detector && now - lastDetectorAt > 250) {
                lastDetectorAt = now;
                try {
                  const codes = await detector.detect(video);
                  if (codes && codes.length > 0 && codes[0].rawValue) {
                    handleDecodedValue(codes[0].rawValue);
                    return;
                  }
                } catch {
                  // ignore detector frame error
                }
              }
            }
          }
          rafRef.current = requestAnimationFrame(scanFrame);
        };

        rafRef.current = requestAnimationFrame(scanFrame);
      }, 60);
    } catch (err: any) {
      setCameraActive(false);
      if (err?.name === 'NotAllowedError') {
        setCameraError(
          'Camera permission denied. Allow camera access or use "Scan Photo" / Manual SKU lookup.'
        );
      } else {
        setCameraError(
          'Unable to open camera here (embedded preview or missing camera). Use "Scan Photo" or enter SKU/Batch manually.'
        );
      }
    }
  };

  const handleImageUploadScan = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCameraError('');
    setLookupStatus('Decoding QR code from image...');

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 1024;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code?.data) {
          handleDecodedValue(code.data);
        } else {
          setLookupStatus(
            'No readable QR code found in this photo. Ensure the QR label is sharp and well-lit.'
          );
        }
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualInput.trim()) return;
    handleDecodedValue(manualInput);
  };

  const handleQuickStockAdjust = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!matchedProduct || !isStockAuthorized) return;
    const qtyNum = Math.max(1, Number(adjustQty) || 0);
    setAdjustBusy(true);
    setAdjustMsg('');
    setAdjustErr('');
    try {
      await executeAtomicStockMovement({
        productId: matchedProduct.id,
        movementType: adjustType,
        quantity: qtyNum,
        reason: `QR Scan Quick ${adjustType} (${matchedProduct.sku})`,
        performedByUid: currentUser.uid,
        performedByName: currentUser.displayName,
        requireApproval: false,
      });
      setAdjustMsg(`${adjustType} of ${qtyNum} ${matchedProduct.unit} recorded.`);
    } catch (error: any) {
      setAdjustErr(error?.message || 'Unable to update stock.');
    } finally {
      setAdjustBusy(false);
    }
  };

  const selectedLabelProduct =
    products.find((p) => p.id === labelProductId) || products[0] || null;

  const liveMatchedProduct = matchedProduct
    ? products.find((p) => p.id === matchedProduct.id) || matchedProduct
    : null;

  const myAllocatedForMatched = liveMatchedProduct
    ? allocations.find(
        (a) => a.productId === liveMatchedProduct.id && a.holderUid === currentUser.uid
      )
    : undefined;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-0 sm:p-4 no-print">
      <div className="bg-white w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-2xl border border-slate-200 shadow-xl p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-slate-100 text-[#0F2744] flex items-center justify-center">
              <QrCode className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Product QR Scanner &amp; Batch Lookup
              </h3>
              <p className="text-[11px] text-slate-500">
                Inspect batch expiry, stock level, or print carton QR labels
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-500 hover:text-slate-900 rounded-lg"
            aria-label="Close scanner"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-xl">
          <button
            type="button"
            onClick={() => setTab('scan')}
            className={`py-2 text-xs font-semibold rounded-lg transition-colors min-h-[40px] ${
              tab === 'scan'
                ? 'bg-white text-[#0F2744] shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Scan / Lookup Batch
          </button>
          <button
            type="button"
            onClick={() => {
              stopCamera();
              setTab('generate');
            }}
            className={`py-2 text-xs font-semibold rounded-lg transition-colors min-h-[40px] ${
              tab === 'generate'
                ? 'bg-white text-[#0F2744] shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Batch QR Labels
          </button>
        </div>

        {tab === 'scan' ? (
          <div className="space-y-4">
            {/* Camera Viewfinder */}
            {cameraActive ? (
              <div className="relative rounded-2xl overflow-hidden bg-slate-950 border border-slate-200 aspect-[4/3]">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                <canvas ref={canvasRef} className="hidden" />
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                  <div className="w-44 h-44 border-2 border-emerald-400 rounded-2xl shadow-[0_0_0_9999px_rgba(15,23,42,0.45)]" />
                </div>
                <button
                  type="button"
                  onClick={stopCamera}
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 px-4 py-2 text-xs font-semibold bg-white text-slate-900 rounded-xl shadow-md"
                >
                  Stop Camera
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={startCamera}
                  className="py-3 px-3 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-xl flex items-center justify-center gap-2 min-h-[46px]"
                >
                  <Camera className="w-4 h-4 shrink-0" />
                  <span>Open Live Camera</span>
                </button>
                <label className="py-3 px-3 text-xs font-semibold text-[#0F2744] bg-slate-100 hover:bg-slate-200 rounded-xl flex items-center justify-center gap-2 min-h-[46px] cursor-pointer">
                  <FileImage className="w-4 h-4 shrink-0" />
                  <span>Scan Photo / File</span>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleImageUploadScan}
                    className="hidden"
                  />
                </label>
              </div>
            )}

            {cameraError && (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs">
                {cameraError}
              </div>
            )}

            {/* Manual SKU / Batch / QR Paste */}
            <form onSubmit={handleManualSubmit} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  placeholder="Enter SKU, Batch No., or paste QR code..."
                  className="w-full pl-9 pr-3 py-2.5 text-sm border border-slate-300 rounded-xl"
                />
              </div>
              <button
                type="submit"
                className="px-4 py-2.5 text-xs font-semibold text-white bg-[#16A34A] hover:bg-[#15803D] rounded-xl whitespace-nowrap shrink-0 min-h-[44px]"
              >
                Lookup
              </button>
            </form>

            {lookupStatus && !liveMatchedProduct && (
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700">
                {lookupStatus}
                {lastScannedRaw && (
                  <div className="mt-1 font-mono text-[11px] text-slate-500 break-all">
                    Raw payload: {lastScannedRaw}
                  </div>
                )}
              </div>
            )}

            {/* Matched Product Batch Details */}
            {liveMatchedProduct && (
              <div className="border border-slate-200 rounded-2xl p-4 space-y-3 bg-slate-50/70">
                <div className="flex items-start gap-3">
                  {liveMatchedProduct.imageUrl ? (
                    <img
                      src={liveMatchedProduct.imageUrl}
                      alt={liveMatchedProduct.name}
                      referrerPolicy="no-referrer"
                      className="w-14 h-14 rounded-xl object-cover border border-slate-200 shrink-0 bg-white"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-[#0F2744] shrink-0">
                      <Package className="w-6 h-6" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-slate-900 truncate">
                      {liveMatchedProduct.name}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 font-mono">
                      {liveMatchedProduct.sku} · Batch {liveMatchedProduct.batchNumber}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {liveMatchedProduct.category} · {liveMatchedProduct.unit}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-xs pt-1">
                  <div className="bg-white border border-slate-200 rounded-xl p-2.5">
                    <div className="text-[11px] text-slate-500">Depot Stock</div>
                    <div className="font-bold font-mono tabular-nums text-[#0F2744] mt-0.5">
                      {liveMatchedProduct.availableStock}
                    </div>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-2.5">
                    <div className="text-[11px] text-slate-500">Selling Rate</div>
                    <div className="font-bold font-mono tabular-nums text-[#15803D] mt-0.5">
                      {formatCurrency(liveMatchedProduct.sellingPrice)}
                    </div>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-2.5">
                    <div className="text-[11px] text-slate-500">Expiry</div>
                    <div
                      className={`font-bold font-mono tabular-nums mt-0.5 ${
                        daysUntilDate(liveMatchedProduct.expiryDate) <= 90
                          ? 'text-red-700'
                          : 'text-slate-900'
                      }`}
                    >
                      {liveMatchedProduct.expiryDate}
                    </div>
                  </div>
                </div>

                {daysUntilDate(liveMatchedProduct.expiryDate) <= 90 && (
                  <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>
                      Batch expires in {Math.max(0, daysUntilDate(liveMatchedProduct.expiryDate))} days.
                    </span>
                  </div>
                )}

                {myAllocatedForMatched && (
                  <div className="p-2.5 rounded-xl bg-white border border-slate-200 text-xs flex items-center justify-between">
                    <span className="text-slate-600">Your Allocated Stock</span>
                    <span className="font-bold font-mono tabular-nums text-[#15803D]">
                      {myAllocatedForMatched.remainingQty} remaining
                    </span>
                  </div>
                )}

                {/* Quick Stock Adjustment for Admin / Manager / Stock Manager */}
                {isStockAuthorized && (
                  <form
                    onSubmit={handleQuickStockAdjust}
                    className="pt-2 border-t border-slate-200 space-y-2"
                  >
                    <div className="text-[11px] font-semibold text-slate-700">
                      Quick Batch Movement
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <select
                        value={adjustType}
                        onChange={(e) => setAdjustType(e.target.value as StockMovementType)}
                        className="px-2.5 py-2 text-xs border border-slate-300 rounded-xl bg-white"
                      >
                        <option value="Stock In">Stock In (+)</option>
                        <option value="Stock Out">Stock Out (-)</option>
                        <option value="Damaged">Damaged (-)</option>
                      </select>
                      <input
                        type="number"
                        min={1}
                        value={adjustQty}
                        onChange={(e) => setAdjustQty(e.target.value)}
                        className="w-24 px-2.5 py-2 text-xs font-mono border border-slate-300 rounded-xl bg-white"
                      />
                      <button
                        type="submit"
                        disabled={adjustBusy}
                        className="flex-1 px-3 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-xl disabled:opacity-60"
                      >
                        {adjustBusy ? 'Saving...' : 'Update Stock'}
                      </button>
                    </div>
                    {adjustErr && (
                      <div className="text-xs text-red-700">{adjustErr}</div>
                    )}
                    {adjustMsg && (
                      <div className="text-xs text-[#15803D] font-medium">{adjustMsg}</div>
                    )}
                  </form>
                )}

                <button
                  type="button"
                  onClick={() =>
                    onNavigateToProduct(isStockAuthorized ? 'inventory' : 'my-stock')
                  }
                  className="w-full py-2.5 text-xs font-medium text-[#0F2744] bg-white hover:bg-slate-100 border border-slate-200 rounded-xl flex items-center justify-center gap-1.5"
                >
                  <span>{isStockAuthorized ? 'Open Inventory Ledger' : 'View My Stock'}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {products.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">
                No products available yet. Add products in Inventory to generate batch QR labels.
              </p>
            ) : (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Select Product Batch
                  </label>
                  <select
                    value={selectedLabelProduct?.id || ''}
                    onChange={(e) => setLabelProductId(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-xl bg-white"
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.sku} · Batch {p.batchNumber})
                      </option>
                    ))}
                  </select>
                </div>

                {selectedLabelProduct && qrDataUrl && (
                  <div className="border border-slate-200 rounded-2xl p-5 flex flex-col items-center text-center space-y-3 bg-slate-50">
                    <img
                      src={qrDataUrl}
                      alt={`QR Code for ${selectedLabelProduct.name}`}
                      className="w-48 h-48 rounded-xl border border-slate-200 bg-white p-2"
                    />
                    <div>
                      <div className="text-sm font-bold text-[#0F2744]">
                        {selectedLabelProduct.name}
                      </div>
                      <div className="text-xs text-slate-600 font-mono mt-0.5">
                        SKU: {selectedLabelProduct.sku} · Batch: {selectedLabelProduct.batchNumber}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono">
                        Exp: {selectedLabelProduct.expiryDate}
                      </div>
                    </div>
                    <div className="flex flex-wrap justify-center gap-2 pt-1">
                      <a
                        href={qrDataUrl}
                        download={`GLACETOR_${selectedLabelProduct.sku}_${selectedLabelProduct.batchNumber}.png`}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-xl"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download QR PNG
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          setTab('scan');
                          handleDecodedValue(selectedLabelProduct.sku);
                        }}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-[#15803D] bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-xl"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Inspect Batch
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
