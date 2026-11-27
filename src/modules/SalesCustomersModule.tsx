import React, { useMemo, useState } from 'react';
import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import {
  Building2,
  CreditCard,
  FileText,
  Plus,
  Printer,
  Receipt,
  Search,
  ShoppingCart,
  Trash2,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { formatCurrency, formatTimestamp, generateId, todayIsoDate } from '../lib/utils';
import {
  createOrderWithOptionalStockDeduction,
  recordAtomicPayment,
} from '../lib/erpActions';
import {
  Customer,
  Distributor,
  Employee,
  OrderLineItem,
  OrderStatus,
  PaymentRecord,
  Product,
  SalesOrder,
  UserAccount,
} from '../types/erp';

interface SalesCustomersModuleProps {
  currentUser: UserAccount;
  mode:
    | 'customers'
    | 'sales'
    | 'orders'
    | 'distributors'
    | 'payments'
    | 'my-customers'
    | 'my-sales'
    | 'my-orders';
  isAdminView: boolean;
  customers: Customer[];
  products: Product[];
  orders: SalesOrder[];
  payments: PaymentRecord[];
  distributors: Distributor[];
  employees: Employee[];
  onOpenExpenses?: () => void;
}

export const SalesCustomersModule: React.FC<SalesCustomersModuleProps> = ({
  currentUser,
  mode,
  isAdminView,
  customers,
  products,
  orders,
  payments,
  distributors,
  employees,
  onOpenExpenses,
}) => {
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Customer Modal
  const [showCustModal, setShowCustModal] = useState(false);
  const [cName, setCName] = useState('');
  const [cBiz, setCBiz] = useState('');
  const [cPhone, setCPhone] = useState('');
  const [cAddress, setCAddress] = useState('');
  const [cCity, setCCity] = useState('');
  const [cCategory, setCCategory] = useState<Customer['category']>('Retail Pharmacy');
  const [cEmpUid, setCEmpUid] = useState(currentUser.uid);

  // Distributor Modal
  const [showDistModal, setShowDistModal] = useState(false);
  const [dCompany, setDCompany] = useState('');
  const [dContact, setDContact] = useState('');
  const [dEmail, setDEmail] = useState('');
  const [dPhone, setDPhone] = useState('');
  const [dCity, setDCity] = useState('');
  const [dRegion, setDRegion] = useState('');
  const [dGst, setDGst] = useState('');
  const [dCredit, setDCredit] = useState('500000');

  // Create Sales Order Modal
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [oCustomerId, setOCustomerId] = useState('');
  const [oDiscountPct, setODiscountPct] = useState('0');
  const [oNotes, setONotes] = useState('');
  const [oItems, setOItems] = useState<OrderLineItem[]>([]);
  const [selectedProdId, setSelectedProdId] = useState('');
  const [lineQty, setLineQty] = useState('10');

  // Payment Modal
  const [payOrder, setPayOrder] = useState<SalesOrder | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<PaymentRecord['method']>('UPI');
  const [payRef, setPayRef] = useState('');

  // Invoice preview modal
  const [invoiceOrder, setInvoiceOrder] = useState<SalesOrder | null>(null);

  const handleSaveCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    const emp = employees.find((em) => (em.uid || em.id) === cEmpUid);
    const id = generateId('cst');
    try {
      await setDoc(doc(db, 'customers', id), {
        id,
        name: cName.trim(),
        businessName: cBiz.trim(),
        phone: cPhone.trim(),
        address: cAddress.trim(),
        city: cCity.trim(),
        category: cCategory,
        assignedEmployeeUid: isAdminView ? cEmpUid : currentUser.uid,
        assignedEmployeeName: isAdminView
          ? emp?.fullName || currentUser.displayName
          : currentUser.displayName,
        outstandingBalance: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setShowCustModal(false);
      setCName('');
      setCBiz('');
      setCPhone('');
      setCAddress('');
      setCCity('');
      setMsg('Customer account added.');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `customers/${id}`);
    }
  };

  const handleSaveDistributor = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = generateId('dst');
    try {
      await setDoc(doc(db, 'distributors', id), {
        id,
        companyName: dCompany.trim(),
        contactPerson: dContact.trim(),
        email: dEmail.trim().toLowerCase(),
        phone: dPhone.trim(),
        city: dCity.trim(),
        region: dRegion.trim(),
        gstNumber: dGst.trim(),
        creditLimit: Number(dCredit) || 0,
        outstandingAmount: 0,
        status: 'Active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setShowDistModal(false);
      setDCompany('');
      setDContact('');
      setDEmail('');
      setMsg('Distributor partner added.');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `distributors/${id}`);
    }
  };

  const addOrderLine = () => {
    const prod = products.find((p) => p.id === selectedProdId);
    const qty = Math.max(1, Number(lineQty) || 1);
    if (!prod) return;
    setOItems((prev) => {
      const existingIdx = prev.findIndex((i) => i.productId === prod.id);
      if (existingIdx >= 0) {
        return prev.map((item, idx) =>
          idx === existingIdx
            ? {
                ...item,
                qty: item.qty + qty,
                lineTotal: (item.qty + qty) * item.unitPrice,
              }
            : item
        );
      }
      return [
        ...prev,
        {
          productId: prod.id,
          productName: prod.name,
          batchNumber: prod.batchNumber,
          qty,
          unitPrice: prod.sellingPrice,
          lineTotal: qty * prod.sellingPrice,
        },
      ];
    });
  };

  const subtotal = oItems.reduce((s, i) => s + i.lineTotal, 0);
  const discPct = Math.min(100, Math.max(0, Number(oDiscountPct) || 0));
  const discAmt = (subtotal * discPct) / 100;
  const grandTotal = Math.max(0, subtotal - discAmt);

  const handleCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    const cust = customers.find((c) => c.id === oCustomerId);
    if (!cust || oItems.length === 0) {
      setErr('Select a customer and add at least one product line.');
      return;
    }
    try {
      const ordNo = `ORD-GLC-${Date.now().toString().slice(-5)}`;
      await createOrderWithOptionalStockDeduction({
        orderNumber: ordNo,
        customerId: cust.id,
        customerName: cust.name,
        customerBusiness: cust.businessName,
        createdByUid: currentUser.uid,
        createdByName: currentUser.displayName,
        items: oItems,
        subtotal,
        discountPct: discPct,
        discountAmount: discAmt,
        totalAmount: grandTotal,
        orderType: 'Customer Sale',
        notes: oNotes.trim(),
        autoApproveAndDeduct: isAdminView,
      });
      setShowOrderModal(false);
      setOItems([]);
      setONotes('');
      setMsg(`Sales order ${ordNo} created.`);
    } catch (error: any) {
      setErr(error?.message || 'Unable to create sales order.');
    }
  };

  const handleOrderStatusChange = async (order: SalesOrder, status: OrderStatus) => {
    try {
      await updateDoc(doc(db, 'salesOrders', order.id), {
        orderStatus: status,
        updatedAt: serverTimestamp(),
      });
      setMsg(`Order ${order.orderNumber} updated to ${status}.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `salesOrders/${order.id}`);
    }
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payOrder) return;
    setErr('');
    try {
      await recordAtomicPayment({
        orderId: payOrder.id,
        amount: Number(payAmount) || 0,
        method: payMethod,
        referenceNo: payRef.trim(),
        paymentDate: todayIsoDate(),
        collectedByUid: currentUser.uid,
        collectedByName: currentUser.displayName,
      });
      setPayOrder(null);
      setPayAmount('');
      setPayRef('');
      setMsg('Payment recorded and order balance updated.');
    } catch (error: any) {
      setErr(error?.message || 'Failed to record payment.');
    }
  };

  // Employee-wise sales summary for Sales view (must be declared before early returns)
  const salesByRep = useMemo(() => {
    const map = new Map<string, { name: string; count: number; total: number; collected: number }>();
    orders
      .filter((o) => o.orderStatus !== 'Cancelled')
      .forEach((o) => {
        const cur = map.get(o.createdByUid) || {
          name: o.createdByName,
          count: 0,
          total: 0,
          collected: 0,
        };
        cur.count += 1;
        cur.total += Number(o.totalAmount) || 0;
        cur.collected += Number(o.paidAmount) || 0;
        map.set(o.createdByUid, cur);
      });
    return Array.from(map.values());
  }, [orders]);

  // Views
  if (mode === 'customers' || mode === 'my-customers') {
    const filtered = customers.filter(
      (c) =>
        !search.trim() ||
        c.businessName.toLowerCase().includes(search.toLowerCase()) ||
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.city.toLowerCase().includes(search.toLowerCase())
    );

    return (
      <div className="space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {mode === 'my-customers' ? 'My Assigned Customers' : 'Customer & Pharmacy Directory'}
            </h2>
            <p className="text-xs text-slate-500">
              Retail pharmacies, clinics, hospitals, and stockist accounts.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowCustModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg self-start min-h-[40px]"
          >
            <Plus className="w-4 h-4" />
            Add Customer
          </button>
        </div>

        {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs">{msg}</div>}

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search business, contact, or city..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {filtered.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              <Building2 className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              No customer records found.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Business & Contact</th>
                    <th className="px-4 py-3 font-semibold">Category</th>
                    <th className="px-4 py-3 font-semibold">City & Address</th>
                    <th className="px-4 py-3 font-semibold">Assigned Rep</th>
                    <th className="px-4 py-3 font-semibold text-right">Outstanding</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((c) => (
                    <tr key={c.id}>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-900">{c.businessName}</div>
                        <div className="text-slate-500">
                          {c.name} · {c.phone}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{c.category}</td>
                      <td className="px-4 py-3 text-slate-600">
                        <div>{c.city}</div>
                        <div className="text-slate-400 truncate max-w-[200px]">{c.address}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-800">{c.assignedEmployeeName}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold">
                        {formatCurrency(c.outstandingBalance || 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {showCustModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
            <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-6 shadow-xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-slate-900">Add Customer Account</h3>
                <button type="button" onClick={() => setShowCustModal(false)} className="p-1 text-slate-500">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <form onSubmit={handleSaveCustomer} className="space-y-3">
                <input
                  type="text"
                  required
                  value={cBiz}
                  onChange={(e) => setCBiz(e.target.value)}
                  placeholder="Pharmacy / Hospital Business Name"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    required
                    value={cName}
                    onChange={(e) => setCName(e.target.value)}
                    placeholder="Contact Person"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                  <input
                    type="text"
                    required
                    value={cPhone}
                    onChange={(e) => setCPhone(e.target.value)}
                    placeholder="Phone"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <select
                    value={cCategory}
                    onChange={(e) => setCCategory(e.target.value as Customer['category'])}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="Retail Pharmacy">Retail Pharmacy</option>
                    <option value="Hospital">Hospital</option>
                    <option value="Clinic">Clinic</option>
                    <option value="Stockist">Stockist</option>
                    <option value="Wholesaler">Wholesaler</option>
                  </select>
                  <input
                    type="text"
                    required
                    value={cCity}
                    onChange={(e) => setCCity(e.target.value)}
                    placeholder="City"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <input
                  type="text"
                  value={cAddress}
                  onChange={(e) => setCAddress(e.target.value)}
                  placeholder="Street Address"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
                {isAdminView && (
                  <select
                    value={cEmpUid}
                    onChange={(e) => setCEmpUid(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value={currentUser.uid}>Assign to: {currentUser.displayName}</option>
                    {employees.map((em) => (
                      <option key={em.id} value={em.uid || em.id}>
                        Assign to: {em.fullName}
                      </option>
                    ))}
                  </select>
                )}
                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={() => setShowCustModal(false)} className="px-4 py-2 text-xs text-slate-600 rounded-lg">
                    Cancel
                  </button>
                  <button type="submit" className="px-5 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg">
                    Save Customer
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (mode === 'distributors') {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Authorized Distributors</h2>
            <p className="text-xs text-slate-500">
              Channel partners, regional credit limits, and outstanding balances.
            </p>
          </div>
          {isAdminView && (
            <button
              type="button"
              onClick={() => setShowDistModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
            >
              <Plus className="w-4 h-4" /> Add Distributor
            </button>
          )}
        </div>

        {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs">{msg}</div>}

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {distributors.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">No distributors configured yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Company</th>
                    <th className="px-4 py-3 font-semibold">Contact</th>
                    <th className="px-4 py-3 font-semibold">City / Region</th>
                    <th className="px-4 py-3 font-semibold">GSTIN</th>
                    <th className="px-4 py-3 font-semibold text-right">Credit Limit</th>
                    <th className="px-4 py-3 font-semibold text-right">Outstanding</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {distributors.map((d) => (
                    <tr key={d.id}>
                      <td className="px-4 py-3 font-semibold text-slate-900">{d.companyName}</td>
                      <td className="px-4 py-3">
                        <div>{d.contactPerson}</div>
                        <div className="text-slate-500">{d.email}</div>
                      </td>
                      <td className="px-4 py-3">{d.city} · {d.region}</td>
                      <td className="px-4 py-3 font-mono">{d.gstNumber || '—'}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">{formatCurrency(d.creditLimit || 0)}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-amber-700 font-semibold">
                        {formatCurrency(d.outstandingAmount || 0)}
                      </td>
                      <td className="px-4 py-3 font-semibold text-[#15803D]">{d.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {showDistModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
            <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-6 shadow-xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-slate-900">Add Distributor Partner</h3>
                <button type="button" onClick={() => setShowDistModal(false)} className="p-1 text-slate-500">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <form onSubmit={handleSaveDistributor} className="space-y-3">
                <input type="text" required value={dCompany} onChange={(e) => setDCompany(e.target.value)} placeholder="Distributor Company Name" className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" />
                <div className="grid grid-cols-2 gap-3">
                  <input type="text" required value={dContact} onChange={(e) => setDContact(e.target.value)} placeholder="Contact Person" className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" />
                  <input type="email" required value={dEmail} onChange={(e) => setDEmail(e.target.value)} placeholder="Email" className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <input type="text" required value={dCity} onChange={(e) => setDCity(e.target.value)} placeholder="City" className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" />
                  <input type="text" value={dRegion} onChange={(e) => setDRegion(e.target.value)} placeholder="Region" className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <input type="text" value={dPhone} onChange={(e) => setDPhone(e.target.value)} placeholder="Phone" className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" />
                  <input type="text" value={dGst} onChange={(e) => setDGst(e.target.value)} placeholder="GSTIN" className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg" />
                  <input type="number" value={dCredit} onChange={(e) => setDCredit(e.target.value)} placeholder="Credit Limit" className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg" />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={() => setShowDistModal(false)} className="px-4 py-2 text-xs text-slate-600 rounded-lg">Cancel</button>
                  <button type="submit" className="px-5 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg">Save Distributor</button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (mode === 'payments') {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Payments & Receivables</h2>
          <p className="text-xs text-slate-500">
            Track collections, payment modes, and pending invoice balances.
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {payments.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              <CreditCard className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              No payments logged yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Order #</th>
                    <th className="px-4 py-3 font-semibold">Payer</th>
                    <th className="px-4 py-3 font-semibold">Method & Ref</th>
                    <th className="px-4 py-3 font-semibold">Collected By</th>
                    <th className="px-4 py-3 font-semibold">Date</th>
                    <th className="px-4 py-3 font-semibold text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td className="px-4 py-3 font-mono font-semibold text-[#0F2744]">{p.orderNumber}</td>
                      <td className="px-4 py-3 font-medium text-slate-900">{p.payerName}</td>
                      <td className="px-4 py-3">{p.method} · <span className="font-mono text-slate-500">{p.referenceNo || '—'}</span></td>
                      <td className="px-4 py-3">{p.collectedByName}</td>
                      <td className="px-4 py-3 font-mono">{p.paymentDate}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-bold text-[#15803D]">
                        {formatCurrency(p.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Sales & Orders shared workspace
  const filteredOrders = orders.filter(
    (o) =>
      !search.trim() ||
      o.orderNumber.toLowerCase().includes(search.toLowerCase()) ||
      o.customerName.toLowerCase().includes(search.toLowerCase()) ||
      (o.customerBusiness || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            {mode === 'sales' || mode === 'my-sales' ? 'Sales & Billing' : 'Order Management & Dispatch'}
          </h2>
          <p className="text-xs text-slate-500">
            Create multi-line batch orders, apply discounts, generate invoices, and collect payments.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start">
          {(mode === 'sales' || mode === 'my-sales') && onOpenExpenses && (
            <button
              type="button"
              onClick={onOpenExpenses}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#0F2744] bg-white border border-slate-300 hover:bg-slate-50 rounded-lg min-h-[40px]"
            >
              <Receipt className="w-4 h-4 text-[#15803D]" />
              Expense Reporting
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setOCustomerId(customers[0]?.id || '');
              setSelectedProdId(products[0]?.id || '');
              setOItems([]);
              setErr('');
              setShowOrderModal(true);
            }}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[40px]"
          >
            <Plus className="w-4 h-4" />
            New Sales Order
          </button>
        </div>
      </div>

      {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs">{msg}</div>}
      {err && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs">{err}</div>}

      {(mode === 'sales' || mode === 'my-sales') && salesByRep.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">
            Employee-wise Sales Summary
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2 font-medium">Representative</th>
                  <th className="py-2 font-medium text-right">Orders</th>
                  <th className="py-2 font-medium text-right">Total Billed</th>
                  <th className="py-2 font-medium text-right">Collected</th>
                </tr>
              </thead>
              <tbody>
                {salesByRep.map((r) => (
                  <tr key={r.name} className="border-b border-slate-100">
                    <td className="py-2 font-semibold text-slate-900">{r.name}</td>
                    <td className="py-2 text-right font-mono tabular-nums">{r.count}</td>
                    <td className="py-2 text-right font-mono tabular-nums">{formatCurrency(r.total)}</td>
                    <td className="py-2 text-right font-mono tabular-nums text-[#15803D] font-semibold">
                      {formatCurrency(r.collected)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order #, customer, or pharmacy..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg"
          />
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filteredOrders.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            <ShoppingCart className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            No sales orders recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-semibold">Order #</th>
                  <th className="px-4 py-3 font-semibold">Customer</th>
                  <th className="px-4 py-3 font-semibold">Rep</th>
                  <th className="px-4 py-3 font-semibold text-right">Total</th>
                  <th className="px-4 py-3 font-semibold text-right">Pending</th>
                  <th className="px-4 py-3 font-semibold">Order Status</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50/70">
                    <td className="px-4 py-3 font-mono font-semibold text-[#0F2744]">
                      {o.orderNumber}
                      <div className="text-[10px] text-slate-400 font-sans">{o.orderType}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">
                        {o.customerBusiness || o.customerName}
                      </div>
                      <div className="text-slate-500">{o.items.length} line item(s)</div>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{o.createdByName}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold">
                      {formatCurrency(o.totalAmount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      <span className={o.pendingAmount > 0 ? 'text-amber-700 font-semibold' : 'text-[#15803D]'}>
                        {formatCurrency(o.pendingAmount)}
                      </span>
                      <div className="text-[10px] text-slate-400">{o.paymentStatus}</div>
                    </td>
                    <td className="px-4 py-3">
                      {isAdminView ? (
                        <select
                          value={o.orderStatus}
                          onChange={(e) => handleOrderStatusChange(o, e.target.value as OrderStatus)}
                          className="px-2 py-1 text-xs border border-slate-200 rounded bg-white font-medium"
                        >
                          {(['Pending', 'Approved', 'Packed', 'Dispatched', 'Delivered', 'Cancelled', 'Returned'] as const).map(
                            (st) => (
                              <option key={st} value={st}>
                                {st}
                              </option>
                            )
                          )}
                        </select>
                      ) : (
                        <span className="font-semibold text-[#0F2744]">{o.orderStatus}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setInvoiceOrder(o)}
                        className="px-2.5 py-1.5 text-xs text-[#0F2744] hover:bg-slate-100 rounded inline-flex items-center gap-1"
                      >
                        <FileText className="w-3.5 h-3.5" /> Invoice
                      </button>
                      {o.pendingAmount > 0 && o.orderStatus !== 'Cancelled' && (
                        <button
                          type="button"
                          onClick={() => {
                            setPayOrder(o);
                            setPayAmount(String(o.pendingAmount));
                          }}
                          className="ml-1 px-2.5 py-1.5 text-xs font-medium text-white bg-[#15803D] rounded"
                        >
                          Pay
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* New Sales Order Modal */}
      {showOrderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">Create Sales Order</h3>
              <button type="button" onClick={() => setShowOrderModal(false)} className="p-1 text-slate-500">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateOrder} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Customer / Pharmacy
                </label>
                <select
                  required
                  value={oCustomerId}
                  onChange={(e) => setOCustomerId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">Select customer...</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.businessName} ({c.name} · {c.city})
                    </option>
                  ))}
                </select>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                <div className="text-xs font-semibold text-slate-800">Add Products & Batch</div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    value={selectedProdId}
                    onChange={(e) => setSelectedProdId(e.target.value)}
                    className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="">Select product...</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · Batch {p.batchNumber} · {formatCurrency(p.sellingPrice)} (Avail: {p.availableStock})
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    value={lineQty}
                    onChange={(e) => setLineQty(e.target.value)}
                    className="w-24 px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg bg-white"
                  />
                  <button
                    type="button"
                    onClick={addOrderLine}
                    className="px-4 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
                  >
                    Add Item
                  </button>
                </div>

                {oItems.length > 0 && (
                  <div className="space-y-1.5 pt-2">
                    {oItems.map((it, idx) => (
                      <div
                        key={it.productId}
                        className="flex items-center justify-between text-xs bg-white p-2 rounded border border-slate-200"
                      >
                        <span>
                          {it.productName} ({it.batchNumber}) × {it.qty}
                        </span>
                        <div className="flex items-center gap-2 font-mono">
                          <span>{formatCurrency(it.lineTotal)}</span>
                          <button
                            type="button"
                            onClick={() => setOItems((prev) => prev.filter((_, i) => i !== idx))}
                            className="text-red-600"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Discount (%)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={oDiscountPct}
                    onChange={(e) => setODiscountPct(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-right">
                  <div className="text-xs text-slate-500">Order Total</div>
                  <div className="text-base font-bold font-mono tabular-nums text-[#0F2744]">
                    {formatCurrency(grandTotal)}
                  </div>
                </div>
              </div>

              <input
                type="text"
                value={oNotes}
                onChange={(e) => setONotes(e.target.value)}
                placeholder="Delivery / credit notes..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />

              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowOrderModal(false)} className="px-4 py-2 text-xs text-slate-600 rounded-lg">
                  Cancel
                </button>
                <button type="submit" className="px-5 py-2 text-xs font-semibold text-white bg-[#15803D] rounded-lg">
                  Create Order
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Record Payment Modal */}
      {payOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-slate-900">
                Record Payment · {payOrder.orderNumber}
              </h3>
              <button type="button" onClick={() => setPayOrder(null)} className="p-1 text-slate-500">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleRecordPayment} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Amount (Pending: {formatCurrency(payOrder.pendingAmount)})
                </label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Payment Method
                </label>
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as PaymentRecord['method'])}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="UPI">UPI</option>
                  <option value="Bank Transfer">Bank Transfer</option>
                  <option value="NEFT">NEFT</option>
                  <option value="Cheque">Cheque</option>
                  <option value="Cash">Cash</option>
                </select>
              </div>
              <input
                type="text"
                value={payRef}
                onChange={(e) => setPayRef(e.target.value)}
                placeholder="Transaction / Cheque Reference No."
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setPayOrder(null)} className="px-4 py-2 text-xs text-slate-600 rounded-lg">
                  Cancel
                </button>
                <button type="submit" className="px-5 py-2 text-xs font-semibold text-white bg-[#15803D] rounded-lg">
                  Record Receipt
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Printable Invoice Modal */}
      {invoiceOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-xl w-full p-6 shadow-xl space-y-4">
            <div className="flex items-start justify-between border-b border-slate-200 pb-4">
              <div>
                <h3 className="text-base font-bold text-[#0F2744]">
                  GLACETOR REMEDIES PVT. LTD.
                </h3>
                <p className="text-xs text-slate-500">Tax / Commercial Order Invoice</p>
              </div>
              <div className="text-right text-xs font-mono">
                <div className="font-bold">{invoiceOrder.orderNumber}</div>
                <div className="text-slate-500">{formatTimestamp(invoiceOrder.createdAt)}</div>
              </div>
            </div>

            <div className="text-xs space-y-1">
              <div>
                <strong>Bill To:</strong> {invoiceOrder.customerBusiness || invoiceOrder.customerName}
              </div>
              <div>
                <strong>Sales Rep:</strong> {invoiceOrder.createdByName} · <strong>Status:</strong> {invoiceOrder.orderStatus}
              </div>
            </div>

            <table className="w-full text-xs border-t border-b border-slate-200">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 text-left">Product (Batch)</th>
                  <th className="py-2 text-right">Qty</th>
                  <th className="py-2 text-right">Rate</th>
                  <th className="py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoiceOrder.items.map((it, idx) => (
                  <tr key={idx} className="border-b border-slate-100">
                    <td className="py-2">
                      {it.productName} <span className="font-mono text-slate-400">({it.batchNumber})</span>
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">{it.qty}</td>
                    <td className="py-2 text-right font-mono tabular-nums">{formatCurrency(it.unitPrice)}</td>
                    <td className="py-2 text-right font-mono tabular-nums">{formatCurrency(it.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="text-xs space-y-1 text-right font-mono tabular-nums">
              <div>Subtotal: {formatCurrency(invoiceOrder.subtotal ?? invoiceOrder.totalAmount)}</div>
              {invoiceOrder.discountAmount ? (
                <div>Discount ({invoiceOrder.discountPct}%): -{formatCurrency(invoiceOrder.discountAmount)}</div>
              ) : null}
              <div className="text-sm font-bold text-[#0F2744]">
                Grand Total: {formatCurrency(invoiceOrder.totalAmount)}
              </div>
              <div className="text-[#15803D]">Paid: {formatCurrency(invoiceOrder.paidAmount)}</div>
              <div className="text-amber-700">Balance Due: {formatCurrency(invoiceOrder.pendingAmount)}</div>
            </div>

            <div className="flex justify-end gap-2 pt-2 no-print">
              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-[#0F2744] border border-slate-300 rounded-lg"
              >
                <Printer className="w-3.5 h-3.5" /> Print Invoice
              </button>
              <button
                type="button"
                onClick={() => setInvoiceOrder(null)}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
