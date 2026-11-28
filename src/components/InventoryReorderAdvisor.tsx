import React, { useMemo, useState } from 'react';
import { doc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { buildApiUrl } from '../lib/apiClient';
import { logActivity } from '../lib/erpActions';
import { formatTimestamp, tsToMs } from '../lib/utils';
import {
  Product,
  SalesOrder,
  StockMovement,
  UserAccount,
} from '../types/erp';

interface ReorderSuggestion {
  productId: string;
  sku: string;
  productName: string;
  currentMinStockLevel: number;
  suggestedReorderPoint: number;
  suggestedOrderQty: number;
  urgency: 'Critical' | 'High' | 'Moderate' | 'Healthy' | string;
  estimatedDaysOfStock: number;
  trendSummary: string;
  rationale: string;
}

interface ReorderAnalysisResult {
  model: string;
  leadTimeDays: number;
  safetyDays: number;
  generatedAt: string;
  executiveSummary: string;
  suggestions: ReorderSuggestion[];
}

interface InventoryReorderAdvisorProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserAccount;
  products: Product[];
  salesOrders: SalesOrder[];
  stockMovements: StockMovement[];
}

const URGENCY_ORDER: Record<string, number> = {
  Critical: 0,
  High: 1,
  Moderate: 2,
  Healthy: 3,
};

const URGENCY_BADGE: Record<string, string> = {
  Critical: 'bg-red-50 text-red-700 border-red-200',
  High: 'bg-amber-50 text-amber-800 border-amber-200',
  Moderate: 'bg-sky-50 text-sky-800 border-sky-200',
  Healthy: 'bg-emerald-50 text-emerald-800 border-emerald-200',
};

