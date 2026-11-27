import React, { useState } from 'react';
import { Bell, CheckCheck, Info } from 'lucide-react';
import { NotificationItem } from '../types/erp';
import { markNotificationRead } from '../lib/erpActions';
import { formatTimestamp } from '../lib/utils';

export const NotificationsModule: React.FC<{
  notifications: NotificationItem[];
}> = ({ notifications }) => {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [catFilter, setCatFilter] = useState<string>('ALL');

  const visible = notifications.filter((n) => {
    if (filter === 'unread' && n.isRead) return false;
    if (catFilter !== 'ALL' && n.category !== catFilter) return false;
    return true;
  });

  const handleMarkAllRead = async () => {
    const unread = notifications.filter((n) => !n.isRead);
    for (const item of unread) {
      await markNotificationRead(item.id);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Notification Center</h2>
          <p className="text-xs text-slate-500">
            In-app operational alerts for tasks, attendance, stock expiry, orders, and payments.
          </p>
        </div>

        <button
          type="button"
          onClick={handleMarkAllRead}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#0F2744] bg-white border border-slate-200 hover:bg-slate-50 rounded-lg self-start"
        >
          <CheckCheck className="w-4 h-4" />
          Mark All Read
        </button>
      </div>

      <div className="bg-slate-100 border border-slate-200 rounded-lg p-3.5 text-xs text-slate-700 flex items-start gap-2.5">
        <Info className="w-4 h-4 text-[#0F2744] shrink-0 mt-0.5" />
        <span>
          Real-time in-app Firestore notifications are active. Push delivery via Firebase Cloud Messaging (FCM) activates automatically once a Web Push VAPID key and service worker messaging config are attached in Firebase Console.
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${
              filter === 'all' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            All ({notifications.length})
          </button>
          <button
            type="button"
            onClick={() => setFilter('unread')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${
              filter === 'unread' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Unread ({notifications.filter((n) => !n.isRead).length})
          </button>
        </div>

        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
        >
          <option value="ALL">All Categories</option>
          <option value="Task">Task</option>
          <option value="Attendance">Attendance</option>
          <option value="Inventory">Inventory</option>
          <option value="Order">Order</option>
          <option value="Payment">Payment</option>
          <option value="Leave">Leave</option>
        </select>
      </div>

      {visible.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <Bell className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <div className="text-sm font-medium text-slate-700">No notifications</div>
          <p className="text-xs text-slate-400 mt-1">
            You are caught up on all operational alerts.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
          {visible.map((n) => (
            <div
              key={n.id}
              className={`p-4 flex items-start justify-between gap-4 ${
                n.isRead ? 'bg-white' : 'bg-slate-50/80'
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                  <span className="font-semibold text-[#0F2744]">{n.category}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{formatTimestamp(n.createdAt)}</span>
                  {!n.isRead && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-[#15803D] font-semibold">New</span>
                    </>
                  )}
                </div>
                <div className="text-sm font-semibold text-slate-900">{n.title}</div>
                <p className="text-xs text-slate-600 mt-0.5">{n.message}</p>
              </div>
              {!n.isRead && (
                <button
                  type="button"
                  onClick={() => markNotificationRead(n.id)}
                  className="px-3 py-1.5 text-xs font-medium text-[#0F2744] border border-slate-200 rounded-lg hover:bg-white shrink-0"
                >
                  Mark Read
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
