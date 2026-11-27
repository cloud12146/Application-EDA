import React, { useMemo, useState } from 'react';
import { Activity, ExternalLink, MapPin, Search } from 'lucide-react';
import { buildGoogleMapsUrl } from '../lib/callLocation';
import { formatTimestamp } from '../lib/utils';
import { ActivityLog, Employee } from '../types/erp';

export const ActivityModule: React.FC<{
  isAdminView: boolean;
  activities: ActivityLog[];
  employees: Employee[];
}> = ({ isAdminView, activities, employees }) => {
  const [search, setSearch] = useState('');
  const [empFilter, setEmpFilter] = useState('ALL');
  const [actionFilter, setActionFilter] = useState('ALL');

  const actions = Array.from(new Set(activities.map((a) => a.action)));

  const filtered = useMemo(() => {
    return activities.filter((a) => {
      if (isAdminView && empFilter !== 'ALL' && a.userId !== empFilter) return false;
      if (actionFilter !== 'ALL' && a.action !== actionFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          a.employeeName.toLowerCase().includes(q) ||
          a.action.toLowerCase().includes(q) ||
          a.details.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [activities, isAdminView, empFilter, actionFilter, search]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-slate-900">
          {isAdminView ? 'Company Activity & Audit Timeline' : 'My Work Activity Timeline'}
        </h2>
        <p className="text-xs text-slate-500">
          Work-related audit log covering attendance, tasks, customer visits, orders, and stock transactions.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search activity logs..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg"
          />
        </div>
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
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
        >
          <option value="ALL">All Actions</option>
          {actions.map((act) => (
            <option key={act} value={act}>
              {act}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <Activity className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <div className="text-sm font-medium text-slate-700">No activity recorded yet</div>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
          {filtered.slice(0, 100).map((log) => (
            <div
              key={log.id}
              className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[#0F2744]">{log.action}</span>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span className="font-medium text-slate-800">{log.employeeName}</span>
                </div>
                <p className="text-slate-600 mt-0.5">{log.details}</p>
                {typeof log.lat === 'number' && typeof log.lng === 'number' && (
                  <div className="mt-1 inline-flex items-center gap-2 text-[11px] text-slate-500 font-mono">
                    <span className="inline-flex items-center gap-1 text-[#15803D]">
                      <MapPin className="w-3 h-3" />
                      {log.lat.toFixed(4)}, {log.lng.toFixed(4)}
                    </span>
                    <a
                      href={buildGoogleMapsUrl(log.lat, log.lng)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 font-sans font-semibold text-[#0F2744] hover:underline"
                    >
                      View Map <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                )}
              </div>
              <div className="font-mono text-[11px] text-slate-400 whitespace-nowrap">
                {formatTimestamp(log.createdAt)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
