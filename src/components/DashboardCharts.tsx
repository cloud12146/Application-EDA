import React from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency } from '../lib/utils';

interface BarDatum {
  label: string;
  value: number;
  secondary?: number;
}

export interface PerformanceTrendDatum {
  date: string;
  dayLabel: string;
  sales: number;
  visits: number;
  customerVisits: number;
  doctorCalls: number;
}

function formatCompactInr(val: number): string {
  if (val >= 100000) return `₹${(val / 100000).toFixed(1)}L`;
  if (val >= 1000) return `₹${(val / 1000).toFixed(0)}k`;
  return `₹${val}`;
}

export const PerformanceTrendsCard: React.FC<{
  data: PerformanceTrendDatum[];
}> = ({ data }) => {
  const totalSales = data.reduce((sum, d) => sum + d.sales, 0);
  const totalVisits = data.reduce((sum, d) => sum + d.visits, 0);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Performance Trends</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Last 7 Days · Daily Sales &amp; Total Field Visits
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-5 text-xs">
          <div>
            <span className="text-slate-500 block text-[11px]">7-Day Sales</span>
            <span className="font-bold font-mono tabular-nums text-[#0F2744]">
              {formatCurrency(totalSales)}
            </span>
          </div>
          <div>
            <span className="text-slate-500 block text-[11px]">7-Day Visits</span>
            <span className="font-bold font-mono tabular-nums text-[#15803D]">
              {totalVisits} visits
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-slate-600 pl-2 border-l border-slate-200">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-[#0F2744]" />
              Sales (₹)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-[#16A34A] rounded" />
              Visits
            </span>
          </div>
        </div>
      </div>

      <div className="h-64 w-full min-w-0">
        <ResponsiveContainer width="100%" height={256} minWidth={0}>
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
            <XAxis
              dataKey="dayLabel"
              tick={{ fontSize: 11, fill: '#64748B' }}
              axisLine={{ stroke: '#E2E8F0' }}
              tickLine={false}
            />
            <YAxis
              yAxisId="sales"
              domain={[0, totalSales === 0 ? 1000 : 'auto']}
              tickFormatter={formatCompactInr}
              tick={{ fontSize: 11, fill: '#64748B' }}
              axisLine={false}
              tickLine={false}
              width={54}
            />
            <YAxis
              yAxisId="visits"
              orientation="right"
              allowDecimals={false}
              domain={[0, totalVisits === 0 ? 4 : 'auto']}
              tick={{ fontSize: 11, fill: '#15803D' }}
              axisLine={false}
              tickLine={false}
              width={36}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload || payload.length === 0) return null;
                const row = payload[0]?.payload as PerformanceTrendDatum | undefined;
                if (!row) return null;
                return (
                  <div className="bg-white border border-slate-200 rounded-xl shadow-md px-3.5 py-2.5 text-xs space-y-1">
                    <div className="font-semibold text-slate-900 font-mono">
                      {row.dayLabel} · {row.date}
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-slate-600">Daily Sales</span>
                      <span className="font-bold font-mono tabular-nums text-[#0F2744]">
                        {formatCurrency(row.sales)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-slate-600">Total Visits</span>
                      <span className="font-bold font-mono tabular-nums text-[#15803D]">
                        {row.visits}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 pt-0.5 border-t border-slate-100">
                      {row.customerVisits} customer GPS · {row.doctorCalls} doctor calls
                    </div>
                  </div>
                );
              }}
            />
            <Bar
              yAxisId="sales"
              dataKey="sales"
              name="Daily Sales"
              fill="#0F2744"
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
            />
            <Line
              yAxisId="visits"
              type="monotone"
              dataKey="visits"
              name="Total Visits"
              stroke="#16A34A"
              strokeWidth={2.5}
              dot={{ r: 3.5, fill: '#16A34A', strokeWidth: 2, stroke: '#FFFFFF' }}
              activeDot={{ r: 5, fill: '#15803D', strokeWidth: 2, stroke: '#FFFFFF' }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {totalSales === 0 && totalVisits === 0 && (
        <p className="text-xs text-slate-400 text-center">
          No sales orders or field visits recorded in the last 7 days yet.
        </p>
      )}
    </div>
  );
};

export const RevenueBarChart: React.FC<{ data: BarDatum[]; title: string }> = ({
  data,
  title,
}) => {
  const maxVal = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <div className="flex items-center gap-4 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#0F2744]" />
            Billed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#16A34A]" />
            Collected
          </span>
        </div>
      </div>

      {data.length === 0 ? (
        <div className="h-44 flex items-center justify-center text-xs text-slate-400">
          No revenue entries yet
        </div>
      ) : (
        <div className="grid grid-cols-6 gap-3 items-end h-44 pt-4">
          {data.map((item) => {
            const hPrimary = Math.max(6, Math.round((item.value / maxVal) * 100));
            const hSecondary =
              typeof item.secondary === 'number'
                ? Math.max(4, Math.round((item.secondary / maxVal) * 100))
                : 0;
            return (
              <div
                key={item.label}
                className="flex flex-col items-center h-full justify-end group"
              >
                <div className="w-full flex items-end justify-center gap-1 h-32">
                  <div
                    title={`Billed: ${formatCurrency(item.value)}`}
                    style={{ height: `${hPrimary}%` }}
                    className="w-3.5 md:w-4 bg-[#0F2744] rounded-t transition-all group-hover:bg-[#1e4370]"
                  />
                  {typeof item.secondary === 'number' && (
                    <div
                      title={`Collected: ${formatCurrency(item.secondary)}`}
                      style={{ height: `${hSecondary}%` }}
                      className="w-3.5 md:w-4 bg-[#16A34A] rounded-t transition-all"
                    />
                  )}
                </div>
                <span className="mt-2 text-[11px] font-medium text-slate-500 truncate max-w-full tabular-nums">
                  {item.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const BreakdownProgressCard: React.FC<{
  title: string;
  items: { label: string; count: number; colorClass: string }[];
}> = ({ title, items }) => {
  const total = Math.max(
    items.reduce((acc, i) => acc + i.count, 0),
    1
  );

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-slate-900 mb-4">{title}</h3>
      <div className="space-y-3">
        {items.map((item) => {
          const pct = Math.round((item.count / total) * 100);
          return (
            <div key={item.label}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-slate-600 font-medium">{item.label}</span>
                <span className="font-mono tabular-nums text-slate-900 font-semibold">
                  {item.count} ({pct}%)
                </span>
              </div>
              <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${item.colorClass}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
