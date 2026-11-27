import React, { useMemo, useState } from 'react';
import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import {
  Calendar,
  CheckCircle2,
  Clock,
  Edit3,
  MapPin,
  Plus,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  calculateHaversineMeters,
  formatMinutesAsHours,
  generateId,
  todayIsoDate,
} from '../lib/utils';
import { logActivity, pushNotification } from '../lib/erpActions';
import {
  AttendanceRecord,
  CompanySettings,
  Employee,
  LeaveRequest,
  UserAccount,
} from '../types/erp';

interface AttendanceModuleProps {
  currentUser: UserAccount;
  isAdminView: boolean;
  attendance: AttendanceRecord[];
  leaveRequests: LeaveRequest[];
  employees: Employee[];
  settings: CompanySettings | null;
  onShiftCheckIn?: (pos: GeolocationPosition, workMode: 'Field' | 'Office') => Promise<void> | void;
  onShiftCheckOut?: (pos: GeolocationPosition) => Promise<void> | void;
}

export const AttendanceModule: React.FC<AttendanceModuleProps> = ({
  currentUser,
  isAdminView,
  attendance,
  leaveRequests,
  employees,
  settings,
  onShiftCheckIn,
  onShiftCheckOut,
}) => {
  const today = todayIsoDate();
  const [workMode, setWorkMode] = useState<'Field' | 'Office'>('Field');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Admin filters
  const [empFilter, setEmpFilter] = useState('ALL');
  const [dateFilter, setDateFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');

  // Correction modal
  const [correcting, setCorrecting] = useState<AttendanceRecord | null>(null);
  const [corrStatus, setCorrStatus] = useState<AttendanceRecord['status']>('Present');
  const [corrReason, setCorrReason] = useState('');

  // Leave form
  const [showLeaveForm, setShowLeaveForm] = useState(false);
  const [leaveType, setLeaveType] = useState<LeaveRequest['leaveType']>('Casual');
  const [leaveStart, setLeaveStart] = useState(today);
  const [leaveEnd, setLeaveEnd] = useState(today);
  const [leaveReason, setLeaveReason] = useState('');

  const myTodayRecord = attendance.find(
    (a) => a.userId === currentUser.uid && a.date === today
  );

  const getPosition = (): Promise<GeolocationPosition> =>
    new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('Device geolocation is not available.'));
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

      const id = `att_${currentUser.uid}_${today}`.slice(0, 120);
      await setDoc(doc(db, 'attendance', id), {
        id,
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
        entityId: id,
        details: `${workMode} check-in at ${nowStr} · ${locationLabel}`,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      });

      setMsg(`Checked in (${workMode}) at ${nowStr}. Live duty GPS sharing is active.`);
    } catch (error: any) {
      if (error?.code === 1) {
        setErr('Location permission denied. Enable GPS access to submit attendance check-in.');
      } else {
        setErr(error?.message || 'Could not acquire GPS coordinates for check-in.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCheckOut = async () => {
    if (!myTodayRecord) return;
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
        typeof myTodayRecord.createdAt?.toMillis === 'function'
          ? myTodayRecord.createdAt.toMillis()
          : Date.now() - 60000;
      const workingMinutes = Math.max(1, Math.round((Date.now() - createdMs) / 60000));

      await updateDoc(doc(db, 'attendance', myTodayRecord.id), {
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
        entityId: myTodayRecord.id,
        details: `Checked out at ${nowStr} (${formatMinutesAsHours(workingMinutes)})`,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      });

      setMsg(`Checked out at ${nowStr}. Total logged: ${formatMinutesAsHours(workingMinutes)}.`);
    } catch (error: any) {
      setErr(error?.message || 'Unable to acquire GPS coordinates for check-out.');
    } finally {
      setBusy(false);
    }
  };

  const handleAdminCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!correcting || !corrReason.trim()) return;
    try {
      await updateDoc(doc(db, 'attendance', correcting.id), {
        status: corrStatus,
        correctedBy: currentUser.displayName,
        correctionReason: corrReason.trim(),
        updatedAt: serverTimestamp(),
      });
      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: 'Attendance Corrected',
        entityType: 'attendance',
        entityId: correcting.id,
        details: `Corrected ${correcting.employeeName} (${correcting.date}) to ${corrStatus}: ${corrReason.trim()}`,
      });
      setCorrecting(null);
      setCorrReason('');
      setMsg('Attendance updated and recorded in audit trail.');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `attendance/${correcting.id}`);
    }
  };

  const handleSubmitLeave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leaveReason.trim()) return;
    const id = generateId('lve');
    try {
      await setDoc(doc(db, 'leaveRequests', id), {
        id,
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        leaveType,
        startDate: leaveStart,
        endDate: leaveEnd,
        reason: leaveReason.trim(),
        status: 'Pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setShowLeaveForm(false);
      setLeaveReason('');
      setMsg('Leave request submitted for approval.');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `leaveRequests/${id}`);
    }
  };

  const handleLeaveDecision = async (
    lr: LeaveRequest,
    decision: 'Approved' | 'Rejected'
  ) => {
    try {
      await updateDoc(doc(db, 'leaveRequests', lr.id), {
        status: decision,
        reviewedBy: currentUser.displayName,
        reviewRemarks: `${decision} by ${currentUser.displayName}`,
        updatedAt: serverTimestamp(),
      });
      await pushNotification({
        recipientUid: lr.userId,
        title: `Leave Request ${decision}`,
        message: `Your ${lr.leaveType} leave (${lr.startDate} to ${lr.endDate}) was ${decision.toLowerCase()}.`,
        category: 'Leave',
        severity: decision === 'Approved' ? 'info' : 'warning',
      });
      setMsg(`Leave request ${decision.toLowerCase()}.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `leaveRequests/${lr.id}`);
    }
  };

  const departments = Array.from(
    new Set(attendance.map((a) => a.department).filter(Boolean) as string[])
  );

  const filtered = useMemo(() => {
    return attendance.filter((a) => {
      if (isAdminView && empFilter !== 'ALL' && a.userId !== empFilter) return false;
      if (dateFilter && a.date !== dateFilter) return false;
      if (deptFilter !== 'ALL' && a.department !== deptFilter) return false;
      return true;
    });
  }, [attendance, isAdminView, empFilter, dateFilter, deptFilter]);

  const currentMonthDays = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const count = new Date(y, m + 1, 0).getDate();
    return Array.from({ length: count }, (_, idx) => {
      const day = String(idx + 1).padStart(2, '0');
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-${day}`;
      const rec = filtered.find((a) => a.date === iso);
      return { day: idx + 1, iso, rec };
    });
  }, [filtered]);

  return (
    <div className="space-y-5">
      {/* GPS Check-In / Check-Out Action Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-slate-900">
            Daily GPS Attendance ({today})
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {myTodayRecord
              ? `Checked in at ${myTodayRecord.checkInTime} (${myTodayRecord.workMode}) · ${
                  myTodayRecord.checkOutTime
                    ? `Checked out at ${myTodayRecord.checkOutTime} (${formatMinutesAsHours(
                        myTodayRecord.workingMinutes
                      )})`
                    : 'Currently On Duty'
                }`
              : 'Select Office or Field mode and tap Check-In to record GPS-verified attendance.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {!myTodayRecord && (
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(['Field', 'Office'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setWorkMode(m)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                    workMode === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          {!myTodayRecord ? (
            <button
              type="button"
              disabled={busy}
              onClick={handleCheckIn}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[44px] disabled:opacity-60"
            >
              <MapPin className="w-4 h-4" />
              {busy ? 'Acquiring GPS...' : 'GPS Check-In'}
            </button>
          ) : !myTodayRecord.checkOutTime ? (
            <button
              type="button"
              disabled={busy}
              onClick={handleCheckOut}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg min-h-[44px] disabled:opacity-60"
            >
              <Clock className="w-4 h-4" />
              {busy ? 'Acquiring GPS...' : 'GPS Check-Out'}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#15803D]">
              <CheckCircle2 className="w-4 h-4" /> Shift Completed
            </span>
          )}

          <button
            type="button"
            onClick={() => setShowLeaveForm((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium text-[#0F2744] border border-slate-200 hover:bg-slate-50 rounded-lg min-h-[44px]"
          >
            <Plus className="w-4 h-4" />
            Request Leave
          </button>
        </div>
      </div>

      {msg && (
        <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs">
          {msg}
        </div>
      )}
      {err && (
        <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs">
          {err}
        </div>
      )}

      {showLeaveForm && (
        <form
          onSubmit={handleSubmitLeave}
          className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-900">Submit Leave Request</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Leave Type
              </label>
              <select
                value={leaveType}
                onChange={(e) => setLeaveType(e.target.value as LeaveRequest['leaveType'])}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="Casual">Casual Leave</option>
                <option value="Sick">Sick Leave</option>
                <option value="Earned">Earned Leave</option>
                <option value="Field Off">Field Off</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Start Date
              </label>
              <input
                type="date"
                required
                value={leaveStart}
                onChange={(e) => setLeaveStart(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                End Date
              </label>
              <input
                type="date"
                required
                value={leaveEnd}
                onChange={(e) => setLeaveEnd(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Reason
            </label>
            <textarea
              rows={2}
              required
              value={leaveReason}
              onChange={(e) => setLeaveReason(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowLeaveForm(false)}
              className="px-4 py-2 text-xs text-slate-600 hover:bg-slate-100 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
            >
              Submit Request
            </button>
          </div>
        </form>
      )}

      {/* Filters & View Switch */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {isAdminView && (
            <select
              value={empFilter}
              onChange={(e) => setEmpFilter(e.target.value)}
              className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
            >
              <option value="ALL">All Employees</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.uid || emp.id}>
                  {emp.fullName}
                </option>
              ))}
            </select>
          )}
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
          />
          {departments.length > 0 && (
            <select
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
              className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
            >
              <option value="ALL">All Departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
          <button
            type="button"
            onClick={() => setViewMode('list')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${
              viewMode === 'list' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Register Table
          </button>
          <button
            type="button"
            onClick={() => setViewMode('calendar')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md inline-flex items-center gap-1 ${
              viewMode === 'calendar' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            <Calendar className="w-3.5 h-3.5" /> Monthly Calendar
          </button>
        </div>
      </div>

      {viewMode === 'calendar' ? (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">
            Current Month Attendance Calendar
          </h3>
          <div className="grid grid-cols-7 gap-2 text-xs">
            {currentMonthDays.map((d) => (
              <div
                key={d.iso}
                className={`p-2.5 rounded-lg border ${
                  d.rec?.status === 'Present'
                    ? 'bg-emerald-50 border-emerald-200'
                    : d.rec?.status === 'Late'
                    ? 'bg-amber-50 border-amber-200'
                    : d.rec?.status === 'Absent'
                    ? 'bg-red-50 border-red-200'
                    : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div className="font-mono font-semibold text-slate-800">{d.day}</div>
                <div className="text-[11px] text-slate-600 truncate mt-1">
                  {d.rec ? d.rec.status : '—'}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              No attendance records found.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Date</th>
                    <th className="px-4 py-3 font-semibold">Employee</th>
                    <th className="px-4 py-3 font-semibold">Mode & Location</th>
                    <th className="px-4 py-3 font-semibold">Check In / Out</th>
                    <th className="px-4 py-3 font-semibold">Hours</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    {isAdminView && <th className="px-4 py-3 font-semibold text-right">Audit</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((a) => (
                    <tr key={a.id} className="hover:bg-slate-50/70">
                      <td className="px-4 py-3 font-mono">{a.date}</td>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-900">{a.employeeName}</div>
                        <div className="text-slate-500">{a.department || 'General'}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{a.workMode}</div>
                        <div className="text-slate-500 truncate max-w-[220px]">
                          {a.locationLabel || '—'}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums">
                        {a.checkInTime || '—'} / {a.checkOutTime || '—'}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums">
                        {formatMinutesAsHours(a.workingMinutes)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`font-semibold ${
                            a.status === 'Present'
                              ? 'text-[#15803D]'
                              : a.status === 'Late' || a.status === 'Half-day'
                              ? 'text-amber-700'
                              : 'text-red-700'
                          }`}
                        >
                          {a.status}
                        </span>
                        {a.correctionReason && (
                          <div className="text-[11px] text-slate-400">
                            Corrected: {a.correctionReason}
                          </div>
                        )}
                      </td>
                      {isAdminView && (
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => {
                              setCorrecting(a);
                              setCorrStatus(a.status);
                              setCorrReason('');
                            }}
                            className="p-1.5 text-slate-600 hover:text-[#0F2744]"
                            title="Correct Attendance"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Leave Requests Table */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-slate-900 mb-3">
          Leave Requests ({leaveRequests.length})
        </h3>
        {leaveRequests.length === 0 ? (
          <p className="text-xs text-slate-500">No leave requests submitted.</p>
        ) : (
          <div className="space-y-2.5">
            {leaveRequests.map((lr) => (
              <div
                key={lr.id}
                className="p-3.5 rounded-lg border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
              >
                <div>
                  <div className="font-semibold text-slate-900">
                    {lr.employeeName} · {lr.leaveType} Leave ({lr.startDate} to {lr.endDate})
                  </div>
                  <div className="text-slate-500 mt-0.5">{lr.reason}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`font-semibold ${
                      lr.status === 'Approved'
                        ? 'text-[#15803D]'
                        : lr.status === 'Rejected'
                        ? 'text-red-700'
                        : 'text-amber-700'
                    }`}
                  >
                    {lr.status}
                  </span>
                  {isAdminView && lr.status === 'Pending' && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleLeaveDecision(lr, 'Approved')}
                        className="px-2.5 py-1.5 bg-[#15803D] text-white rounded font-medium"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => handleLeaveDecision(lr, 'Rejected')}
                        className="px-2.5 py-1.5 bg-red-700 text-white rounded font-medium"
                      >
                        Reject
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Admin Attendance Correction Modal */}
      {correcting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-slate-900">
                Correct Attendance Record
              </h3>
              <button
                type="button"
                onClick={() => setCorrecting(null)}
                className="p-1 text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              {correcting.employeeName} · {correcting.date}
            </p>
            <form onSubmit={handleAdminCorrection} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Updated Status
                </label>
                <select
                  value={corrStatus}
                  onChange={(e) => setCorrStatus(e.target.value as AttendanceRecord['status'])}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="Present">Present</option>
                  <option value="Late">Late</option>
                  <option value="Half-day">Half-day</option>
                  <option value="Absent">Absent</option>
                  <option value="Leave">Leave</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Mandatory Audit Reason
                </label>
                <textarea
                  rows={2}
                  required
                  value={corrReason}
                  onChange={(e) => setCorrReason(e.target.value)}
                  placeholder="Explain reason for attendance correction..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCorrecting(null)}
                  className="px-4 py-2 text-xs text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
                >
                  Save & Log Audit
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
