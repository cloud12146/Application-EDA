import React, { useEffect, useMemo, useState } from 'react';
import {
  deleteDoc,
  doc,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import {
  Calendar,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  FileSpreadsheet,
  MapPin,
  Printer,
  Route,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  Customer,
  Employee,
  TourApprovalStatus,
  TourPlanEntry,
  TourWorkType,
  UserAccount,
} from '../types/erp';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { currentMonthKey, exportToCsv, todayIsoDate } from '../lib/utils';
import { logActivity, pushNotification } from '../lib/erpActions';
import { getRoleDisplayLabel } from '../lib/roles';
import { RouteOptimizerModal } from '../components/RouteOptimizerModal';

interface TourPlanModuleProps {
  currentUser: UserAccount;
  isAdminView: boolean;
  tourPlans: TourPlanEntry[];
  employees: Employee[];
  customers: Customer[];
}

const WORK_TYPES: TourWorkType[] = [
  'Field Visit',
  'Outstation',
  'HQ / Office',
  'Stockist Meet',
  'CME / Camp',
  'Transit',
  'Leave / Holiday',
];

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface DraftRow {
  date: string;
  workType: TourWorkType;
  placesToVisit: string;
  routeZone: string;
  headquarters: string;
  plannedCustomers: string;
  objective: string;
  overnightStay: boolean;
  approvalStatus: TourApprovalStatus;
  adminRemarks: string;
  dirty?: boolean;
}

function getMonthDays(monthKey: string): string[] {
  const [yStr, mStr] = monthKey.split('-');
  const year = Number(yStr) || new Date().getFullYear();
  const month = Number(mStr) || new Date().getMonth() + 1;
  const totalDays = new Date(year, month, 0).getDate();
  const days: string[] = [];
  for (let d = 1; d <= totalDays; d++) {
    days.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return days;
}

function getMondayFirstOffset(monthKey: string): number {
  const [yStr, mStr] = monthKey.split('-');
  const year = Number(yStr) || new Date().getFullYear();
  const month = Number(mStr) || new Date().getMonth() + 1;
  const jsDay = new Date(year, month - 1, 1).getDay(); // 0=Sun..6=Sat
  return jsDay === 0 ? 6 : jsDay - 1;
}

function formatMonthHeading(monthKey: string): string {
  const [yStr, mStr] = monthKey.split('-');
  const year = Number(yStr) || new Date().getFullYear();
  const month = Number(mStr) || new Date().getMonth() + 1;
  return new Date(year, month - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
}

function shiftMonth(monthKey: string, delta: number): string {
  const [yStr, mStr] = monthKey.split('-');
  const d = new Date(Number(yStr), Number(mStr) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export const TourPlanModule: React.FC<TourPlanModuleProps> = ({
  currentUser,
  isAdminView,
  tourPlans,
  employees,
  customers,
}) => {
  const [selectedMonth, setSelectedMonth] = useState(currentMonthKey());
  const [viewMode, setViewMode] = useState<'calendar' | 'sheet'>('calendar');

  const selectableStaff = useMemo(() => {
    const list: { uid: string; name: string; territory: string; role: string }[] = [];
    const seen = new Set<string>();
    for (const emp of employees) {
      const targetUid = emp.uid || emp.id;
      if (!targetUid || seen.has(targetUid)) continue;
      seen.add(targetUid);
      list.push({
        uid: targetUid,
        name: emp.fullName,
        territory: emp.territory || 'Corporate HQ',
        role: emp.designation || getRoleDisplayLabel(emp.role),
      });
    }
    if (!seen.has(currentUser.uid)) {
      list.unshift({
        uid: currentUser.uid,
        name: currentUser.displayName,
        territory: currentUser.territory || 'Corporate HQ',
        role: currentUser.designation || getRoleDisplayLabel(currentUser.role),
      });
    }
    return list;
  }, [employees, currentUser]);

  const [selectedEmpUid, setSelectedEmpUid] = useState(currentUser.uid);

  useEffect(() => {
    if (!isAdminView) {
      setSelectedEmpUid(currentUser.uid);
    } else if (
      selectableStaff.length > 0 &&
      !selectableStaff.some((s) => s.uid === selectedEmpUid)
    ) {
      setSelectedEmpUid(selectableStaff[0].uid);
    }
  }, [isAdminView, currentUser.uid, selectableStaff, selectedEmpUid]);

  const activeStaff = useMemo(
    () =>
      selectableStaff.find((s) => s.uid === selectedEmpUid) || {
        uid: currentUser.uid,
        name: currentUser.displayName,
        territory: currentUser.territory || 'Corporate HQ',
        role: currentUser.designation || getRoleDisplayLabel(currentUser.role),
      },
    [selectableStaff, selectedEmpUid, currentUser]
  );

  const monthDays = useMemo(() => getMonthDays(selectedMonth), [selectedMonth]);
  const leadingEmptyDays = useMemo(
    () => getMondayFirstOffset(selectedMonth),
    [selectedMonth]
  );

  const existingByDate = useMemo(() => {
    const map = new Map<string, TourPlanEntry>();
    for (const entry of tourPlans) {
      if (entry.employeeUid === activeStaff.uid && entry.month === selectedMonth) {
        map.set(entry.date, entry);
      }
    }
    return map;
  }, [tourPlans, activeStaff.uid, selectedMonth]);

  // Bulk Sheet editable rows synced with Firestore state
  const [sheetRows, setSheetRows] = useState<Record<string, DraftRow>>({});
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [modalForm, setModalForm] = useState<DraftRow | null>(null);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showRouteOptimizer, setShowRouteOptimizer] = useState(false);
  const [routeTargetDate, setRouteTargetDate] = useState(todayIsoDate());
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');

  // Weekly template defaults for quick full-month planning
  const [weeklyTemplate, setWeeklyTemplate] = useState<
    Record<number, { workType: TourWorkType; places: string; route: string }>
  >({
    1: { workType: 'Field Visit', places: 'HQ Main Market & City Pharmacies', route: 'Beat A — North' },
    2: { workType: 'Field Visit', places: 'Hospital Belt & Specialty Clinics', route: 'Beat B — Central' },
    3: { workType: 'Stockist Meet', places: 'Wholesale Stockists & Distributors', route: 'Beat C — Wholesale' },
    4: { workType: 'Outstation', places: 'Upcountry Towns & Sub-District Clinics', route: 'Beat D — Outstation' },
    5: { workType: 'Field Visit', places: 'Retail Pharmacy Follow-ups & Collection', route: 'Beat E — South' },
    6: { workType: 'HQ / Office', places: 'HQ Reporting, Stock Reconciliation & Calls', route: 'Corporate HQ' },
    0: { workType: 'Leave / Holiday', places: 'Weekly Off', route: 'Off Duty' },
  });

  useEffect(() => {
    const next: Record<string, DraftRow> = {};
    for (const date of monthDays) {
      const existing = existingByDate.get(date);
      const dayOfWeek = new Date(`${date}T00:00:00`).getDay();
      if (existing) {
        next[date] = {
          date,
          workType: existing.workType,
          placesToVisit: existing.placesToVisit,
          routeZone: existing.routeZone || '',
          headquarters: existing.headquarters || activeStaff.territory || '',
          plannedCustomers: existing.plannedCustomers || '',
          objective: existing.objective || '',
          overnightStay: Boolean(existing.overnightStay),
          approvalStatus: existing.approvalStatus,
          adminRemarks: existing.adminRemarks || '',
          dirty: false,
        };
      } else {
        next[date] = {
          date,
          workType: dayOfWeek === 0 ? 'Leave / Holiday' : 'Field Visit',
          placesToVisit: dayOfWeek === 0 ? 'Weekly Off' : '',
          routeZone: '',
          headquarters: activeStaff.territory || '',
          plannedCustomers: '',
          objective: '',
          overnightStay: false,
          approvalStatus: 'Draft',
          adminRemarks: '',
          dirty: false,
        };
      }
    }
    setSheetRows(next);
  }, [monthDays, existingByDate, activeStaff.territory]);

  const staffCustomers = useMemo(
    () =>
      customers.filter(
        (c) => isAdminView || c.assignedEmployeeUid === activeStaff.uid
      ),
    [customers, isAdminView, activeStaff.uid]
  );

  const activeEmployeeRecord = useMemo(
    () => employees.find((e) => (e.uid || e.id) === activeStaff.uid),
    [employees, activeStaff.uid]
  );

  const openRouteOptimizer = (preferredDate?: string) => {
    const today = todayIsoDate();
    const fallbackDate = today.startsWith(selectedMonth)
      ? today
      : monthDays[0] || today;
    setRouteTargetDate(preferredDate || fallbackDate);
    setShowRouteOptimizer(true);
  };

  const handleApplyOptimizedRoute = async (params: {
    date: string;
    routeZone: string;
    placesToVisit: string;
    plannedCustomers: string;
    objective: string;
  }) => {
    if (
      !isAdminView &&
      existingByDate.get(params.date)?.approvalStatus === 'Approved'
    ) {
      setFeedback(
        `${params.date} is already Approved. Contact your manager to modify an approved route.`
      );
      return;
    }

    if (editingDate === params.date && modalForm) {
      setModalForm({
        ...modalForm,
        workType:
          modalForm.workType === 'Leave / Holiday'
            ? 'Field Visit'
            : modalForm.workType,
        routeZone: params.routeZone,
        placesToVisit: params.placesToVisit,
        plannedCustomers: params.plannedCustomers,
        objective: params.objective,
      });
      setFeedback(
        `Applied optimal route to ${params.date} draft. Review and click Save Tour Day.`
      );
      return;
    }

    const baseRow = sheetRows[params.date];
    await persistBatchRows([
      {
        date: params.date,
        workType:
          baseRow?.workType && baseRow.workType !== 'Leave / Holiday'
            ? baseRow.workType
            : 'Field Visit',
        placesToVisit: params.placesToVisit,
        routeZone: params.routeZone,
        headquarters: baseRow?.headquarters || activeStaff.territory || '',
        plannedCustomers: params.plannedCustomers,
        objective: params.objective,
        overnightStay: Boolean(baseRow?.overnightStay),
        approvalStatus:
          baseRow?.approvalStatus || (isAdminView ? 'Approved' : 'Draft'),
        adminRemarks: baseRow?.adminRemarks || '',
      },
    ]);
  };

  // Month summary KPIs
  const plannedEntries = useMemo(
    () => Array.from(existingByDate.values()),
    [existingByDate]
  );
  const fieldDays = plannedEntries.filter((e) =>
    ['Field Visit', 'Outstation', 'Stockist Meet', 'CME / Camp'].includes(e.workType)
  ).length;
  const approvedDays = plannedEntries.filter(
    (e) => e.approvalStatus === 'Approved'
  ).length;
  const submittedDays = plannedEntries.filter(
    (e) => e.approvalStatus === 'Submitted'
  ).length;
  const dirtyCount = Object.values(sheetRows).filter((r) => r.dirty).length;

  const openDayEditor = (date: string) => {
    const row = sheetRows[date];
    if (!row) return;
    setEditingDate(date);
    setModalForm({ ...row });
  };

  const persistBatchRows = async (
    rowsToSave: DraftRow[],
    overrideStatus?: TourApprovalStatus
  ) => {
    const validRows = rowsToSave.filter(
      (r) =>
        r.placesToVisit.trim().length > 0 ||
        r.workType === 'Leave / Holiday'
    );
    if (validRows.length === 0) {
      setFeedback('Enter at least one place/location to visit before saving.');
      return;
    }

    setSaving(true);
    setFeedback('');
    try {
      const batch = writeBatch(db);
      for (const row of validRows) {
        if (!isAdminView && existingByDate.get(row.date)?.approvalStatus === 'Approved') {
          continue;
        }
        const existing = existingByDate.get(row.date);
        const planId = existing?.id || `${activeStaff.uid}_${row.date}`;
        const docRef = doc(db, 'tourPlans', planId);
        const safePlaces = (
          row.placesToVisit.trim() ||
          (row.workType === 'Leave / Holiday' ? 'Weekly Off' : 'Assigned Territory')
        ).slice(0, 300);
        const nextStatus: TourApprovalStatus = overrideStatus
          ? overrideStatus
          : isAdminView
          ? row.approvalStatus
          : row.approvalStatus === 'Approved'
          ? 'Approved'
          : row.approvalStatus === 'Submitted'
          ? 'Submitted'
          : 'Draft';

        if (existing) {
          const updatePayload: Record<string, any> = {
            workType: row.workType,
            placesToVisit: safePlaces,
            headquarters: (row.headquarters || activeStaff.territory || '').slice(0, 120),
            routeZone: row.routeZone.trim().slice(0, 120),
            plannedCustomers: row.plannedCustomers.trim().slice(0, 300),
            objective: row.objective.trim().slice(0, 400),
            overnightStay: Boolean(row.overnightStay),
            approvalStatus: nextStatus,
            updatedAt: serverTimestamp(),
          };
          if (isAdminView) {
            updatePayload.adminRemarks = row.adminRemarks.trim().slice(0, 300);
          }
          batch.update(docRef, updatePayload);
        } else {
          batch.set(docRef, {
            id: planId,
            employeeUid: activeStaff.uid,
            employeeName: activeStaff.name.slice(0, 120),
            month: selectedMonth,
            date: row.date,
            workType: row.workType,
            headquarters: (row.headquarters || activeStaff.territory || '').slice(0, 120),
            placesToVisit: safePlaces,
            routeZone: row.routeZone.trim().slice(0, 120),
            plannedCustomers: row.plannedCustomers.trim().slice(0, 300),
            objective: row.objective.trim().slice(0, 400),
            overnightStay: Boolean(row.overnightStay),
            approvalStatus: nextStatus,
            ...(isAdminView && row.adminRemarks.trim()
              ? { adminRemarks: row.adminRemarks.trim().slice(0, 300) }
              : {}),
            createdByUid: currentUser.uid,
            isDemo: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }

      await batch.commit();

      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: 'Tour Plan Updated',
        entityType: 'tourPlans',
        entityId: `${activeStaff.uid}_${selectedMonth}`,
        details: `Saved ${validRows.length} day(s) in ${selectedMonth} tour plan for ${activeStaff.name}`,
      });

      if (overrideStatus === 'Submitted' && !isAdminView) {
        await pushNotification({
          recipientUid: 'ALL',
          targetRole: 'Admin',
          title: 'Monthly Tour Plan Submitted',
          message: `${activeStaff.name} submitted their ${selectedMonth} tour plan (${validRows.length} days) for review.`,
          category: 'Task',
          severity: 'info',
          linkTab: 'tour-plan',
        });
      } else if (overrideStatus === 'Approved' && isAdminView && activeStaff.uid !== currentUser.uid) {
        await pushNotification({
          recipientUid: activeStaff.uid,
          title: 'Monthly Tour Plan Approved',
          message: `Your ${selectedMonth} tour plan (${validRows.length} days) has been approved by ${currentUser.displayName}.`,
          category: 'Task',
          severity: 'info',
          linkTab: 'my-tour-plan',
        });
      }

      setFeedback(
        `Saved ${validRows.length} day(s) for ${formatMonthHeading(selectedMonth)}.`
      );
      setEditingDate(null);
      setModalForm(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'tourPlans');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveModalDay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalForm) return;
    await persistBatchRows([modalForm]);
  };

  const handleSaveDirtySheetRows = async () => {
    const dirty = Object.values(sheetRows).filter((r) => r.dirty);
    if (dirty.length === 0) {
      setFeedback('No unsaved edits in the monthly sheet.');
      return;
    }
    await persistBatchRows(dirty);
  };

  const handleSubmitOrApproveMonth = async (targetStatus: 'Submitted' | 'Approved') => {
    const rowsWithPlaces = Object.values(sheetRows).filter(
      (r) =>
        r.placesToVisit.trim().length > 0 || existingByDate.has(r.date)
    );
    if (rowsWithPlaces.length === 0) {
      setFeedback('Add places to visit first before submitting or approving the month.');
      return;
    }
    await persistBatchRows(rowsWithPlaces, targetStatus);
  };

  const handleApplyWeeklyTemplate = async () => {
    const generated: DraftRow[] = [];
    for (const date of monthDays) {
      const existing = existingByDate.get(date);
      if (!isAdminView && existing?.approvalStatus === 'Approved') continue;
      const dayOfWeek = new Date(`${date}T00:00:00`).getDay();
      const tpl = weeklyTemplate[dayOfWeek];
      if (!tpl || !tpl.places.trim()) continue;
      generated.push({
        date,
        workType: tpl.workType,
        placesToVisit: tpl.places.trim(),
        routeZone: tpl.route.trim(),
        headquarters: activeStaff.territory || 'Corporate HQ',
        plannedCustomers: existing?.plannedCustomers || '',
        objective: existing?.objective || '',
        overnightStay: tpl.workType === 'Outstation',
        approvalStatus: isAdminView ? 'Approved' : 'Draft',
        adminRemarks: existing?.adminRemarks || '',
      });
    }
    setShowTemplateModal(false);
    await persistBatchRows(generated);
  };

  const handleDeleteDay = async (date: string) => {
    if (!isAdminView) return;
    const planId = existingByDate.get(date)?.id || `${activeStaff.uid}_${date}`;
    try {
      await deleteDoc(doc(db, 'tourPlans', planId));
      setEditingDate(null);
      setModalForm(null);
      setFeedback(`Cleared tour entry for ${date}.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `tourPlans/${planId}`);
    }
  };

  const handleExportCsv = () => {
    exportToCsv(
      `glacetor-tour-plan-${activeStaff.name.replace(/\s+/g, '-').toLowerCase()}-${selectedMonth}.csv`,
      [
        'Date',
        'Day',
        'Employee',
        'Work Type',
        'Places To Visit',
        'Route / Beat',
        'Headquarters',
        'Planned Customers',
        'Objective',
        'Overnight Stay',
        'Approval Status',
        'Admin Remarks',
      ],
      monthDays.map((date) => {
        const r = sheetRows[date];
        const dayLabel = new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', {
          weekday: 'short',
        });
        return [
          date,
          dayLabel,
          activeStaff.name,
          r?.workType || 'Field Visit',
          r?.placesToVisit || 'Not Planned',
          r?.routeZone || '',
          r?.headquarters || '',
          r?.plannedCustomers || '',
          r?.objective || '',
          r?.overnightStay ? 'Yes' : 'No',
          r?.approvalStatus || 'Draft',
          r?.adminRemarks || '',
        ];
      })
    );
  };

  const workBadgeColor = (wt: TourWorkType) => {
    switch (wt) {
      case 'Field Visit':
        return 'bg-emerald-50 text-[#15803D] border-emerald-200';
      case 'Outstation':
        return 'bg-blue-50 text-[#0F2744] border-blue-200';
      case 'Stockist Meet':
        return 'bg-indigo-50 text-indigo-800 border-indigo-200';
      case 'CME / Camp':
        return 'bg-teal-50 text-teal-800 border-teal-200';
      case 'HQ / Office':
        return 'bg-slate-100 text-slate-700 border-slate-200';
      case 'Transit':
        return 'bg-amber-50 text-amber-800 border-amber-200';
      case 'Leave / Holiday':
        return 'bg-rose-50 text-rose-700 border-rose-200';
    }
  };

  const statusBadgeColor = (st: TourApprovalStatus) => {
    switch (st) {
      case 'Approved':
        return 'bg-emerald-100 text-emerald-800';
      case 'Submitted':
        return 'bg-amber-100 text-amber-800';
      case 'Rejected':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-slate-100 text-slate-600';
    }
  };

  return (
    <div className="space-y-5">
      {/* Header Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-[#0F2744] flex items-center gap-2">
            <Calendar className="w-5 h-5 text-[#15803D]" />
            Monthly Tour Plan (MTP)
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Plan and edit day-by-day field visit places, routes, stockist calls, and outstation tours for the entire month.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 no-print">
          {isAdminView && (
            <select
              value={activeStaff.uid}
              onChange={(e) => setSelectedEmpUid(e.target.value)}
              className="px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2744] min-h-[40px]"
            >
              {selectableStaff.map((s) => (
                <option key={s.uid} value={s.uid}>
                  {s.name} ({s.role})
                </option>
              ))}
            </select>
          )}

          <div className="flex items-center bg-white border border-slate-300 rounded-lg overflow-hidden min-h-[40px]">
            <button
              type="button"
              onClick={() => setSelectedMonth((m) => shiftMonth(m, -1))}
              className="px-2.5 py-2 hover:bg-slate-100 text-slate-600"
              aria-label="Previous month"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => e.target.value && setSelectedMonth(e.target.value)}
              className="px-2 py-1.5 text-xs font-semibold text-[#0F2744] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setSelectedMonth((m) => shiftMonth(m, 1))}
              className="px-2.5 py-2 hover:bg-slate-100 text-slate-600"
              aria-label="Next month"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => openRouteOptimizer()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-[#15803D] hover:bg-[#166534] text-white rounded-lg min-h-[40px]"
          >
            <Route className="w-3.5 h-3.5" />
            Suggest Optimal Route
          </button>

          <button
            type="button"
            onClick={() => setShowTemplateModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-slate-300 hover:border-[#0F2744] text-slate-800 rounded-lg min-h-[40px]"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#15803D]" />
            Fill Whole Month Template
          </button>

          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg min-h-[40px]"
          >
            <Download className="w-3.5 h-3.5" />
            CSV
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg min-h-[40px]"
          >
            <Printer className="w-3.5 h-3.5" />
            Print
          </button>
        </div>
      </div>

      {feedback && (
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs flex items-center justify-between gap-2 no-print">
          <span>{feedback}</span>
          <button
            type="button"
            onClick={() => setFeedback('')}
            className="text-emerald-700 hover:text-emerald-950"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Summary KPIs + View Toggle */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Planned Days ({formatMonthHeading(selectedMonth)})</div>
          <div className="text-xl font-bold font-mono tabular-nums text-[#0F2744] mt-1">
            {plannedEntries.length} / {monthDays.length}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Field & Outstation Tours</div>
          <div className="text-xl font-bold font-mono tabular-nums text-[#15803D] mt-1">
            {fieldDays}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Approved Days</div>
          <div className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-1">
            {approvedDays}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Awaiting Approval</div>
          <div className="text-xl font-bold font-mono tabular-nums text-amber-700 mt-1">
            {submittedDays}
          </div>
        </div>
      </div>

      {/* Mode Switcher & Month Action Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 no-print">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setViewMode('calendar')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors min-h-[38px] ${
              viewMode === 'calendar'
                ? 'bg-[#0F2744] text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <Calendar className="w-3.5 h-3.5" />
            Calendar View
          </button>
          <button
            type="button"
            onClick={() => setViewMode('sheet')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors min-h-[38px] ${
              viewMode === 'sheet'
                ? 'bg-[#0F2744] text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Full-Month Edit Sheet
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {viewMode === 'sheet' && dirtyCount > 0 && (
            <button
              type="button"
              disabled={saving}
              onClick={handleSaveDirtySheetRows}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-[#16A34A] hover:bg-[#15803D] text-white rounded-lg min-h-[38px] disabled:opacity-60"
            >
              <Check className="w-3.5 h-3.5" />
              Save {dirtyCount} Edited Day(s)
            </button>
          )}

          {!isAdminView ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => handleSubmitOrApproveMonth('Submitted')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-[#0F2744] hover:bg-[#16355C] text-white rounded-lg min-h-[38px] disabled:opacity-60"
            >
              <Send className="w-3.5 h-3.5" />
              Submit Month for Approval
            </button>
          ) : (
            <button
              type="button"
              disabled={saving}
              onClick={() => handleSubmitOrApproveMonth('Approved')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-[#15803D] hover:bg-[#166534] text-white rounded-lg min-h-[38px] disabled:opacity-60"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              Approve Planned Month
            </button>
          )}
        </div>
      </div>

      {/* VIEW 1: INTERACTIVE MONTHLY CALENDAR GRID */}
      {viewMode === 'calendar' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                {activeStaff.name} · {formatMonthHeading(selectedMonth)}
              </h3>
              <p className="text-xs text-slate-500">
                Tap any date to add or edit places to visit, beat, customers, and objectives.
              </p>
            </div>
            <span className="text-xs font-medium text-slate-500">
              HQ: {activeStaff.territory}
            </span>
          </div>

          <div className="hidden md:grid grid-cols-7 border-b border-slate-200 bg-slate-50">
            {WEEKDAYS.map((day) => (
              <div
                key={day}
                className="px-3 py-2 text-xs font-semibold text-slate-600 border-r border-slate-200 last:border-r-0"
              >
                {day}
              </div>
            ))}
          </div>

          {/* Desktop 7-Col Calendar */}
          <div className="hidden md:grid grid-cols-7">
            {Array.from({ length: leadingEmptyDays }).map((_, i) => (
              <div
                key={`empty_${i}`}
                className="min-h-[120px] bg-slate-50/60 border-r border-b border-slate-200"
              />
            ))}

            {monthDays.map((date) => {
              const entry = existingByDate.get(date);
              const dayNum = Number(date.slice(8, 10));
              const isSunday = new Date(`${date}T00:00:00`).getDay() === 0;
              return (
                <button
                  key={date}
                  type="button"
                  onClick={() => openDayEditor(date)}
                  className={`min-h-[120px] p-2.5 text-left border-r border-b border-slate-200 hover:bg-slate-50 transition-colors flex flex-col justify-between gap-1.5 ${
                    isSunday && !entry ? 'bg-rose-50/30' : 'bg-white'
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="text-xs font-bold font-mono text-slate-800">
                      {dayNum}
                    </span>
                    {entry ? (
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${statusBadgeColor(
                          entry.approvalStatus
                        )}`}
                      >
                        {entry.approvalStatus}
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-400">+ Plan</span>
                    )}
                  </div>

                  {entry ? (
                    <div className="space-y-1 w-full">
                      <div
                        className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border ${workBadgeColor(
                          entry.workType
                        )}`}
                      >
                        {entry.workType}
                      </div>
                      <div className="text-xs font-medium text-slate-900 line-clamp-2 leading-snug">
                        {entry.placesToVisit}
                      </div>
                      {entry.routeZone && (
                        <div className="text-[10px] text-slate-500 truncate">
                          {entry.routeZone}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-400">
                      {isSunday ? 'Weekly Off' : 'Tap to set place'}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Mobile Agenda List */}
          <div className="md:hidden divide-y divide-slate-200">
            {monthDays.map((date) => {
              const entry = existingByDate.get(date);
              const label = new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', {
                day: '2-digit',
                month: 'short',
                weekday: 'short',
              });
              return (
                <button
                  key={date}
                  type="button"
                  onClick={() => openDayEditor(date)}
                  className="w-full p-4 text-left flex items-start justify-between gap-3 hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold font-mono text-[#0F2744]">
                        {label}
                      </span>
                      {entry && (
                        <span
                          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${workBadgeColor(
                            entry.workType
                          )}`}
                        >
                          {entry.workType}
                        </span>
                      )}
                    </div>
                    <div className="text-sm font-medium text-slate-900 mt-1">
                      {entry ? entry.placesToVisit : 'Tap to assign visit place'}
                    </div>
                    {entry?.routeZone && (
                      <div className="text-xs text-slate-500 mt-0.5">
                        Beat: {entry.routeZone}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 flex items-center gap-1.5">
                    {entry && (
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded ${statusBadgeColor(
                          entry.approvalStatus
                        )}`}
                      >
                        {entry.approvalStatus}
                      </span>
                    )}
                    <Edit3 className="w-4 h-4 text-slate-400" />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* VIEW 2: FULL-MONTH DAY-BY-DAY BULK EDIT SHEET */}
      {viewMode === 'sheet' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Full-Month Editable Schedule · {activeStaff.name}
              </h3>
              <p className="text-xs text-slate-500">
                Edit places for every date across the month directly, then click Save Edited Days.
              </p>
            </div>
            {dirtyCount > 0 && (
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveDirtySheetRows}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-[#16A34A] hover:bg-[#15803D] text-white rounded-lg"
              >
                <Check className="w-3.5 h-3.5" />
                Save {dirtyCount} Edited Day(s)
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
                  <th className="px-3 py-2.5 whitespace-nowrap">Date</th>
                  <th className="px-3 py-2.5 whitespace-nowrap">Work Type</th>
                  <th className="px-3 py-2.5 min-w-[230px]">Places / Locations to Visit *</th>
                  <th className="px-3 py-2.5 min-w-[150px]">Route / Beat</th>
                  <th className="px-3 py-2.5 min-w-[170px]">Customers / Target</th>
                  <th className="px-3 py-2.5 whitespace-nowrap">Status</th>
                  <th className="px-3 py-2.5 text-right whitespace-nowrap">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {monthDays.map((date) => {
                  const row = sheetRows[date];
                  if (!row) return null;
                  const lockedForEmployee =
                    !isAdminView &&
                    existingByDate.get(date)?.approvalStatus === 'Approved';
                  const dayShort = new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', {
                    day: '2-digit',
                    month: 'short',
                    weekday: 'short',
                  });

                  const updateRow = (patch: Partial<DraftRow>) => {
                    setSheetRows((prev) => ({
                      ...prev,
                      [date]: { ...prev[date], ...patch, dirty: true },
                    }));
                  };

                  return (
                    <tr
                      key={date}
                      className={row.dirty ? 'bg-amber-50/40' : 'hover:bg-slate-50/70'}
                    >
                      <td className="px-3 py-2 font-mono font-semibold text-slate-800 whitespace-nowrap">
                        {dayShort}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          disabled={lockedForEmployee}
                          value={row.workType}
                          onChange={(e) =>
                            updateRow({ workType: e.target.value as TourWorkType })
                          }
                          className="px-2 py-1.5 text-xs border border-slate-300 rounded-md bg-white disabled:bg-slate-100"
                        >
                          {WORK_TYPES.map((wt) => (
                            <option key={wt} value={wt}>
                              {wt}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          disabled={lockedForEmployee}
                          value={row.placesToVisit}
                          onChange={(e) => updateRow({ placesToVisit: e.target.value })}
                          placeholder="e.g. Dadar West, Sion Hospital Belt"
                          className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-white disabled:bg-slate-100"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          disabled={lockedForEmployee}
                          value={row.routeZone}
                          onChange={(e) => updateRow({ routeZone: e.target.value })}
                          placeholder="e.g. Beat A"
                          className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-white disabled:bg-slate-100"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          disabled={lockedForEmployee}
                          value={row.plannedCustomers}
                          onChange={(e) => updateRow({ plannedCustomers: e.target.value })}
                          placeholder="Pharmacies / Doctors"
                          className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-white disabled:bg-slate-100"
                        />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold ${statusBadgeColor(
                            row.approvalStatus
                          )}`}
                        >
                          {row.approvalStatus}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => openDayEditor(date)}
                          className="text-xs font-medium text-[#0F2744] hover:underline"
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SINGLE DAY EDITOR MODAL */}
      {editingDate && modalForm && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-bold text-[#0F2744] flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-[#15803D]" />
                  Edit Tour Plan · {editingDate}
                </h3>
                <p className="text-xs text-slate-500">
                  {activeStaff.name} ·{' '}
                  {new Date(`${editingDate}T00:00:00`).toLocaleDateString('en-IN', {
                    weekday: 'long',
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingDate(null);
                  setModalForm(null);
                }}
                className="p-1.5 text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {!isAdminView &&
              existingByDate.get(editingDate)?.approvalStatus === 'Approved' && (
                <div className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
                  This day&apos;s tour plan is <strong>Approved</strong> by administration. Contact your manager or admin if a route revision is required.
                </div>
              )}

            <form onSubmit={handleSaveModalDay} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Work Type
                  </label>
                  <select
                    disabled={
                      !isAdminView &&
                      existingByDate.get(editingDate)?.approvalStatus === 'Approved'
                    }
                    value={modalForm.workType}
                    onChange={(e) =>
                      setModalForm({
                        ...modalForm,
                        workType: e.target.value as TourWorkType,
                        placesToVisit:
                          e.target.value === 'Leave / Holiday' &&
                          !modalForm.placesToVisit.trim()
                            ? 'Weekly Off'
                            : modalForm.placesToVisit,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {WORK_TYPES.map((wt) => (
                      <option key={wt} value={wt}>
                        {wt}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Route / Beat Name
                  </label>
                  <input
                    type="text"
                    disabled={
                      !isAdminView &&
                      existingByDate.get(editingDate)?.approvalStatus === 'Approved'
                    }
                    value={modalForm.routeZone}
                    onChange={(e) =>
                      setModalForm({ ...modalForm, routeZone: e.target.value })
                    }
                    placeholder="e.g. South Mumbai Beat A"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Places / Areas to Visit *
                </label>
                <input
                  type="text"
                  required
                  disabled={
                    !isAdminView &&
                    existingByDate.get(editingDate)?.approvalStatus === 'Approved'
                  }
                  value={modalForm.placesToVisit}
                  onChange={(e) =>
                    setModalForm({ ...modalForm, placesToVisit: e.target.value })
                  }
                  placeholder="e.g. Dadar West, Sion Hospital Belt, Matunga Medical Market"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Base HQ / City
                  </label>
                  <input
                    type="text"
                    disabled={
                      !isAdminView &&
                      existingByDate.get(editingDate)?.approvalStatus === 'Approved'
                    }
                    value={modalForm.headquarters}
                    onChange={(e) =>
                      setModalForm({ ...modalForm, headquarters: e.target.value })
                    }
                    placeholder="e.g. Mumbai HQ"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>

                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={
                        !isAdminView &&
                        existingByDate.get(editingDate)?.approvalStatus === 'Approved'
                      }
                      checked={modalForm.overnightStay}
                      onChange={(e) =>
                        setModalForm({
                          ...modalForm,
                          overnightStay: e.target.checked,
                        })
                      }
                      className="rounded border-slate-300"
                    />
                    Outstation Night Halt / Overnight Stay
                  </label>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="block text-xs font-medium text-slate-700">
                    Planned Customers / Pharmacies / Hospitals
                  </label>
                  {(isAdminView ||
                    existingByDate.get(editingDate)?.approvalStatus !== 'Approved') && (
                    <button
                      type="button"
                      onClick={() => openRouteOptimizer(editingDate)}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#15803D] hover:underline"
                    >
                      <Route className="w-3 h-3" />
                      Optimize Visit Order (GPS)
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  disabled={
                    !isAdminView &&
                    existingByDate.get(editingDate)?.approvalStatus === 'Approved'
                  }
                  value={modalForm.plannedCustomers}
                  onChange={(e) =>
                    setModalForm({
                      ...modalForm,
                      plannedCustomers: e.target.value,
                    })
                  }
                  placeholder="e.g. CityMed Pharmacy, Sahyadri Hospital"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
                {staffCustomers.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {staffCustomers.slice(0, 6).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        disabled={
                          !isAdminView &&
                          existingByDate.get(editingDate)?.approvalStatus === 'Approved'
                        }
                        onClick={() => {
                          const current = modalForm.plannedCustomers.trim();
                          if (current.includes(c.businessName)) return;
                          setModalForm({
                            ...modalForm,
                            plannedCustomers: current
                              ? `${current}, ${c.businessName}`
                              : c.businessName,
                            placesToVisit:
                              modalForm.placesToVisit.trim() || `${c.city} (${c.businessName})`,
                          });
                        }}
                        className="text-[11px] px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200"
                      >
                        + {c.businessName}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Visit Objective / Sales Target Notes
                </label>
                <textarea
                  rows={2}
                  disabled={
                    !isAdminView &&
                    existingByDate.get(editingDate)?.approvalStatus === 'Approved'
                  }
                  value={modalForm.objective}
                  onChange={(e) =>
                    setModalForm({ ...modalForm, objective: e.target.value })
                  }
                  placeholder="Doctor detailing, product sampling, order booking or payment collection..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              {isAdminView && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-200">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Approval Status
                    </label>
                    <select
                      value={modalForm.approvalStatus}
                      onChange={(e) =>
                        setModalForm({
                          ...modalForm,
                          approvalStatus: e.target.value as TourApprovalStatus,
                        })
                      }
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="Draft">Draft</option>
                      <option value="Submitted">Submitted</option>
                      <option value="Approved">Approved</option>
                      <option value="Rejected">Rejected</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Admin Remarks
                    </label>
                    <input
                      type="text"
                      value={modalForm.adminRemarks}
                      onChange={(e) =>
                        setModalForm({ ...modalForm, adminRemarks: e.target.value })
                      }
                      placeholder="Optional route instruction"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-2">
                {isAdminView && existingByDate.has(editingDate) ? (
                  <button
                    type="button"
                    onClick={() => handleDeleteDay(editingDate)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded-lg"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Clear Day
                  </button>
                ) : (
                  <div />
                )}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingDate(null);
                      setModalForm(null);
                    }}
                    className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900"
                  >
                    Cancel
                  </button>
                  {(isAdminView ||
                    existingByDate.get(editingDate)?.approvalStatus !== 'Approved') && (
                    <button
                      type="submit"
                      disabled={saving}
                      className="px-4 py-2.5 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg min-h-[40px] disabled:opacity-60"
                    >
                      {saving ? 'Saving...' : 'Save Tour Day'}
                    </button>
                  )}
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* WHOLE-MONTH WEEKLY TEMPLATE MODAL */}
      {showTemplateModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-base font-bold text-[#0F2744]">
                  Fill Whole Month Using Weekly Route Pattern
                </h3>
                <p className="text-xs text-slate-500">
                  Assign places for each weekday (Mon–Sun) and populate {formatMonthHeading(selectedMonth)} for {activeStaff.name} in one click. You can edit individual dates afterward.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowTemplateModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2.5 mt-4">
              {[1, 2, 3, 4, 5, 6, 0].map((dayIndex) => {
                const label = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayIndex];
                const cfg = weeklyTemplate[dayIndex];
                return (
                  <div
                    key={dayIndex}
                    className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center p-2.5 rounded-lg border border-slate-200 bg-slate-50"
                  >
                    <div className="sm:col-span-2 text-xs font-bold text-[#0F2744]">
                      {label}
                    </div>
                    <div className="sm:col-span-3">
                      <select
                        value={cfg.workType}
                        onChange={(e) =>
                          setWeeklyTemplate((prev) => ({
                            ...prev,
                            [dayIndex]: {
                              ...prev[dayIndex],
                              workType: e.target.value as TourWorkType,
                            },
                          }))
                        }
                        className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded bg-white"
                      >
                        {WORK_TYPES.map((wt) => (
                          <option key={wt} value={wt}>
                            {wt}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-4">
                      <input
                        type="text"
                        value={cfg.places}
                        onChange={(e) =>
                          setWeeklyTemplate((prev) => ({
                            ...prev,
                            [dayIndex]: { ...prev[dayIndex], places: e.target.value },
                          }))
                        }
                        placeholder="Places to visit"
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <input
                        type="text"
                        value={cfg.route}
                        onChange={(e) =>
                          setWeeklyTemplate((prev) => ({
                            ...prev,
                            [dayIndex]: { ...prev[dayIndex], route: e.target.value },
                          }))
                        }
                        placeholder="Beat / Route"
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={() => setShowTemplateModal(false)}
                className="px-4 py-2 text-xs font-medium text-slate-600"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleApplyWeeklyTemplate}
                className="px-4 py-2.5 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[40px] disabled:opacity-60"
              >
                {saving ? 'Applying...' : `Apply to ${formatMonthHeading(selectedMonth)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      <RouteOptimizerModal
        isOpen={showRouteOptimizer}
        onClose={() => setShowRouteOptimizer(false)}
        staffName={activeStaff.name}
        staffEmployee={activeEmployeeRecord}
        customers={staffCustomers}
        targetDate={routeTargetDate}
        monthDays={monthDays}
        onApplyRoute={handleApplyOptimizedRoute}
      />
    </div>
  );
};