export const InventoryReorderAdvisor: React.FC<InventoryReorderAdvisorProps> = ({
  isOpen,
  onClose,
  currentUser,
  products,
  salesOrders,
  stockMovements,
}) => {
  const [leadTimeDays, setLeadTimeDays] = useState('7');
  const [safetyDays, setSafetyDays] = useState('7');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReorderAnalysisResult | null>(null);
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyingAll, setApplyingAll] = useState(false);
  const [applyMsg, setApplyMsg] = useState('');

  const demandSnapshots = useMemo(() => {
    const thirtyDaysAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const salesStats = new Map<
      string,
      {
        unitsTotal: number;
        units30d: number;
        ordersTotal: number;
        orders30d: number;
        revenueTotal: number;
      }
    >();

    for (const order of salesOrders) {
      if (order.orderStatus === 'Cancelled') continue;
      const createdMs = tsToMs(order.createdAt);
      const isLast30 = createdMs >= thirtyDaysAgoMs;
      const seenInOrder = new Set<string>();

      for (const item of order.items || []) {
        const cur = salesStats.get(item.productId) || {
          unitsTotal: 0,
          units30d: 0,
          ordersTotal: 0,
          orders30d: 0,
          revenueTotal: 0,
        };
        const qty = Number(item.qty) || 0;
        const lineTotal = Number(item.lineTotal) || 0;
        cur.unitsTotal += qty;
        cur.revenueTotal += lineTotal;
        if (isLast30) cur.units30d += qty;
        if (!seenInOrder.has(item.productId)) {
          cur.ordersTotal += 1;
          if (isLast30) cur.orders30d += 1;
          seenInOrder.add(item.productId);
        }
        salesStats.set(item.productId, cur);
      }
    }

    const movementStats = new Map<
      string,
      {
        inQty: number;
        outQty: number;
        allocQty: number;
        retQty: number;
        dmgExpQty: number;
        notes: string[];
      }
    >();

    for (const mov of stockMovements) {
      if (mov.status !== 'Approved') continue;
      const cur = movementStats.get(mov.productId) || {
        inQty: 0,
        outQty: 0,
        allocQty: 0,
        retQty: 0,
        dmgExpQty: 0,
        notes: [],
      };
      const q = Number(mov.quantity) || 0;
      if (mov.movementType === 'Stock In') cur.inQty += q;
      else if (mov.movementType === 'Stock Out' || mov.movementType === 'Stock Transfer') {
        cur.outQty += q;
      } else if (mov.movementType === 'Allocation') cur.allocQty += q;
      else if (mov.movementType === 'Stock Return') cur.retQty += q;
      else if (mov.movementType === 'Damaged' || mov.movementType === 'Expired') {
        cur.dmgExpQty += q;
      }
      if (mov.reason && cur.notes.length < 2) {
        cur.notes.push(`${mov.movementType}: ${mov.quantity} (${mov.reason})`);
      }
      movementStats.set(mov.productId, cur);
    }

    return products.map((p) => {
      const s = salesStats.get(p.id);
      const m = movementStats.get(p.id);
      return {
        productId: p.id,
        name: p.name,
        sku: p.sku,
        category: p.category,
        unit: p.unit,
        availableStock: Number(p.availableStock) || 0,
        minStockLevel: Number(p.minStockLevel) || 0,
        damagedStock: Number(p.damagedStock) || 0,
        expiryDate: p.expiryDate,
        purchasePrice: Number(p.purchasePrice) || 0,
        sellingPrice: Number(p.sellingPrice) || 0,
        warehouse: p.warehouse || 'Central Depot',
        unitsSoldTotal: s?.unitsTotal || 0,
        unitsSoldLast30Days: s?.units30d || 0,
        orderCountTotal: s?.ordersTotal || 0,
        orderCountLast30Days: s?.orders30d || 0,
        salesRevenueTotal: s?.revenueTotal || 0,
        stockInQty: m?.inQty || 0,
        stockOutQty: m?.outQty || 0,
        allocatedQty: m?.allocQty || 0,
        returnedQty: m?.retQty || 0,
        damagedOrExpiredQty: m?.dmgExpQty || 0,
        recentMovementNotes: m?.notes || [],
      };
    });
  }, [products, salesOrders, stockMovements]);

  const sortedSuggestions = useMemo(() => {
    if (!result) return [];
    return [...result.suggestions].sort(
      (a, b) => (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9)
    );
  }, [result]);

  const productById = useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of products) map.set(p.id, p);
    return map;
  }, [products]);

  const handleAnalyze = async () => {
    if (demandSnapshots.length === 0) {
      setError('Add at least one product in inventory before running reorder analysis.');
      return;
    }
    setLoading(true);
    setError('');
    setApplyMsg('');
    setAppliedIds(new Set());

    try {
      const res = await fetch(buildApiUrl('/api/inventory/reorder-suggestions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: demandSnapshots,
          leadTimeDays: Number(leadTimeDays) || 7,
          safetyDays: Number(safetyDays) || 7,
          analysisWindowDays: 30,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data?.error || `Reorder analysis failed (HTTP ${res.status}).`
        );
      }
      setResult(data as ReorderAnalysisResult);
    } catch (err: any) {
      setError(
        err?.message ||
          'Unable to reach the reorder intelligence endpoint. Please try again.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleApplySingle = async (suggestion: ReorderSuggestion) => {
    const prod = productById.get(suggestion.productId);
    if (!prod) return;
    const nextMin = Math.max(0, Math.round(suggestion.suggestedReorderPoint));
    setApplyingId(suggestion.productId);
    setApplyMsg('');
    try {
      await updateDoc(doc(db, 'products', prod.id), {
        minStockLevel: nextMin,
        updatedAt: serverTimestamp(),
      });
      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: 'Reorder Point Updated',
        entityType: 'product',
        entityId: prod.id,
        details: `${prod.name} (${prod.sku}) minStockLevel updated ${prod.minStockLevel} -> ${nextMin}`,
      });
      setAppliedIds((prev) => new Set(prev).add(prod.id));
      setApplyMsg(`Updated min alert level for ${prod.name} to ${nextMin} ${prod.unit}.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${prod.id}`);
    } finally {
      setApplyingId(null);
    }
  };

  const handleApplyAll = async () => {
    const actionable = sortedSuggestions.filter((s) => {
      const prod = productById.get(s.productId);
      return (
        prod &&
        Math.round(s.suggestedReorderPoint) !== Number(prod.minStockLevel) &&
        !appliedIds.has(s.productId)
      );
    });
    if (actionable.length === 0) {
      setApplyMsg('All suggested reorder points already match current stock alert levels.');
      return;
    }

    setApplyingAll(true);
    setApplyMsg('');
    try {
      const batch = writeBatch(db);
      for (const s of actionable) {
        batch.update(doc(db, 'products', s.productId), {
          minStockLevel: Math.max(0, Math.round(s.suggestedReorderPoint)),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: 'Bulk Reorder Points Updated',
        entityType: 'products',
        details: `Applied AI-suggested reorder points across ${actionable.length} product(s)`,
      });
      setAppliedIds((prev) => {
        const next = new Set(prev);
        actionable.forEach((s) => next.add(s.productId));
        return next;
      });
      setApplyMsg(
        `Applied suggested reorder points to ${actionable.length} product(s).`
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'products');
    } finally {
      setApplyingAll(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-2xl max-w-5xl w-full max-h-[92vh] overflow-y-auto p-5 sm:p-6 shadow-xl my-auto space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-[#0F2744] flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-[#15803D]" />
              AI Reorder Point Advisor
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Analyzes historical sales velocity ({salesOrders.length} orders) and warehouse stock movements ({stockMovements.length} entries) across {products.length} batch SKUs.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Parameters & Trigger Bar */}
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="grid grid-cols-2 gap-3 flex-1 max-w-md">
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                Supplier Lead Time (days)
              </label>
              <input
                type="number"
                min={1}
                max={90}
                value={leadTimeDays}
                onChange={(e) => setLeadTimeDays(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg bg-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                Safety Stock Buffer (days)
              </label>
              <input
                type="number"
                min={1}
                max={60}
                value={safetyDays}
                onChange={(e) => setSafetyDays(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg bg-white"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {result && sortedSuggestions.length > 0 && (
              <button
                type="button"
                disabled={applyingAll || loading}
                onClick={handleApplyAll}
                className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold text-[#0F2744] bg-white border border-slate-300 hover:bg-slate-100 rounded-lg min-h-[40px] disabled:opacity-60"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-[#15803D]" />
                {applyingAll ? 'Applying All...' : 'Apply All Suggested Levels'}
              </button>
            )}
            <button
              type="button"
              disabled={loading || products.length === 0}
              onClick={handleAnalyze}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[40px] disabled:opacity-60"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : result ? (
                <RefreshCw className="w-4 h-4" />
              ) : (
                <TrendingUp className="w-4 h-4" />
              )}
              {loading
                ? 'Analyzing Demand & Movements...'
                : result
                ? 'Re-Analyze Inventory'
                : 'Analyze Sales & Stock Trends'}
            </button>
          </div>
        </div>

        {error && (
          <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {applyMsg && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs">
            {applyMsg}
          </div>
        )}

        {/* Initial Prompt State */}
        {!result && !loading && !error && (
          <div className="border border-dashed border-slate-300 rounded-xl p-8 text-center space-y-2">
            <Sparkles className="w-8 h-8 text-[#15803D] mx-auto" />
            <div className="text-sm font-semibold text-slate-900">
              Generate Data-Driven Reorder Points
            </div>
            <p className="text-xs text-slate-500 max-w-lg mx-auto">
              Click <strong>Analyze Sales &amp; Stock Trends</strong> to evaluate historical sales orders, warehouse stock outs, employee allocations, write-offs, and expiry timelines to recommend updated minimum stock alerts and purchase quantities.
            </p>
          </div>
        )}

        {/* Analysis Results */}
        {result && (
          <div className="space-y-4">
            <div className="bg-[#0F2744] text-white rounded-xl p-4 space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-emerald-300 uppercase tracking-wider">
                  Procurement Intelligence Summary
                </span>
                <span className="text-[11px] font-mono text-slate-300">
                  Generated {formatTimestamp(result.generatedAt)} · Lead {result.leadTimeDays}d + Buffer {result.safetyDays}d
                </span>
              </div>
              <p className="text-xs text-slate-100 leading-relaxed">
                {result.executiveSummary}
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-3.5 py-3 font-semibold">Product &amp; SKU</th>
                      <th className="px-3.5 py-3 font-semibold text-right">Available</th>
                      <th className="px-3.5 py-3 font-semibold text-right">Current Min</th>
                      <th className="px-3.5 py-3 font-semibold text-right">Suggested Reorder Pt</th>
                      <th className="px-3.5 py-3 font-semibold text-right">Order Qty</th>
                      <th className="px-3.5 py-3 font-semibold">Urgency / Cover</th>
                      <th className="px-3.5 py-3 font-semibold">Trend &amp; Rationale</th>
                      <th className="px-3.5 py-3 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sortedSuggestions.map((s) => {
                      const prod = productById.get(s.productId);
                      const avail = prod ? Number(prod.availableStock) || 0 : 0;
                      const currentMin = prod
                        ? Number(prod.minStockLevel) || 0
                        : s.currentMinStockLevel;
                      const suggestedPt = Math.max(
                        0,
                        Math.round(s.suggestedReorderPoint)
                      );
                      const delta = suggestedPt - currentMin;
                      const isApplied =
                        appliedIds.has(s.productId) || currentMin === suggestedPt;
                      const badgeCls =
                        URGENCY_BADGE[s.urgency] ||
                        'bg-slate-100 text-slate-700 border-slate-200';

                      return (
                        <tr key={s.productId} className="hover:bg-slate-50/70 align-top">
                          <td className="px-3.5 py-3">
                            <div className="font-semibold text-slate-900">
                              {s.productName}
                            </div>
                            <div className="font-mono text-[11px] text-slate-500">
                              {s.sku}
                              {prod ? ` · Exp ${prod.expiryDate}` : ''}
                            </div>
                          </td>
                          <td className="px-3.5 py-3 text-right font-mono tabular-nums font-bold text-slate-900">
                            {avail}
                          </td>
                          <td className="px-3.5 py-3 text-right font-mono tabular-nums text-slate-500">
                            {currentMin}
                          </td>
                          <td className="px-3.5 py-3 text-right font-mono tabular-nums">
                            <span className="font-bold text-[#0F2744]">{suggestedPt}</span>
                            {delta !== 0 && (
                              <span
                                className={`ml-1 text-[10px] font-semibold ${
                                  delta > 0 ? 'text-amber-700' : 'text-emerald-700'
                                }`}
                              >
                                ({delta > 0 ? `+${delta}` : delta})
                              </span>
                            )}
                          </td>
                          <td className="px-3.5 py-3 text-right font-mono tabular-nums font-bold text-[#15803D]">
                            {s.suggestedOrderQty > 0 ? s.suggestedOrderQty : '—'}
                          </td>
                          <td className="px-3.5 py-3 whitespace-nowrap">
                            <span
                              className={`inline-block px-2 py-0.5 text-[11px] font-semibold border rounded ${badgeCls}`}
                            >
                              {s.urgency}
                            </span>
                            <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                              ~{s.estimatedDaysOfStock}d cover
                            </div>
                          </td>
                          <td className="px-3.5 py-3 max-w-xs">
                            <div className="font-medium text-slate-800">
                              {s.trendSummary}
                            </div>
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              {s.rationale}
                            </div>
                          </td>
                          <td className="px-3.5 py-3 text-right whitespace-nowrap">
                            {prod ? (
                              isApplied ? (
                                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#15803D]">
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  Applied
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  disabled={applyingId === s.productId}
                                  onClick={() => handleApplySingle(s)}
                                  className="px-2.5 py-1.5 text-[11px] font-semibold text-white bg-[#0F2744] hover:bg-slate-800 rounded-lg disabled:opacity-50"
                                >
                                  {applyingId === s.productId
                                    ? 'Saving...'
                                    : 'Apply Level'}
                                </button>
                              )
                            ) : (
                              <span className="text-[11px] text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
