import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CreditCard,
  FileText,
  Package,
  Plus,
  ShoppingCart,
  Truck,
} from 'lucide-react';
import {
  AdminTab,
  Distributor,
  EmployeeTab,
  PaymentRecord,
  Product,
  SalesOrder,
  StockAllocation,
  StockMovement,
  UserAccount,
} from '../types/erp';
import {
  daysUntilDate,
  formatCurrency,
  formatTimestamp,
  generateId,
} from '../lib/utils';
import { createOrderWithOptionalStockDeduction } from '../lib/erpActions';

export const StockManagerDashboard: React.FC<{
  products: Product[];
  stockMovements: StockMovement[];
  onNavigate: (tab: AdminTab) => void;
}> = ({ products, stockMovements, onNavigate }) => {
  const totalUnits = products.reduce(
    (s, p) => s + (Number(p.availableStock) || 0),
    0
  );
  const lowStock = products.filter(
    (p) => (Number(p.availableStock) || 0) <= (Number(p.minStockLevel) || 0)
  );
  const expiringSoon = products.filter(
    (p) => daysUntilDate(p.expiryDate) <= 90
  );
  const pendingApprovals = stockMovements.filter(
    (m) => m.status === 'Pending Approval'
  );

  return (
    <div className="space-y-6">
      <div className="bg-[#0F2744] text-white rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <p className="text-xs text-slate-300">Warehouse & Batch Control</p>
          <h2 className="text-xl font-bold mt-0.5">Stock Manager Operations</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onNavigate('inventory')}
            className="px-4 py-2 text-xs font-semibold bg-[#16A34A] hover:bg-[#15803D] rounded-lg"
          >
            Receive / Issue Stock
          </button>
          <button
            type="button"
            onClick={() => onNavigate('stock-movements')}
            className="px-4 py-2 text-xs font-medium bg-white/10 hover:bg-white/20 rounded-lg"
          >
            Approve Movements ({pendingApprovals.length})
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatBox label="Active SKUs / Batches" value={products.length} icon={Package} />
        <StatBox label="Total Warehouse Units" value={totalUnits} icon={CheckCircle2} />
        <StatBox label="Low-Stock Batches" value={lowStock.length} icon={AlertTriangle} />
        <StatBox label="Expiring ≤ 90 Days" value={expiringSoon.length} icon={AlertTriangle} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-900">
              Low Stock & Expiry Watchlist
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('inventory')}
              className="text-xs font-medium text-[#0F2744] hover:underline inline-flex items-center gap-1"
            >
              Open Inventory <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          {[...lowStock, ...expiringSoon].slice(0, 6).length === 0 ? (
            <p className="text-xs text-slate-500 py-6 text-center">
              All batches are within healthy stock and expiry thresholds.
            </p>
          ) : (
            <div className="space-y-2.5">
              {[...new Map([...lowStock, ...expiringSoon].map((p) => [p.id, p])).values()]
                .slice(0, 6)
                .map((p) => (
                  <div
                    key={p.id}
                    className="p-3 rounded-lg border border-slate-200 flex items-center justify-between text-xs"
                  >
                    <div>
                      <div className="font-semibold text-slate-900">{p.name}</div>
                      <div className="text-slate-500">
                        Batch {p.batchNumber} · Exp {p.expiryDate}
                      </div>
                    </div>
                    <div className="text-right font-mono tabular-nums">
                      <div className="font-semibold text-amber-700">
                        {p.availableStock} {p.unit}
                      </div>
                      <div className="text-slate-400">Min: {p.minStockLevel}</div>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-900">
              Recent Stock Ledger
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('stock-movements')}
              className="text-xs font-medium text-[#0F2744] hover:underline inline-flex items-center gap-1"
            >
              All Movements <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          {stockMovements.length === 0 ? (
            <p className="text-xs text-slate-500 py-6 text-center">
              No stock movements logged yet.
            </p>
          ) : (
            <div className="space-y-2.5">
              {stockMovements.slice(0, 6).map((m) => (
                <div
                  key={m.id}
                  className="p-3 rounded-lg border border-slate-200 flex items-center justify-between text-xs"
                >
                  <div>
                    <div className="font-semibold text-slate-900">
                      {m.movementType} · {m.productName}
                    </div>
                    <div className="text-slate-500">
                      Batch {m.batchNumber} · {m.performedByName}
                    </div>
                  </div>
                  <div className="text-right font-mono tabular-nums">
                    <div className="font-semibold text-slate-900">{m.quantity} units</div>
                    <div className="text-slate-500">{m.status}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const DistributorDashboard: React.FC<{
  currentUser: UserAccount;
  distributorProfile?: Distributor;
  allocations: StockAllocation[];
  orders: SalesOrder[];
  payments: PaymentRecord[];
  products: Product[];
  onNavigate: (tab: EmployeeTab | AdminTab) => void;
}> = ({
  currentUser,
  distributorProfile,
  allocations,
  orders,
  payments,
  products,
}) => {
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [qty, setQty] = useState('10');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const handlePurchaseRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    const prod = products.find((p) => p.id === selectedProductId);
    if (!prod) {
      setErr('Please select a pharmaceutical product.');
      return;
    }
    const q = Math.max(1, Number(qty) || 1);
    const total = q * prod.sellingPrice;
    setSubmitting(true);
    try {
      const orderNum = `PO-DST-${Date.now().toString().slice(-5)}`;
      await createOrderWithOptionalStockDeduction({
        orderNumber: orderNum,
        customerId: distributorProfile?.id || `dist_${currentUser.uid}`,
        customerName: currentUser.displayName,
        customerBusiness:
          distributorProfile?.companyName || `${currentUser.displayName} Distribution`,
        distributorUid: currentUser.uid,
        createdByUid: currentUser.uid,
        createdByName: currentUser.displayName,
        items: [
          {
            productId: prod.id,
            productName: prod.name,
            batchNumber: prod.batchNumber,
            qty: q,
            unitPrice: prod.sellingPrice,
            lineTotal: total,
          },
        ],
        subtotal: total,
        discountPct: 0,
        discountAmount: 0,
        totalAmount: total,
        orderType: 'Distributor Purchase',
        notes: notes.trim() || 'Distributor purchase request',
        autoApproveAndDeduct: false,
      });
      setMsg(`Purchase request ${orderNum} submitted for Admin/Stock approval.`);
      setShowRequestForm(false);
      setNotes('');
    } catch (error: any) {
      setErr(error?.message || 'Failed to submit purchase request.');
    } finally {
      setSubmitting(false);
    }
  };

  const totalPending = orders.reduce(
    (s, o) => s + (Number(o.pendingAmount) || 0),
    0
  );

  return (
    <div className="space-y-6">
      <div className="bg-[#0F2744] text-white rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <p className="text-xs text-slate-300">Authorized Distributor Portal</p>
          <h2 className="text-xl font-bold mt-0.5">
            {distributorProfile?.companyName || currentUser.displayName}
          </h2>
          <p className="text-xs text-slate-300 mt-1">
            {distributorProfile?.city || 'Regional Channel Partner'} · Credit Limit:{' '}
            {formatCurrency(distributorProfile?.creditLimit || 0)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowRequestForm((v) => !v)}
          className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold bg-[#16A34A] hover:bg-[#15803D] rounded-lg min-h-[44px]"
        >
          <Plus className="w-4 h-4" />
          New Purchase Request
        </button>
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

      {showRequestForm && (
        <form
          onSubmit={handlePurchaseRequest}
          className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-900">
            Create Distributor Purchase Request
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Product & Batch
              </label>
              <select
                required
                value={selectedProductId}
                onChange={(e) => setSelectedProductId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              >
                <option value="">Select pharmaceutical product...</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (Batch {p.batchNumber} · {formatCurrency(p.sellingPrice)}/{p.unit})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Quantity
              </label>
              <input
                type="number"
                min={1}
                required
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Dispatch Notes
            </label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Preferred transport / cold-chain instruction"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowRequestForm(false)}
              className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
            >
              {submitting ? 'Submitting...' : 'Submit Purchase Request'}
            </button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatBox
          label="Allocated Stock Units"
          value={allocations.reduce((s, a) => s + a.remainingQty, 0)}
          icon={Package}
        />
        <StatBox label="My Orders" value={orders.length} icon={ShoppingCart} />
        <StatBox
          label="In Transit / Dispatched"
          value={orders.filter((o) => o.orderStatus === 'Dispatched').length}
          icon={Truck}
        />
        <StatBox
          label="Outstanding Payable"
          value={formatCurrency(totalPending)}
          icon={CreditCard}
        />
      </div>

      {/* Allocated Stock */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-slate-900 mb-3">
          My Allocated Inventory
        </h3>
        {allocations.length === 0 ? (
          <p className="text-xs text-slate-500 py-4">No stock allocated yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 font-medium">Product</th>
                  <th className="py-2 font-medium">Batch</th>
                  <th className="py-2 font-medium text-right">Allocated</th>
                  <th className="py-2 font-medium text-right">Sold</th>
                  <th className="py-2 font-medium text-right">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100">
                    <td className="py-2.5 font-medium text-slate-900">{a.productName}</td>
                    <td className="py-2.5 font-mono text-slate-600">{a.batchNumber}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums">{a.allocatedQty}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums">{a.soldQty}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums font-semibold text-[#15803D]">
                      {a.remainingQty}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Orders & Payment Records */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2">
            <FileText className="w-4 h-4 text-[#0F2744]" />
            Orders & Delivery Status
          </h3>
          {orders.length === 0 ? (
            <p className="text-xs text-slate-500 py-4">No orders yet.</p>
          ) : (
            <div className="space-y-2.5">
              {orders.map((o) => (
                <div
                  key={o.id}
                  className="p-3 rounded-lg border border-slate-200 flex items-center justify-between text-xs"
                >
                  <div>
                    <div className="font-semibold text-slate-900 font-mono">
                      {o.orderNumber}
                    </div>
                    <div className="text-slate-500">
                      {o.items.length} item(s) · {formatTimestamp(o.createdAt)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-[#0F2744]">{o.orderStatus}</div>
                    <div className="font-mono tabular-nums text-slate-700">
                      {formatCurrency(o.totalAmount)} ({o.paymentStatus})
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">
            My Payment Records
          </h3>
          {payments.length === 0 ? (
            <p className="text-xs text-slate-500 py-4">No payment receipts logged yet.</p>
          ) : (
            <div className="space-y-2.5">
              {payments.map((p) => (
                <div
                  key={p.id}
                  className="p-3 rounded-lg border border-slate-200 flex items-center justify-between text-xs"
                >
                  <div>
                    <div className="font-semibold text-slate-900 font-mono">
                      {p.orderNumber}
                    </div>
                    <div className="text-slate-500">
                      {p.method} · {p.paymentDate}
                    </div>
                  </div>
                  <div className="font-mono tabular-nums font-semibold text-[#15803D]">
                    {formatCurrency(p.amount)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const StatBox: React.FC<{
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
}> = ({ label, value, icon: Icon }) => (
  <div className="bg-white border border-slate-200 rounded-xl p-4">
    <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
      <span>{label}</span>
      <Icon className="w-4 h-4 text-slate-400" />
    </div>
    <div className="text-xl font-bold font-mono tabular-nums text-slate-900">
      {value}
    </div>
  </div>
);
