import React, { useEffect, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Bell,
  Building2,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Clock,
  Fingerprint,
  MapPin,
  Package,
  Receipt,
  ShoppingCart,
  Stethoscope,
} from 'lucide-react';
import {
  ActivityLog,
  AttendanceRecord,
  Customer,
  EmployeeTab,
  LeaveRequest,
  LocationPing,
  NotificationItem,
  SalesOrder,
  StockAllocation,
  TaskItem,
  UserAccount,
} from '../types/erp';
import {
  formatCurrency,
  formatMinutesAsHours,
  formatTimestamp,
  todayIsoDate,
} from '../lib/utils';
import { checkBiometricSupport, getDeviceBiometricBinding } from '../lib/biometrics';
import { getRoleDisplayLabel } from '../lib/roles';

interface EmployeeDashboardProps {
  currentUser: UserAccount;
  attendance: AttendanceRecord[];
  tasks: TaskItem[];
  activities: ActivityLog[];
  customers: Customer[];
  allocations: StockAllocation[];
  salesOrders: SalesOrder[];
  leaveRequests: LeaveRequest[];
  locations: LocationPing[];
  notifications: NotificationItem[];
  isLiveTrackingActive?: boolean;
  onNavigate: (tab: EmployeeTab) => void;
}

export const EmployeeDashboard: React.FC<EmployeeDashboardProps> = ({
  currentUser,
  attendance,
  tasks,
  activities,
  customers,
  allocations,
  salesOrders,
  leaveRequests,
  locations,
  notifications,
  isLiveTrackingActive = false,
  onNavigate,
}) => {
  const today = todayIsoDate();
  const todayRecord = attendance.find((a) => a.date === today);
  const myLatestLocation = locations[0];
  const openTasks = tasks.filter(
    (t) => !['Approved', 'Cancelled'].includes(t.status)
  );
  const unreadNotifs = notifications.filter((n) => !n.isRead);
  const myMonthlySales = salesOrders
    .filter((o) => o.orderStatus !== 'Cancelled')
    .reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);
  const allocatedUnits = allocations.reduce(
    (sum, a) => sum + (Number(a.remainingQty) || 0),
    0
  );

  const [showBiometricPrompt, setShowBiometricPrompt] = useState(false);

  useEffect(() => {
    const binding = getDeviceBiometricBinding();
    if (binding && binding.userId === currentUser.uid) {
      setShowBiometricPrompt(false);
      return;
    }
    checkBiometricSupport().then((res) => {
      if (res.available) {
        setShowBiometricPrompt(true);
      }
    });
  }, [currentUser.uid]);

  return (
    <div className="space-y-6">
      {/* Personal Profile & Duty Status Banner */}
      <div className="bg-[#0F2744] text-white rounded-xl p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="text-xs text-slate-300">
            {currentUser.designation
              ? `${currentUser.designation} · ${getRoleDisplayLabel(currentUser.role)}`
              : getRoleDisplayLabel(currentUser.role)}{' '}
            · {currentUser.department || 'Field Operations'}
          </div>
          <h2 className="text-xl font-bold mt-0.5">{currentUser.displayName}</h2>
          <p className="text-xs text-slate-300 mt-1">
            Territory: {currentUser.territory || 'Assigned Zone'} · {currentUser.email}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate('my-attendance')}
            className="px-4 py-2.5 text-xs font-semibold bg-[#16A34A] hover:bg-[#15803D] text-white rounded-lg transition-colors whitespace-nowrap min-h-[44px]"
          >
            {todayRecord?.checkInTime && !todayRecord?.checkOutTime
              ? 'View Attendance / Check-Out'
              : 'Today Check-In'}
          </button>
          <button
            type="button"
            onClick={() => onNavigate('my-doctors')}
            className="px-4 py-2.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors whitespace-nowrap min-h-[44px] inline-flex items-center gap-1.5"
          >
            <Stethoscope className="w-3.5 h-3.5" />
            Doctors &amp; Calls
          </button>
          <button
            type="button"
            onClick={() => onNavigate('my-tour-plan')}
            className="px-4 py-2.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors whitespace-nowrap min-h-[44px] inline-flex items-center gap-1.5"
          >
            <CalendarDays className="w-3.5 h-3.5" />
            Monthly Tour Plan
          </button>
          <button
            type="button"
            onClick={() => onNavigate('my-visits')}
            className="px-4 py-2.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors whitespace-nowrap min-h-[44px]"
          >
            GPS & Visits
          </button>
          <button
            type="button"
            onClick={() => onNavigate('my-expenses')}
            className="px-4 py-2.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors whitespace-nowrap min-h-[44px] inline-flex items-center gap-1.5"
          >
            <Receipt className="w-3.5 h-3.5" />
            Expenses
          </button>
        </div>
      </div>

      {/* Biometric Quick-Enroll Prompt (Mobile / PWA) */}
      {showBiometricPrompt && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#15803D] text-white flex items-center justify-center shrink-0">
              <Fingerprint className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs font-bold text-slate-900">
                Enable Fingerprint / Face ID Unlock
              </div>
              <div className="text-[11px] text-slate-600">
                Sign back in faster on your mobile PWA with hardware biometric verification.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('my-profile')}
            className="px-3.5 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg whitespace-nowrap min-h-[40px] self-start sm:self-auto"
          >
            Setup Biometrics
          </button>
        </div>
      )}

      {/* Personal Authorized KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
            <span>Today Attendance</span>
            <CalendarCheck className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-base font-bold text-slate-900">
            {todayRecord ? todayRecord.status : 'Not Checked In'}
          </div>
          <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
            {todayRecord?.checkInTime
              ? `In: ${todayRecord.checkInTime}${
                  todayRecord.workingMinutes
                    ? ` · ${formatMinutesAsHours(todayRecord.workingMinutes)}`
                    : ''
                }`
              : 'Tap Check-In to start shift'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
            <span>My Active Tasks</span>
            <ClipboardList className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-xl font-bold font-mono tabular-nums text-[#0F2744]">
            {openTasks.length}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {tasks.filter((t) => t.status === 'Overdue').length} overdue
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
            <span>Allocated Stock</span>
            <Package className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-xl font-bold font-mono tabular-nums text-[#15803D]">
            {allocatedUnits}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Across {allocations.length} batches
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
            <span>My Recorded Sales</span>
            <ShoppingCart className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-xl font-bold font-mono tabular-nums text-slate-900">
            {formatCurrency(myMonthlySales)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {customers.length} assigned customers
          </div>
        </div>
      </div>

      {/* GPS Status + Notifications Strip */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <MapPin className="w-4 h-4 text-[#15803D]" />
              Location Tracking Status
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('my-visits')}
              className="text-xs font-medium text-[#0F2744] hover:underline inline-flex items-center gap-1"
            >
              Manage GPS <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="text-sm text-slate-700 flex items-center gap-2">
            <span>Status:</span>
            {isLiveTrackingActive ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-[#15803D]">
                <span className="w-2 h-2 rounded-full bg-[#15803D] animate-pulse" />
                Live GPS Sharing Active
              </span>
            ) : (
              <strong className="font-semibold">
                {myLatestLocation?.trackingActive && myLatestLocation?.status !== 'Checked Out'
                  ? 'On Duty (Standby on This Device)'
                  : 'Standby / Not Sharing'}
              </strong>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {myLatestLocation
              ? `Last recorded: ${formatTimestamp(myLatestLocation.recordedAt)}${
                  myLatestLocation.customerName || myLatestLocation.territory
                    ? ` · ${myLatestLocation.customerName || myLatestLocation.territory}`
                    : ''
                } (±${Math.round(myLatestLocation.accuracy)}m)`
              : 'No GPS check-in recorded yet today. Location is only captured when you consent.'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <Bell className="w-4 h-4 text-[#0F2744]" />
              Recent Notifications ({unreadNotifs.length} unread)
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('notifications')}
              className="text-xs font-medium text-[#0F2744] hover:underline inline-flex items-center gap-1"
            >
              View All <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          {notifications.length === 0 ? (
            <p className="text-xs text-slate-500">No notifications at the moment.</p>
          ) : (
            <ul className="space-y-2">
              {notifications.slice(0, 3).map((n) => (
                <li
                  key={n.id}
                  className="text-xs flex items-start justify-between gap-2 pb-2 border-b border-slate-100 last:border-0 last:pb-0"
                >
                  <div>
                    <span className="font-semibold text-slate-800">{n.title}</span>
                    <p className="text-slate-500 mt-0.5">{n.message}</p>
                  </div>
                  <span className="text-[11px] text-slate-400 whitespace-nowrap">
                    {n.category}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Assigned Tasks & Personal Work Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-900">
              My Assigned Tasks & Deadlines
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('my-tasks')}
              className="text-xs font-medium text-[#0F2744] hover:underline inline-flex items-center gap-1"
            >
              Open Tasks <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          {openTasks.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              No active tasks assigned right now.
            </div>
          ) : (
            <div className="space-y-3">
              {openTasks.slice(0, 5).map((task) => (
                <div
                  key={task.id}
                  className="p-3.5 rounded-lg border border-slate-200 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900 truncate">
                      {task.title}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {task.category} · Priority: {task.priority} · Due {task.deadline}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs font-semibold text-[#0F2744]">
                      {task.status}
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-slate-500">
                      {task.progressPct || 0}%
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#0F2744]" />
              My Recent Activity & Leave Status
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('my-activity')}
              className="text-xs font-medium text-[#0F2744] hover:underline inline-flex items-center gap-1"
            >
              Full Timeline <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {leaveRequests.length > 0 && (
            <div className="mb-3 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs flex items-center justify-between">
              <span className="text-slate-600">
                Latest Leave ({leaveRequests[0].leaveType}): {leaveRequests[0].startDate}
              </span>
              <span className="font-semibold text-[#0F2744]">
                {leaveRequests[0].status}
              </span>
            </div>
          )}

          {activities.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-400">
              No personal activity logged yet.
            </div>
          ) : (
            <ul className="space-y-2.5">
              {activities.slice(0, 5).map((act) => (
                <li
                  key={act.id}
                  className="text-xs flex items-start justify-between gap-3 pb-2.5 border-b border-slate-100 last:border-0"
                >
                  <div>
                    <span className="font-semibold text-slate-800">{act.action}</span>
                    <p className="text-slate-500 mt-0.5">{act.details}</p>
                  </div>
                  <span className="text-[11px] font-mono text-slate-400 whitespace-nowrap">
                    {formatTimestamp(act.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Quick Shortcuts Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <QuickShortcut
          icon={Building2}
          label="My Customers"
          sub={`${customers.length} accounts`}
          onClick={() => onNavigate('my-customers')}
        />
        <QuickShortcut
          icon={Package}
          label="My Stock"
          sub={`${allocatedUnits} units`}
          onClick={() => onNavigate('my-stock')}
        />
        <QuickShortcut
          icon={ShoppingCart}
          label="New Sale / Order"
          sub={`${salesOrders.length} orders`}
          onClick={() => onNavigate('my-sales')}
        />
        <QuickShortcut
          icon={Clock}
          label="Attendance History"
          sub={`${attendance.length} logs`}
          onClick={() => onNavigate('my-attendance')}
        />
      </div>
    </div>
  );
};

const QuickShortcut: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  sub: string;
  onClick: () => void;
}> = ({ icon: Icon, label, sub, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="bg-white border border-slate-200 hover:border-[#0F2744] rounded-xl p-4 text-left transition-colors flex items-center gap-3 min-h-[60px]"
  >
    <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-[#0F2744] shrink-0">
      <Icon className="w-5 h-5" />
    </div>
    <div className="min-w-0">
      <div className="text-sm font-semibold text-slate-900 truncate">{label}</div>
      <div className="text-xs text-slate-500 truncate">{sub}</div>
    </div>
  </button>
);
