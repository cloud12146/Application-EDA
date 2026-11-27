import React, { useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import {
  daysUntilDate,
  exportToCsv,
  formatCurrency,
  formatMinutesAsHours,
  formatTimestamp,
  tsToMs,
} from '../lib/utils';
import { formatCallLocationSummary } from '../lib/callLocation';
import {
  ActivityLog,
  AttendanceRecord,
  Customer,
  Distributor,
  DoctorCallRecord,
  Employee,
  LocationPing,
  PaymentRecord,
  Product,
  SalesOrder,
  TaskItem,
} from '../types/erp';

type ReportType =
  | 'attendance'
  | 'activity'
  | 'employee-task'
  | 'task-completion'
  | 'gps-visit'
  | 'doctor-calls'
  | 'sales'
  | 'stock'
  | 'batch'
  | 'expiry'
  | 'customer'
  | 'distributor'
  | 'payment';

const REPORT_OPTIONS: { id: ReportType; label: string }[] = [
  { id: 'attendance', label: 'Employee Attendance Report' },
  { id: 'activity', label: 'Employee Activity Report' },
  { id: 'employee-task', label: 'Employee Task Report' },
  { id: 'task-completion', label: 'Task Completion Report' },
  { id: 'gps-visit', label: 'GPS Work Visit Report' },
  { id: 'doctor-calls', label: 'Doctor Calls & Locations Report' },
  { id: 'sales', label: 'Sales Report' },
  { id: 'stock', label: 'Stock Report' },
  { id: 'batch', label: 'Batch Report' },
  { id: 'expiry', label: 'Expiry Report' },
  { id: 'customer', label: 'Customer Report' },
  { id: 'distributor', label: 'Distributor Report' },
  { id: 'payment', label: 'Payment Report' },
];

interface ReportsModuleProps {
  employees: Employee[];
  attendance: AttendanceRecord[];
  activities: ActivityLog[];
  tasks: TaskItem[];
  locations: LocationPing[];
  doctorCalls?: DoctorCallRecord[];
  salesOrders: SalesOrder[];
  products: Product[];
  customers: Customer[];
  distributors: Distributor[];
  payments: PaymentRecord[];
}

export const ReportsModule: React.FC<ReportsModuleProps> = ({
  employees,
  attendance,
  activities,
  tasks,
  locations,
  doctorCalls = [],
  salesOrders,
  products,
  customers,
  distributors,
  payments,
}) => {
  const [reportType, setReportType] = useState<ReportType>('attendance');
  const [empFilter, setEmpFilter] = useState('ALL');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const withinRange = (dateLike: any) => {
    const str =
      typeof dateLike === 'string'
        ? dateLike.slice(0, 10)
        : tsToMs(dateLike) > 0
        ? new Date(tsToMs(dateLike)).toISOString().slice(0, 10)
        : '';
    if (!str) return true;
    if (fromDate && str < fromDate) return false;
    if (toDate && str > toDate) return false;
    return true;
  };

  const { headers, rows } = useMemo(() => {
    switch (reportType) {
      case 'attendance': {
        const list = attendance.filter(
          (a) =>
            (empFilter === 'ALL' || a.userId === empFilter) && withinRange(a.date)
        );
        return {
          headers: ['Date', 'Employee', 'Department', 'Mode', 'Check In', 'Check Out', 'Hours', 'Status'],
          rows: list.map((a) => [
            a.date,
            a.employeeName,
            a.department || '',
            a.workMode,
            a.checkInTime || '',
            a.checkOutTime || '',
            formatMinutesAsHours(a.workingMinutes),
            a.status,
          ]),
        };
      }
      case 'activity': {
        const list = activities.filter(
          (a) =>
            (empFilter === 'ALL' || a.userId === empFilter) &&
            withinRange(a.createdAt)
        );
        return {
          headers: ['Timestamp', 'Employee', 'Action', 'Details'],
          rows: list.map((a) => [
            formatTimestamp(a.createdAt),
            a.employeeName,
            a.action,
            a.details,
          ]),
        };
      }
      case 'employee-task': {
        const list = tasks.filter(
          (t) =>
            (empFilter === 'ALL' || t.assignedToUid === empFilter) &&
            withinRange(t.startDate)
        );
        return {
          headers: ['Title', 'Assignee', 'Category', 'Priority', 'Deadline', 'Progress %', 'Status'],
          rows: list.map((t) => [
            t.title,
            t.assignedToName,
            t.category,
            t.priority,
            t.deadline,
            t.progressPct || 0,
            t.status,
          ]),
        };
      }
      case 'task-completion': {
        const list = tasks.filter(
          (t) =>
            ['Completed', 'Approved', 'Pending Approval'].includes(t.status) &&
            (empFilter === 'ALL' || t.assignedToUid === empFilter) &&
            withinRange(t.deadline)
        );
        return {
          headers: ['Task', 'Assignee', 'Deadline', 'Status', 'Completion Notes'],
          rows: list.map((t) => [
            t.title,
            t.assignedToName,
            t.deadline,
            t.status,
            t.completionNotes || '',
          ]),
        };
      }
      case 'gps-visit': {
        const list = locations.filter(
          (l) =>
            (empFilter === 'ALL' || l.userId === empFilter) &&
            withinRange(l.recordedAt)
        );
        return {
          headers: ['Timestamp', 'Employee', 'Territory', 'Customer / Note', 'Latitude', 'Longitude', 'Accuracy (m)', 'Geofence'],
          rows: list.map((l) => [
            formatTimestamp(l.recordedAt),
            l.employeeName,
            l.territory || '',
            l.customerName || l.note || '',
            l.lat.toFixed(5),
            l.lng.toFixed(5),
            Math.round(l.accuracy),
            l.withinGeofence ? 'Inside' : 'Outside',
          ]),
        };
      }
      case 'doctor-calls': {
        const list = doctorCalls.filter(
          (c) =>
            (empFilter === 'ALL' || c.employeeUid === empFilter) &&
            withinRange(c.callDate)
        );
        return {
          headers: ['Call Date', 'Employee', 'Doctor', 'Clinic', 'Call Location', 'GPS Coordinates', 'Outcome', 'Products Shown', 'Remarks'],
          rows: list.map((c) => {
            const loc = formatCallLocationSummary(c);
            return [
              c.callDate,
              c.employeeName,
              c.doctorName,
              c.clinicName || '',
              loc.label,
              loc.coordsText || 'Not Tagged',
              c.callOutcome,
              c.productsShown.join('; '),
              c.doctorRemark,
            ];
          }),
        };
      }
      case 'sales': {
        const list = salesOrders.filter(
          (o) =>
            (empFilter === 'ALL' || o.createdByUid === empFilter) &&
            withinRange(o.createdAt)
        );
        return {
          headers: ['Order #', 'Customer', 'Representative', 'Total', 'Paid', 'Pending', 'Order Status', 'Payment Status'],
          rows: list.map((o) => [
            o.orderNumber,
            o.customerBusiness || o.customerName,
            o.createdByName,
            formatCurrency(o.totalAmount),
            formatCurrency(o.paidAmount),
            formatCurrency(o.pendingAmount),
            o.orderStatus,
            o.paymentStatus,
          ]),
        };
      }
      case 'stock':
        return {
          headers: ['SKU', 'Product', 'Category', 'Warehouse', 'Opening', 'Available', 'Min Level', 'Selling Price'],
          rows: products.map((p) => [
            p.sku,
            p.name,
            p.category,
            p.warehouse || 'Central',
            p.openingStock,
            p.availableStock,
            p.minStockLevel,
            formatCurrency(p.sellingPrice),
          ]),
        };
      case 'batch':
        return {
          headers: ['Batch #', 'Product', 'SKU', 'Mfg Date', 'Expiry Date', 'Available Units', 'Warehouse'],
          rows: products.map((p) => [
            p.batchNumber,
            p.name,
            p.sku,
            p.mfgDate,
            p.expiryDate,
            p.availableStock,
            p.warehouse || 'Central',
          ]),
        };
      case 'expiry': {
        const list = [...products].sort(
          (a, b) => daysUntilDate(a.expiryDate) - daysUntilDate(b.expiryDate)
        );
        return {
          headers: ['Product', 'Batch #', 'Expiry Date', 'Days Remaining', 'Available Units', 'Alert'],
          rows: list.map((p) => {
            const d = daysUntilDate(p.expiryDate);
            return [
              p.name,
              p.batchNumber,
              p.expiryDate,
              d,
              p.availableStock,
              d <= 0 ? 'Expired' : d <= 90 ? 'Expiring ≤90d' : 'Valid',
            ];
          }),
        };
      }
      case 'customer': {
        const list = customers.filter(
          (c) => empFilter === 'ALL' || c.assignedEmployeeUid === empFilter
        );
        return {
          headers: ['Business Name', 'Contact', 'Category', 'City', 'Phone', 'Assigned Rep', 'Outstanding'],
          rows: list.map((c) => [
            c.businessName,
            c.name,
            c.category,
            c.city,
            c.phone,
            c.assignedEmployeeName,
            formatCurrency(c.outstandingBalance || 0),
          ]),
        };
      }
      case 'distributor':
        return {
          headers: ['Company', 'Contact Person', 'City', 'Region', 'GSTIN', 'Credit Limit', 'Outstanding', 'Status'],
          rows: distributors.map((d) => [
            d.companyName,
            d.contactPerson,
            d.city,
            d.region || '',
            d.gstNumber || '',
            formatCurrency(d.creditLimit || 0),
            formatCurrency(d.outstandingAmount || 0),
            d.status,
          ]),
        };
      case 'payment': {
        const list = payments.filter(
          (p) =>
            (empFilter === 'ALL' || p.collectedByUid === empFilter) &&
            withinRange(p.paymentDate)
        );
        return {
          headers: ['Date', 'Order #', 'Payer', 'Method', 'Reference', 'Collected By', 'Amount'],
          rows: list.map((p) => [
            p.paymentDate,
            p.orderNumber,
            p.payerName,
            p.method,
            p.referenceNo || '',
            p.collectedByName,
            formatCurrency(p.amount),
          ]),
        };
      }
    }
  }, [
    reportType,
    empFilter,
    fromDate,
    toDate,
    attendance,
    activities,
    tasks,
    locations,
    doctorCalls,
    salesOrders,
    products,
    customers,
    distributors,
    payments,
  ]);

  const activeTitle =
    REPORT_OPTIONS.find((r) => r.id === reportType)?.label || 'Report';

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 no-print">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            Reports & Business Analytics
          </h2>
          <p className="text-xs text-slate-500">
            Filter by date range or employee, print formatted sheets, or export CSV records.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#0F2744] bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
          >
            <Printer className="w-4 h-4" /> Print Report
          </button>
          <button
            type="button"
            onClick={() =>
              exportToCsv(`glacetor_${reportType}_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows)
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg"
          >
            <Download className="w-4 h-4" /> Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 no-print">
        <div>
          <label className="block text-[11px] font-medium text-slate-500 mb-1">
            Report Type
          </label>
          <select
            value={reportType}
            onChange={(e) => setReportType(e.target.value as ReportType)}
            className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white font-medium"
          >
            {REPORT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-slate-500 mb-1">
            Employee Filter
          </label>
          <select
            value={empFilter}
            onChange={(e) => setEmpFilter(e.target.value)}
            className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
          >
            <option value="ALL">All Employees</option>
            {employees.map((e) => (
              <option key={e.id} value={e.uid || e.id}>
                {e.fullName}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-slate-500 mb-1">
            From Date
          </label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
          />
        </div>

        <div>
          <label className="block text-[11px] font-medium text-slate-500 mb-1">
            To Date
          </label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
          />
        </div>
      </div>

      {/* Printable Header & Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <div className="text-xs font-bold text-[#0F2744]">
              GLACETOR REMEDIES PVT. LTD.
            </div>
            <h3 className="text-sm font-bold text-slate-900">{activeTitle}</h3>
          </div>
          <span className="text-xs font-mono text-slate-500">
            {rows.length} record(s)
          </span>
        </div>

        {rows.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            No records match the selected report filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  {headers.map((h) => (
                    <th key={h} className="px-4 py-3 font-semibold whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row, idx) => (
                  <tr key={idx} className="hover:bg-slate-50/70">
                    {row.map((cell, cIdx) => (
                      <td
                        key={cIdx}
                        className="px-4 py-2.5 text-slate-800 whitespace-nowrap font-mono tabular-nums"
                      >
                        {String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
