import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarCheck,
  CheckCircle2,
  ClipboardList,
  Clock,
  IndianRupee,
  MapPin,
  Package,
  ShoppingCart,
  Users,
} from 'lucide-react';
import {
  AdminTab,
  AttendanceRecord,
  CompanySettings,
  DoctorCallRecord,
  Employee,
  LeaveRequest,
  LocationPing,
  Product,
  SalesOrder,
  StockMovement,
  TaskItem,
} from '../types/erp';
import {
  currentMonthKey,
  daysUntilDate,
  formatCurrency,
  todayIsoDate,
  tsToMs,
} from '../lib/utils';
import {
  BreakdownProgressCard,
  PerformanceTrendDatum,
  PerformanceTrendsCard,
  RevenueBarChart,
} from '../components/DashboardCharts';
import { getLatestLocationsByUser } from '../lib/mapClustering';
import { getLivePingStatusInfo } from '../lib/liveLocation';

interface AdminDashboardProps {
  employees: Employee[];
  attendance: AttendanceRecord[];
  locations: LocationPing[];
  doctorCalls?: DoctorCallRecord[];
  tasks: TaskItem[];
  products: Product[];
  salesOrders: SalesOrder[];
  leaveRequests: LeaveRequest[];
  stockMovements: StockMovement[];
  settings: CompanySettings | null;
  onNavigate: (tab: AdminTab) => void;
  onCheckLiveLocation?: (employeeUid: string) => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  employees,
  attendance,
  locations,
  doctorCalls = [],
  tasks,
  products,
  salesOrders,
  leaveRequests,
  stockMovements,
  settings,
  onNavigate,
  onCheckLiveLocation,
}) => {
  const today = todayIsoDate();
  const monthKey = currentMonthKey();
  const expiryThresholdDays = settings?.expiryAlertDays || 90;

  // Workforce & Attendance metrics
  const totalEmployees = employees.length;
  const activeEmployees = employees.filter((e) => e.status === 'Active').length;
  const todayAtt = attendance.filter((a) => a.date === today);
  const presentEmployees = todayAtt.filter(
    (a) => a.status === 'Present' || a.status === 'Late'
  ).length;
  const absentEmployees = Math.max(0, activeEmployees - presentEmployees);
  const onDutyEmployees = todayAtt.filter((a) => a.checkInTime && !a.checkOutTime).length;

  const nowMs = Date.now();
  const latestNonDemoPings = getLatestLocationsByUser(
    locations.filter((l) => !l.isDemo)
  );
  const liveEmployeePings = latestNonDemoPings.filter(
    (l) => l.trackingActive && l.status !== 'Checked Out'
  );
  const trackingCount = liveEmployeePings.length;

  // Tasks metrics
  const todaysTasks = tasks.filter(
    (t) => t.startDate === today || t.deadline === today
  ).length;
  const pendingTasks = tasks.filter((t) =>
    ['Assigned', 'Accepted', 'In Progress', 'Pending Approval'].includes(t.status)
  ).length;
  const completedTasks = tasks.filter((t) =>
    ['Completed', 'Approved'].includes(t.status)
  ).length;
  const overdueTasks = tasks.filter(
    (t) =>
      t.status === 'Overdue' ||
      (t.deadline < today &&
        !['Completed', 'Approved', 'Cancelled'].includes(t.status))
  ).length;

  // Inventory metrics
  const totalProducts = products.length;
  const totalStockUnits = products.reduce(
    (sum, p) => sum + (Number(p.availableStock) || 0),
    0
  );
  const lowStockProducts = products.filter(
    (p) => (Number(p.availableStock) || 0) <= (Number(p.minStockLevel) || 0)
  ).length;
  const expiringProducts = products.filter(
    (p) => daysUntilDate(p.expiryDate) <= expiryThresholdDays
  ).length;

  // Commercial & Sales metrics
  const activeOrders = salesOrders.filter((o) => o.orderStatus !== 'Cancelled');
  const todaySales = activeOrders
    .filter((o) => {
      const ms = tsToMs(o.createdAt);
      return ms > 0 && new Date(ms).toISOString().slice(0, 10) === today;
    })
    .reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);

  const monthlySales = activeOrders
    .filter((o) => {
      const ms = tsToMs(o.createdAt);
      return ms > 0 && new Date(ms).toISOString().slice(0, 7) === monthKey;
    })
    .reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);

  const pendingOrders = salesOrders.filter((o) => o.orderStatus === 'Pending').length;
  const pendingPaymentsAmount = activeOrders.reduce(
    (sum, o) => sum + (Number(o.pendingAmount) || 0),
    0
  );

  // Pending approvals
  const pendingLeaves = leaveRequests.filter((l) => l.status === 'Pending').length;
  const pendingStockApprovals = stockMovements.filter(
    (m) => m.status === 'Pending Approval'
  ).length;
  const tasksAwaitingApproval = tasks.filter(
    (t) => t.status === 'Pending Approval' || t.status === 'Completed'
  ).length;

  // Chart series (last 6 months or grouped orders)
  const monthBuckets = new Map<string, { billed: number; collected: number }>();
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    monthBuckets.set(key, { billed: 0, collected: 0 });
  }
  activeOrders.forEach((o) => {
    const ms = tsToMs(o.createdAt);
    const key = ms ? new Date(ms).toISOString().slice(0, 7) : monthKey;
    if (monthBuckets.has(key)) {
      const prev = monthBuckets.get(key)!;
      prev.billed += Number(o.totalAmount) || 0;
      prev.collected += Number(o.paidAmount) || 0;
    }
  });
  const chartData = Array.from(monthBuckets.entries()).map(([k, v]) => ({
    label: k.slice(5) + '/' + k.slice(2, 4),
    value: v.billed,
    secondary: v.collected,
  }));

  // Last 7 days daily sales & total visit counts (Customer GPS visits + Doctor calls)
  const sevenDayBuckets = new Map<string, PerformanceTrendDatum>();
  for (let i = 6; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000);
    const iso = dt.toISOString().slice(0, 10);
    const dayLabel =
      i === 0
        ? 'Today'
        : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    sevenDayBuckets.set(iso, {
      date: iso,
      dayLabel,
      sales: 0,
      visits: 0,
      customerVisits: 0,
      doctorCalls: 0,
    });
  }

  activeOrders.forEach((o) => {
    const ms = tsToMs(o.createdAt);
    if (!ms) return;
    const key = new Date(ms).toISOString().slice(0, 10);
    const bucket = sevenDayBuckets.get(key);
    if (bucket) {
      bucket.sales += Number(o.totalAmount) || 0;
    }
  });

  locations.forEach((l) => {
    if (l.status !== 'Customer Visit') return;
    const ms = tsToMs(l.recordedAt);
    if (!ms) return;
    const key = new Date(ms).toISOString().slice(0, 10);
    const bucket = sevenDayBuckets.get(key);
    if (bucket) {
      bucket.customerVisits += 1;
      bucket.visits += 1;
    }
  });

  doctorCalls.forEach((c) => {
    const key =
      c.callDate ||
      (tsToMs(c.createdAt) ? new Date(tsToMs(c.createdAt)).toISOString().slice(0, 10) : '');
    const bucket = key ? sevenDayBuckets.get(key) : undefined;
    if (bucket) {
      bucket.doctorCalls += 1;
      bucket.visits += 1;
    }
  });

  const performance7dData = Array.from(sevenDayBuckets.values());

  return (
    <div className="space-y-6">
      {/* Top Executive Action Strip */}
      <div className="bg-[#0F2744] text-white rounded-xl p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <p className="text-xs text-slate-300 font-medium">
            Glacetor Remedies Pvt. Ltd. · Command Center
          </p>
          <h2 className="text-lg md:text-xl font-bold tracking-tight mt-0.5">
            Company Operations Overview
          </h2>
          <p className="text-xs text-slate-300 mt-1">
            Date: <span className="font-mono">{today}</span> · Real-time Firestore ERP Ledger
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate('live-location')}
            className="px-3.5 py-2 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors whitespace-nowrap"
          >
            Live Map ({trackingCount})
          </button>
          <button
            type="button"
            onClick={() => onNavigate('tasks')}
            className="px-3.5 py-2 text-xs font-medium bg-[#16A34A] hover:bg-[#15803D] text-white rounded-lg transition-colors whitespace-nowrap"
          >
            Assign Task
          </button>
        </div>
      </div>

      {/* Section 1: Workforce & Attendance */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-800">
            01. Workforce & Field Attendance
          </h3>
          <button
            type="button"
            onClick={() => onNavigate('attendance')}
            className="text-xs font-medium text-[#0F2744] hover:underline inline-flex items-center gap-1"
          >
            Attendance Register <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
          <KpiTile label="Total Employees" value={totalEmployees} icon={Users} />
          <KpiTile label="Active Staff" value={activeEmployees} icon={CheckCircle2} tone="green" />
          <KpiTile label="Present Today" value={presentEmployees} icon={CalendarCheck} tone="green" />
          <KpiTile label="Absent Today" value={absentEmployees} icon={Clock} tone="amber" />
          <KpiTile label="Currently On Duty" value={onDutyEmployees} icon={Clock} tone="navy" />
          <KpiTile
            label="Tracking GPS"
            value={trackingCount}
            icon={MapPin}
            tone="green"
            onClick={() => onNavigate('live-location')}
          />
          <KpiTile label="Today Attendance" value={todayAtt.length} icon={CalendarCheck} />
        </div>

        {liveEmployeePings.length > 0 && (
          <div className="mt-3 bg-white border border-emerald-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#15803D]">
              <span className="w-2 h-2 rounded-full bg-[#15803D] animate-pulse" />
              <span>Live Employees Sharing GPS ({liveEmployeePings.length}):</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {liveEmployeePings.slice(0, 8).map((ping) => {
                const info = getLivePingStatusInfo(ping, nowMs);
                return (
                  <button
                    key={ping.userId}
                    type="button"
                    onClick={() =>
                      onCheckLiveLocation
                        ? onCheckLiveLocation(ping.userId)
                        : onNavigate('live-location')
                    }
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold bg-emerald-50 hover:bg-emerald-100 text-[#0F2744] border border-emerald-200 rounded-lg transition-colors"
                  >
                    <MapPin className="w-3 h-3 text-[#15803D]" />
                    <span>{ping.employeeName}</span>
                    <span className="text-[10px] font-mono text-emerald-700">
                      {info.ageLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Section 2: Task Assignment Status */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-800">
            02. Field & Operational Tasks
          </h3>
          <button
            type="button"
            onClick={() => onNavigate('tasks')}
            className="text-xs font-medium text-[#0F2744] hover:underline inline-flex items-center gap-1"
          >
            Manage Tasks <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiTile label="Today's Assigned Tasks" value={todaysTasks} icon={ClipboardList} />
          <KpiTile label="Pending Tasks" value={pendingTasks} icon={Clock} tone="amber" />
          <KpiTile label="Completed Tasks" value={completedTasks} icon={CheckCircle2} tone="green" />
          <KpiTile label="Overdue Tasks" value={overdueTasks} icon={AlertTriangle} tone="red" />
        </div>
      </div>

      {/* Section 3: Pharmaceutical Inventory & Sales */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-800">
              03. Pharmaceutical Inventory
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('inventory')}
              className="text-xs font-medium text-[#0F2744] hover:underline inline-flex items-center gap-1"
            >
              Stock Ledger <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <KpiTile label="Total Products" value={totalProducts} icon={Package} />
            <KpiTile label="Total Available Stock" value={totalStockUnits} icon={Package} tone="navy" />
            <KpiTile label="Low-Stock Alerts" value={lowStockProducts} icon={AlertTriangle} tone="amber" />
            <KpiTile label="Expiring Soon" value={expiringProducts} icon={AlertTriangle} tone="red" />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-800">
              04. Commercial Sales & Collections
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('orders')}
              className="text-xs font-medium text-[#0F2744] hover:underline inline-flex items-center gap-1"
            >
              Orders & Payments <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <KpiTile
              label="Today's Sales"
              value={formatCurrency(todaySales)}
              icon={IndianRupee}
              tone="green"
            />
            <KpiTile
              label="Monthly Sales"
              value={formatCurrency(monthlySales)}
              icon={IndianRupee}
              tone="navy"
            />
            <KpiTile label="Pending Orders" value={pendingOrders} icon={ShoppingCart} tone="amber" />
            <KpiTile
              label="Pending Payments"
              value={formatCurrency(pendingPaymentsAmount)}
              icon={IndianRupee}
              tone="red"
            />
          </div>
        </div>
      </div>

      {/* 7-Day Recharts Performance Trends */}
      <PerformanceTrendsCard data={performance7dData} />

      {/* Charts & Approval Queue */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <RevenueBarChart
            title="Monthly Sales vs. Collections (6-Month Trend)"
            data={chartData}
          />
        </div>
        <BreakdownProgressCard
          title="Task Execution Breakdown"
          items={[
            { label: 'Completed / Approved', count: completedTasks, colorClass: 'bg-[#16A34A]' },
            { label: 'Active / Pending', count: pendingTasks, colorClass: 'bg-[#0F2744]' },
            { label: 'Overdue', count: overdueTasks, colorClass: 'bg-red-600' },
          ]}
        />
      </div>

      {/* Pending Action Queue */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-slate-900 mb-3">
          Operational Approvals Queue
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <ApprovalRow
            title="Leave Requests"
            count={pendingLeaves}
            onClick={() => onNavigate('attendance')}
          />
          <ApprovalRow
            title="Task Completions"
            count={tasksAwaitingApproval}
            onClick={() => onNavigate('tasks')}
          />
          <ApprovalRow
            title="Stock Adjustments"
            count={pendingStockApprovals}
            onClick={() => onNavigate('stock-movements')}
          />
          <ApprovalRow
            title="Pending Orders"
            count={pendingOrders}
            onClick={() => onNavigate('orders')}
          />
        </div>
      </div>
    </div>
  );
};

const KpiTile: React.FC<{
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'default' | 'navy' | 'green' | 'amber' | 'red';
  onClick?: () => void;
}> = ({ label, value, icon: Icon, tone = 'default', onClick }) => {
  const toneClasses: Record<string, string> = {
    default: 'text-slate-900',
    navy: 'text-[#0F2744]',
    green: 'text-[#15803D]',
    amber: 'text-amber-700',
    red: 'text-red-700',
  };

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="bg-white border border-slate-200 hover:border-[#0F2744] rounded-xl p-4 flex flex-col justify-between text-left transition-colors"
      >
        <div className="flex items-center justify-between gap-2 mb-2 w-full">
          <span className="text-xs font-medium text-slate-500 leading-tight">{label}</span>
          <Icon className="w-4 h-4 text-slate-400 shrink-0" />
        </div>
        <div className={`text-lg md:text-xl font-bold font-mono tabular-nums ${toneClasses[tone]}`}>
          {value}
        </div>
      </button>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-medium text-slate-500 leading-tight">{label}</span>
        <Icon className="w-4 h-4 text-slate-400 shrink-0" />
      </div>
      <div className={`text-lg md:text-xl font-bold font-mono tabular-nums ${toneClasses[tone]}`}>
        {value}
      </div>
    </div>
  );
};

const ApprovalRow: React.FC<{
  title: string;
  count: number;
  onClick: () => void;
}> = ({ title, count, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex items-center justify-between p-3.5 rounded-lg border border-slate-200 hover:border-[#0F2744] hover:bg-slate-50 transition-colors text-left"
  >
    <div>
      <div className="text-xs font-medium text-slate-500">{title}</div>
      <div className="text-lg font-bold font-mono tabular-nums text-slate-900 mt-0.5">
        {count}
      </div>
    </div>
    <ArrowRight className="w-4 h-4 text-slate-400" />
  </button>
);
