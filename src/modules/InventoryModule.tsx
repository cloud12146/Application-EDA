import React, { useMemo, useRef, useState } from 'react';
import { doc, runTransaction, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  Download,
  FileSpreadsheet,
  Package,
  Plus,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  daysUntilDate,
  exportToCsv,
  formatCurrency,
  formatTimestamp,
  generateId,
} from '../lib/utils';
import { executeAtomicStockMovement } from '../lib/erpActions';
import {
  getMissingOfficialCatalogProducts,
  OFFICIAL_CATALOG_STORAGE_KEY,
  splitProductAndSaltName,
  syncOfficialGlacetorCatalog,
} from '../lib/glacetorCatalog';
import {
  autoDetectCsvMapping,
  commitCsvInventoryImport,
  CSV_TEMPLATE_HEADERS,
  CSV_TEMPLATE_SAMPLE_ROWS,
  CsvColumnMapping,
  CsvInventoryField,
  mapCsvRowsToInventory,
  parseCsvText,
  ParsedCsvData,
} from '../lib/csvInventoryImport';
import { InventoryReorderAdvisor } from '../components/InventoryReorderAdvisor';
import {
  Distributor,
  Employee,
  Product,
  SalesOrder,
  StockAllocation,
  StockMovement,
  StockMovementType,
  UserAccount,
} from '../types/erp';

interface InventoryModuleProps {
  currentUser: UserAccount;
  mode: 'products' | 'inventory' | 'stock-movements' | 'my-stock';
  isStockAuthorized: boolean;
  products: Product[];
  stockMovements: StockMovement[];
  salesOrders?: SalesOrder[];
  allocations: StockAllocation[];
  employees: Employee[];
  distributors: Distributor[];
}

const PRESET_PRODUCT_IMAGES = [
  { label: 'No Image (Name & Salt Only)', url: '' },
  { label: 'Tablet Blister Box', url: '/src/assets/images/pharma_tablet_box_1795369268832.jpg' },
  { label: 'Pediatric Syrup Bottle', url: '/src/assets/images/pharma_syrup_bottle_1795369269067.jpg' },
  { label: 'Sterile Injection Vial', url: '/src/assets/images/pharma_vial_pack_1795369269026.jpg' },
  { label: 'Capsule HDPE Pack', url: '/src/assets/images/pharma_capsule_pack_1795369268802.jpg' },
];

export const InventoryModule: React.FC<InventoryModuleProps> = ({
  currentUser,
  mode,
  isStockAuthorized,
  products,
  stockMovements,
  salesOrders = [],
  allocations,
  employees,
  distributors,
}) => {
  const [search, setSearch] = useState('');
  const [filterAlert, setFilterAlert] = useState<'ALL' | 'LOW' | 'EXPIRY'>('ALL');
  const [showReorderAdvisor, setShowReorderAdvisor] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Product modal
  const [showProductModal, setShowProductModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [pName, setPName] = useState('');
  const [pSku, setPSku] = useState('');
  const [pCategory, setPCategory] = useState('Antibiotics');
  const [pBrand, setPBrand] = useState('Glacetor Core');
  const [pUnit, setPUnit] = useState('Box (10x10)');
  const [pBatch, setPBatch] = useState('');
  const [pMfg, setPMfg] = useState('2026-01-01');
  const [pExp, setPExp] = useState('2028-01-01');
  const [pPurchase, setPPurchase] = useState('0');
  const [pSelling, setPSelling] = useState('0');
  const [pOpening, setPOpening] = useState('0');
  const [pMin, setPMin] = useState('50');
  const [pWarehouse, setPWarehouse] = useState('Central Warehouse');
  const [pImageUrl, setPImageUrl] = useState('');
  const [saving, setSaving] = useState(false);

  // Stock Movement modal
  const [showMovementModal, setShowMovementModal] = useState(false);
  const [mProductId, setMProductId] = useState('');
  const [mType, setMType] = useState<StockMovementType>('Stock In');
  const [mQty, setMQty] = useState('10');
  const [mFrom, setMFrom] = useState('Bhiwandi Central Depot');
  const [mTo, setMTo] = useState('Field Distribution');
  const [mTargetUid, setMTargetUid] = useState('');
  const [mTargetRole, setMTargetRole] = useState<'Employee' | 'Distributor'>('Employee');
  const [mReason, setMReason] = useState('');
  const [mRequireApproval, setMRequireApproval] = useState(false);

  // CSV Batch Import Modal state
  const csvFileInputRef = useRef<HTMLInputElement | null>(null);
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [csvFileName, setCsvFileName] = useState('');
  const [parsedCsv, setParsedCsv] = useState<ParsedCsvData | null>(null);
  const [csvMapping, setCsvMapping] = useState<CsvColumnMapping>({});
  const [csvError, setCsvError] = useState('');
  const [importingCsv, setImportingCsv] = useState(false);

  const openCreateProduct = () => {
    setEditingProduct(null);
    setPName('');
    setPSku(`GLC-${Math.floor(100 + Math.random() * 899)}`);
    setPCategory('Cardiology');
    setPBrand('Glacetor Remedies');
    setPUnit('Box (10x10)');
    setPBatch(`GLB${new Date().getFullYear().toString().slice(-2)}01`);
    setPMfg('2026-06-01');
    setPExp('2028-05-31');
    setPPurchase('0');
    setPSelling('0');
    setPOpening('0');
    setPMin('50');
    setPWarehouse('Central Warehouse');
    setPImageUrl('');
    setErr('');
    setShowProductModal(true);
  };

  const openEditProduct = (p: Product) => {
    setEditingProduct(p);
    setPName(p.name);
    setPSku(p.sku);
    setPCategory(p.category);
    setPBrand(p.brand);
    setPUnit(p.unit);
    setPBatch(p.batchNumber);
    setPMfg(p.mfgDate);
    setPExp(p.expiryDate);
    setPPurchase(String(p.purchasePrice ?? 0));
    setPSelling(String(p.sellingPrice ?? 0));
    setPOpening(String(p.openingStock));
    setPMin(String(p.minStockLevel));
    setPWarehouse(p.warehouse || 'Central Warehouse');
    setPImageUrl(p.imageUrl || '');
    setErr('');
    setShowProductModal(true);
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    if (!pName.trim() || !pSku.trim() || !pBatch.trim()) {
      setErr('Product name, SKU, and batch number are required.');
      return;
    }
    setSaving(true);
    const id = editingProduct?.id || generateId('prd');
    const opening = Math.max(0, Number(pOpening) || 0);

    try {
      if (editingProduct) {
        await updateDoc(doc(db, 'products', id), {
          name: pName.trim(),
          sku: pSku.trim(),
          category: pCategory.trim(),
          brand: pBrand.trim(),
          unit: pUnit.trim(),
          batchNumber: pBatch.trim(),
          mfgDate: pMfg,
          expiryDate: pExp,
          purchasePrice: Math.max(0, Number(pPurchase) || 0),
          sellingPrice: Math.max(0, Number(pSelling) || 0),
          minStockLevel: Math.max(0, Number(pMin) || 0),
          warehouse: pWarehouse.trim(),
          imageUrl: pImageUrl,
          updatedAt: serverTimestamp(),
        });
        setMsg(`Updated product ${pName.trim()}.`);
      } else {
        await setDoc(doc(db, 'products', id), {
          id,
          name: pName.trim(),
          sku: pSku.trim(),
          category: pCategory.trim(),
          brand: pBrand.trim(),
          unit: pUnit.trim(),
          batchNumber: pBatch.trim(),
          mfgDate: pMfg,
          expiryDate: pExp,
          purchasePrice: Math.max(0, Number(pPurchase) || 0),
          sellingPrice: Math.max(0, Number(pSelling) || 0),
          openingStock: opening,
          availableStock: opening,
          minStockLevel: Math.max(0, Number(pMin) || 0),
          damagedStock: 0,
          warehouse: pWarehouse.trim(),
          imageUrl: pImageUrl,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        setMsg(`Added batch ${pBatch.trim()} for ${pName.trim()}.`);
      }
      setShowProductModal(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `products/${id}`);
    } finally {
      setSaving(false);
    }
  };

  const handleStockMovementSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    if (!mProductId || !mReason.trim()) {
      setErr('Select a product and provide a reason for the stock transaction.');
      return;
    }

    let targetName = '';
    if (mType === 'Allocation') {
      if (mTargetRole === 'Employee') {
        const emp = employees.find((em) => (em.uid || em.id) === mTargetUid);
        targetName = emp?.fullName || '';
      } else {
        const dist = distributors.find((d) => (d.uid || d.id) === mTargetUid);
        targetName = dist?.companyName || '';
      }
    }

    setSaving(true);
    try {
      await executeAtomicStockMovement({
        productId: mProductId,
        movementType: mType,
        quantity: Number(mQty) || 1,
        reason: mReason.trim(),
        fromLocation: mFrom.trim(),
        toLocation: mTo.trim(),
        targetUserId: mTargetUid || undefined,
        targetName: targetName || undefined,
        targetRole: mType === 'Allocation' ? mTargetRole : undefined,
        performedByUid: currentUser.uid,
        performedByName: currentUser.displayName,
        requireApproval: !isStockAuthorized || mRequireApproval,
      });
      setMsg(
        !isStockAuthorized || mRequireApproval
          ? 'Stock movement submitted for approval.'
          : 'Stock updated atomically in inventory ledger.'
      );
      setShowMovementModal(false);
      setMReason('');
    } catch (error: any) {
      setErr(error?.message || 'Stock movement failed.');
    } finally {
      setSaving(false);
    }
  };

  const handleApprovePendingMovement = async (
    mov: StockMovement,
    decision: 'Approved' | 'Rejected'
  ) => {
    setErr('');
    setMsg('');
    try {
      await runTransaction(db, async (tx) => {
        const movRef = doc(db, 'stockMovements', mov.id);
        const prodRef = doc(db, 'products', mov.productId);
        const prodSnap = await tx.get(prodRef);
        if (!prodSnap.exists()) throw new Error('Product missing.');
        const prod = prodSnap.data() as Product;

        if (decision === 'Rejected') {
          tx.update(movRef, {
            status: 'Rejected',
            approvedByUid: currentUser.uid,
          });
          return;
        }

        const prev = Number(prod.availableStock) || 0;
        const isAdd =
          mov.movementType === 'Stock In' || mov.movementType === 'Stock Return';
        const next = isAdd ? prev + mov.quantity : Math.max(0, prev - mov.quantity);

        tx.update(prodRef, {
          availableStock: next,
          updatedAt: serverTimestamp(),
        });
        tx.update(movRef, {
          status: 'Approved',
          previousStock: prev,
          newStock: next,
          approvedByUid: currentUser.uid,
        });
      });
      setMsg(`Stock movement ${decision.toLowerCase()}.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `stockMovements/${mov.id}`);
    }
  };

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      if (filterAlert === 'LOW' && p.availableStock > p.minStockLevel) return false;
      if (filterAlert === 'EXPIRY' && daysUntilDate(p.expiryDate) > 90) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          p.name.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          p.batchNumber.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [products, filterAlert, search]);

  const missingOfficialProducts = useMemo(
    () => getMissingOfficialCatalogProducts(products),
    [products]
  );

  const handleSyncOfficialCatalog = async () => {
    setErr('');
    setMsg('');
    setSaving(true);
    try {
      const added = await syncOfficialGlacetorCatalog(products);
      try {
        localStorage.setItem(OFFICIAL_CATALOG_STORAGE_KEY, '1');
      } catch {
        // ignore
      }
      setMsg(
        added > 0
          ? `Added ${added} official Glacetor product SKU(s) to inventory catalog.`
          : 'All official Glacetor catalog products are already present.'
      );
    } catch (error: any) {
      setErr(error?.message || 'Failed to sync official product catalog.');
    } finally {
      setSaving(false);
    }
  };

  const mappedCsvRows = useMemo(() => {
    if (!parsedCsv || parsedCsv.rows.length === 0) return [];
    return mapCsvRowsToInventory(parsedCsv, csvMapping, products);
  }, [parsedCsv, csvMapping, products]);

  const csvSummary = useMemo(() => {
    let validCount = 0;
    let errorCount = 0;
    let createCount = 0;
    let updateCount = 0;
    let movementCount = 0;
    for (const r of mappedCsvRows) {
      if (r.error) {
        errorCount += 1;
      } else {
        validCount += 1;
        if (r.action === 'create_product') createCount += 1;
        else updateCount += 1;
        if (r.quantity > 0) movementCount += 1;
      }
    }
    return { validCount, errorCount, createCount, updateCount, movementCount };
  }, [mappedCsvRows]);

  const openCsvImportModal = () => {
    setCsvFileName('');
    setParsedCsv(null);
    setCsvMapping({});
    setCsvError('');
    if (csvFileInputRef.current) {
      csvFileInputRef.current.value = '';
    }
    setShowCsvModal(true);
  };

  const handleCsvFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvError('');
    try {
      const text = await file.text();
      const parsed = parseCsvText(text);
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setCsvError('The selected CSV file has no header row or data rows.');
        setParsedCsv(null);
        setCsvFileName(file.name);
        return;
      }
      setCsvFileName(file.name);
      setParsedCsv(parsed);
      setCsvMapping(autoDetectCsvMapping(parsed.headers));
    } catch {
      setCsvError('Unable to read the selected CSV file.');
    }
  };

  const handleCommitCsvImport = async () => {
    if (!isStockAuthorized) {
      setCsvError('You are not authorized to import inventory batches.');
      return;
    }
    if (csvSummary.validCount === 0) {
      setCsvError('Fix validation errors or select a valid CSV before importing.');
      return;
    }
    setCsvError('');
    setImportingCsv(true);
    try {
      const result = await commitCsvInventoryImport({
        rows: mappedCsvRows,
        existingProducts: products,
        performedByUid: currentUser.uid,
        performedByName: currentUser.displayName,
      });
      setMsg(
        `CSV import complete: ${result.createdCount} new batch(es), ${result.updatedCount} batch update(s), ${result.movementsCount} stock movement(s) recorded.`
      );
      setShowCsvModal(false);
    } catch (error: any) {
      setCsvError(error?.message || 'CSV inventory import failed.');
    } finally {
      setImportingCsv(false);
    }
  };

  if (mode === 'my-stock') {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-lg font-bold text-slate-900">My Allocated Stock</h2>
          <p className="text-xs text-slate-500">
            Pharmaceutical sample and field inventory allocated to your territory.
          </p>
        </div>

        {allocations.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-xs text-slate-500">
            No stock has been allocated to your account yet.
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Product</th>
                    <th className="px-4 py-3 font-semibold">Batch</th>
                    <th className="px-4 py-3 font-semibold text-right">Allocated</th>
                    <th className="px-4 py-3 font-semibold text-right">Sold</th>
                    <th className="px-4 py-3 font-semibold text-right">Remaining</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {allocations.map((a) => (
                    <tr key={a.id}>
                      <td className="px-4 py-3 font-semibold text-slate-900">
                        {a.productName}
                      </td>
                      <td className="px-4 py-3 font-mono">{a.batchNumber}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        {a.allocatedQty}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        {a.soldQty}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-bold text-[#15803D]">
                        {a.remainingQty}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            {mode === 'products'
              ? 'Pharmaceutical Product Catalog'
              : mode === 'stock-movements'
              ? 'Stock Movements & Approval Ledger'
              : 'Warehouse & Batch Inventory'}
          </h2>
          <p className="text-xs text-slate-500">
            Batch-wise stock control, expiry monitoring, employee allocations, and atomic ledger updates.
          </p>
        </div>

        {isStockAuthorized && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowReorderAdvisor(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0F2744] bg-white border border-slate-300 hover:bg-slate-50 rounded-lg min-h-[40px]"
            >
              <Sparkles className="w-4 h-4 text-[#15803D]" />
              AI Reorder Suggestions
            </button>
            <button
              type="button"
              onClick={() => {
                setMProductId(products[0]?.id || '');
                setShowMovementModal(true);
                setErr('');
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[40px]"
            >
              <ArrowLeftRight className="w-4 h-4" />
              Record Stock Movement
            </button>
            <button
              type="button"
              onClick={openCsvImportModal}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0F2744] bg-white border border-slate-300 hover:bg-slate-50 rounded-lg min-h-[40px]"
            >
              <Upload className="w-4 h-4 text-[#0F2744]" />
              Import CSV
            </button>
            <button
              type="button"
              onClick={openCreateProduct}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg min-h-[40px]"
            >
              <Plus className="w-4 h-4" />
              Add Product / Batch
            </button>
          </div>
        )}
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

      {isStockAuthorized &&
        mode !== 'stock-movements' &&
        missingOfficialProducts.length > 0 && (
          <div className="p-3.5 rounded-xl bg-sky-50 border border-sky-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-xs text-sky-950">
              <span className="font-semibold">
                {missingOfficialProducts.length} Glacetor product SKU(s) ready to import
              </span>
              <span className="text-sky-800">
                {' '}
                — Includes Anxiera, Sertaura-25/50, Cinnera, Empagalce-L, Nebiera-2.5/5, Losadil-25/50, Telocean-AM 40/5, Redolift-XT, D3-Qtaera 60K, Tizidip MR, Nicoera-5/10, Ranolock-500, and Qtaera CD3.
              </span>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={handleSyncOfficialCatalog}
              className="px-3.5 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg shrink-0 disabled:opacity-60"
            >
              {saving
                ? 'Adding Products...'
                : `Add All (${missingOfficialProducts.length})`}
            </button>
          </div>
        )}

      {mode === 'stock-movements' ? (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {stockMovements.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              No stock movements logged yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Type & Product</th>
                    <th className="px-4 py-3 font-semibold">Batch</th>
                    <th className="px-4 py-3 font-semibold">Route / Allocation</th>
                    <th className="px-4 py-3 font-semibold text-right">Qty</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Timestamp</th>
                    {isStockAuthorized && (
                      <th className="px-4 py-3 font-semibold text-right">Action</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {stockMovements.map((m) => (
                    <tr key={m.id}>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-900">{m.movementType}</div>
                        <div className="text-slate-500">{m.productName}</div>
                      </td>
                      <td className="px-4 py-3 font-mono">{m.batchNumber}</td>
                      <td className="px-4 py-3">
                        <div>
                          {m.fromLocation || 'Warehouse'} → {m.targetName || m.toLocation || 'Market'}
                        </div>
                        <div className="text-slate-400">{m.reason}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold">
                        {m.quantity}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`font-semibold ${
                            m.status === 'Approved'
                              ? 'text-[#15803D]'
                              : m.status === 'Rejected'
                              ? 'text-red-700'
                              : 'text-amber-700'
                          }`}
                        >
                          {m.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-500">
                        {formatTimestamp(m.createdAt)}
                      </td>
                      {isStockAuthorized && (
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {m.status === 'Pending Approval' && (
                            <div className="inline-flex gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleApprovePendingMovement(m, 'Approved')}
                                className="px-2 py-1 bg-[#15803D] text-white rounded text-[11px]"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                onClick={() => handleApprovePendingMovement(m, 'Rejected')}
                                className="px-2 py-1 bg-red-700 text-white rounded text-[11px]"
                              >
                                Reject
                              </button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Search & Alert Filter Bar */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row gap-3 items-stretch md:items-center">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search SKU, product name, batch number, or category..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(['ALL', 'LOW', 'EXPIRY'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilterAlert(f)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                    filterAlert === f
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  {f === 'ALL' ? 'All Batches' : f === 'LOW' ? 'Low Stock' : 'Expiring ≤90d'}
                </button>
              ))}
            </div>
          </div>

          {filteredProducts.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
              <Package className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <div className="text-sm font-medium text-slate-700">No products found</div>
            </div>
          ) : mode === 'products' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredProducts.map((p) => {
                const { productName, saltName } = splitProductAndSaltName(p.name);
                return (
                  <div
                    key={p.id}
                    className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between space-y-3"
                  >
                    <div>
                      <h3 className="text-base font-bold text-[#0F2744] leading-snug">
                        {productName}
                      </h3>
                      {saltName ? (
                        <p className="text-xs font-medium text-slate-600 mt-1 leading-relaxed">
                          {saltName}
                        </p>
                      ) : (
                        <p className="text-xs text-slate-500 mt-1">
                          {p.category} · {p.unit}
                        </p>
                      )}
                    </div>

                    <div className="pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs gap-2">
                      <div className="font-mono font-semibold tabular-nums">
                        {p.sellingPrice > 0 ? (
                          <span className="text-slate-900">
                            MRP {formatCurrency(p.sellingPrice)}
                          </span>
                        ) : (
                          <span className="text-amber-700 font-sans font-medium">
                            MRP not set
                          </span>
                        )}
                      </div>
                      {isStockAuthorized && (
                        <button
                          type="button"
                          onClick={() => openEditProduct(p)}
                          className="px-3 py-1.5 text-xs font-medium text-[#0F2744] bg-slate-100 hover:bg-slate-200 rounded-lg shrink-0"
                        >
                          {p.sellingPrice > 0 ? 'Edit' : 'Set MRP / Edit'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">SKU / Product</th>
                      <th className="px-4 py-3 font-semibold">Batch & Dates</th>
                      <th className="px-4 py-3 font-semibold">Warehouse</th>
                      <th className="px-4 py-3 font-semibold text-right">Available</th>
                      <th className="px-4 py-3 font-semibold text-right">Min Level</th>
                      <th className="px-4 py-3 font-semibold text-right">Selling Price</th>
                      <th className="px-4 py-3 font-semibold">Health</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredProducts.map((p) => {
                      const isLow = p.availableStock <= p.minStockLevel;
                      const expDays = daysUntilDate(p.expiryDate);
                      return (
                        <tr key={p.id} className="hover:bg-slate-50/70">
                          <td className="px-4 py-3">
                            <div className="font-semibold text-slate-900">{p.name}</div>
                            <div className="font-mono text-slate-500">
                              {p.sku} · {p.category}
                            </div>
                          </td>
                          <td className="px-4 py-3 font-mono">
                            <div className="font-semibold text-slate-800">{p.batchNumber}</div>
                            <div className="text-slate-500">Exp: {p.expiryDate}</div>
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            {p.warehouse || 'Central Depot'}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums font-bold text-slate-900">
                            {p.availableStock} {p.unit}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-500">
                            {p.minStockLevel}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            {p.sellingPrice > 0 ? formatCurrency(p.sellingPrice) : 'Not set'}
                          </td>
                          <td className="px-4 py-3">
                            {expDays <= 90 ? (
                              <span className="inline-flex items-center gap-1 text-red-700 font-semibold">
                                <AlertTriangle className="w-3.5 h-3.5" /> Exp ≤90d
                              </span>
                            ) : isLow ? (
                              <span className="inline-flex items-center gap-1 text-amber-700 font-semibold">
                                <AlertTriangle className="w-3.5 h-3.5" /> Low Stock
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[#15803D] font-semibold">
                                <Check className="w-3.5 h-3.5" /> Healthy
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Employee & Distributor Allocations Summary */}
          {allocations.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-slate-900 mb-3">
                Employee & Distributor Stock Allocations
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="border-b border-slate-200 text-slate-500">
                    <tr>
                      <th className="py-2 font-medium">Holder</th>
                      <th className="py-2 font-medium">Role</th>
                      <th className="py-2 font-medium">Product / Batch</th>
                      <th className="py-2 font-medium text-right">Allocated</th>
                      <th className="py-2 font-medium text-right">Remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocations.map((a) => (
                      <tr key={a.id} className="border-b border-slate-100">
                        <td className="py-2 font-semibold text-slate-900">{a.holderName}</td>
                        <td className="py-2 text-slate-600">{a.holderRole}</td>
                        <td className="py-2">
                          {a.productName} <span className="font-mono">({a.batchNumber})</span>
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums">{a.allocatedQty}</td>
                        <td className="py-2 text-right font-mono tabular-nums font-semibold text-[#15803D]">
                          {a.remainingQty}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Add/Edit Product Modal */}
      {showProductModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">
                {editingProduct ? 'Edit Pharmaceutical Batch' : 'Add Pharmaceutical Product'}
              </h3>
              <button
                type="button"
                onClick={() => setShowProductModal(false)}
                className="p-1.5 text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Product Name
                  </label>
                  <input
                    type="text"
                    required
                    value={pName}
                    onChange={(e) => setPName(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    SKU
                  </label>
                  <input
                    type="text"
                    required
                    value={pSku}
                    onChange={(e) => setPSku(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Category
                  </label>
                  <input
                    type="text"
                    required
                    value={pCategory}
                    onChange={(e) => setPCategory(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Brand
                  </label>
                  <input
                    type="text"
                    required
                    value={pBrand}
                    onChange={(e) => setPBrand(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Packaging Unit
                  </label>
                  <input
                    type="text"
                    required
                    value={pUnit}
                    onChange={(e) => setPUnit(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Batch Number
                  </label>
                  <input
                    type="text"
                    required
                    value={pBatch}
                    onChange={(e) => setPBatch(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Mfg Date
                  </label>
                  <input
                    type="date"
                    required
                    value={pMfg}
                    onChange={(e) => setPMfg(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Expiry Date
                  </label>
                  <input
                    type="date"
                    required
                    value={pExp}
                    onChange={(e) => setPExp(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Purchase Price
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={pPurchase}
                    onChange={(e) => setPPurchase(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    MRP / Selling Price (₹)
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    required
                    value={pSelling}
                    onChange={(e) => setPSelling(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                {!editingProduct && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Opening Stock
                    </label>
                    <input
                      type="number"
                      required
                      value={pOpening}
                      onChange={(e) => setPOpening(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Min Stock Alert
                  </label>
                  <input
                    type="number"
                    required
                    value={pMin}
                    onChange={(e) => setPMin(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Warehouse Location
                  </label>
                  <input
                    type="text"
                    value={pWarehouse}
                    onChange={(e) => setPWarehouse(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Product Packaging Visual
                  </label>
                  <select
                    value={pImageUrl}
                    onChange={(e) => setPImageUrl(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {PRESET_PRODUCT_IMAGES.map((img) => (
                      <option key={img.url} value={img.url}>
                        {img.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowProductModal(false)}
                  className="px-4 py-2 text-xs text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
                >
                  {saving ? 'Saving...' : 'Save Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Stock Movement Modal */}
      {showMovementModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">
                Record Atomic Stock Transaction
              </h3>
              <button
                type="button"
                onClick={() => setShowMovementModal(false)}
                className="p-1.5 text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleStockMovementSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Product & Batch
                </label>
                <select
                  required
                  value={mProductId}
                  onChange={(e) => setMProductId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">Select product...</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} (Batch {p.batchNumber} · Avail: {p.availableStock})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Movement Type
                  </label>
                  <select
                    value={mType}
                    onChange={(e) => setMType(e.target.value as StockMovementType)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="Stock In">Stock In</option>
                    <option value="Stock Out">Stock Out</option>
                    <option value="Stock Transfer">Stock Transfer</option>
                    <option value="Stock Return">Stock Return</option>
                    <option value="Stock Adjustment">Stock Adjustment</option>
                    <option value="Allocation">Allocate to Rep / Distributor</option>
                    <option value="Damaged">Damaged Stock</option>
                    <option value="Expired">Expired Write-Off</option>
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
                    value={mQty}
                    onChange={(e) => setMQty(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              {mType === 'Allocation' ? (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Allocate To Role
                    </label>
                    <select
                      value={mTargetRole}
                      onChange={(e) => {
                        setMTargetRole(e.target.value as 'Employee' | 'Distributor');
                        setMTargetUid('');
                      }}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="Employee">Field Employee</option>
                      <option value="Distributor">Distributor</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Recipient
                    </label>
                    <select
                      required
                      value={mTargetUid}
                      onChange={(e) => setMTargetUid(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">Select recipient...</option>
                      {mTargetRole === 'Employee'
                        ? employees.map((em) => (
                            <option key={em.id} value={em.uid || em.id}>
                              {em.fullName}
                            </option>
                          ))
                        : distributors.map((d) => (
                            <option key={d.id} value={d.uid || d.id}>
                              {d.companyName}
                            </option>
                          ))}
                    </select>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      From Location
                    </label>
                    <input
                      type="text"
                      value={mFrom}
                      onChange={(e) => setMFrom(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      To Location
                    </label>
                    <input
                      type="text"
                      value={mTo}
                      onChange={(e) => setMTo(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Reason / Reference Note
                </label>
                <input
                  type="text"
                  required
                  value={mReason}
                  onChange={(e) => setMReason(e.target.value)}
                  placeholder="e.g. GRN #442, Batch damage audit, Territory dispatch"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={mRequireApproval}
                  onChange={(e) => setMRequireApproval(e.target.checked)}
                />
                Route through Pending Approval queue before adjusting available stock
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowMovementModal(false)}
                  className="px-4 py-2 text-xs text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
                >
                  {saving ? 'Recording...' : 'Commit Movement'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Batch Inventory CSV Import Modal */}
      {showCsvModal && isStockAuthorized && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4 text-[#0F2744]" />
                  Upload Batch Inventory CSV
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Parse CSV batch sheets, map columns to Product &amp; StockMovement schemas, and preview stock changes before saving.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCsvModal(false)}
                className="p-1.5 text-slate-500 hover:text-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {csvError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs">
                {csvError}
              </div>
            )}

            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={csvFileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleCsvFileSelect}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => csvFileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg"
                >
                  <Upload className="w-3.5 h-3.5" />
                  {csvFileName ? 'Choose Different CSV' : 'Select CSV File'}
                </button>
                <span className="text-xs text-slate-600">
                  {csvFileName
                    ? `${csvFileName} (${parsedCsv?.rows.length || 0} row(s))`
                    : 'Supports UTF-8 CSV with Product, SKU, Batch, Quantity, Movement Type, MRP, Dates & Warehouse.'}
                </span>
              </div>
              <button
                type="button"
                onClick={() =>
                  exportToCsv(
                    'glacetor-batch-inventory-template.csv',
                    CSV_TEMPLATE_HEADERS,
                    CSV_TEMPLATE_SAMPLE_ROWS
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#0F2744] bg-white border border-slate-300 hover:bg-slate-100 rounded-lg shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                Download Sample CSV
              </button>
            </div>

            {parsedCsv && parsedCsv.headers.length > 0 && (
              <>
                {/* Column Schema Mapping */}
                <div className="border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="text-xs font-semibold text-slate-900">
                    Column Mapping (Product &amp; StockMovement Schemas)
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    {(
                      [
                        { key: 'productName', label: 'Product Name *' },
                        { key: 'sku', label: 'SKU *' },
                        { key: 'batchNumber', label: 'Batch Number' },
                        { key: 'quantity', label: 'Quantity' },
                        { key: 'movementType', label: 'Movement Type' },
                        { key: 'sellingPrice', label: 'MRP / Selling Price' },
                        { key: 'purchasePrice', label: 'Purchase Price' },
                        { key: 'mfgDate', label: 'Mfg Date' },
                        { key: 'expiryDate', label: 'Expiry Date' },
                        { key: 'warehouse', label: 'Warehouse' },
                        { key: 'category', label: 'Category' },
                        { key: 'unit', label: 'Packaging Unit' },
                        { key: 'minStockLevel', label: 'Min Stock Alert' },
                        { key: 'fromLocation', label: 'From Location' },
                        { key: 'toLocation', label: 'To Location' },
                        { key: 'reason', label: 'Movement Reason' },
                      ] as { key: CsvInventoryField; label: string }[]
                    ).map((field) => (
                      <div key={field.key}>
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">
                          {field.label}
                        </label>
                        <select
                          value={
                            typeof csvMapping[field.key] === 'number'
                              ? String(csvMapping[field.key])
                              : ''
                          }
                          onChange={(e) => {
                            const val = e.target.value;
                            setCsvMapping((prev) => {
                              const next = { ...prev };
                              if (val === '') delete next[field.key];
                              else next[field.key] = Number(val);
                              return next;
                            });
                          }}
                          className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                        >
                          <option value="">— Not Mapped —</option>
                          {parsedCsv.headers.map((h, idx) => (
                            <option key={`${h}-${idx}`} value={idx}>
                              {h || `Column ${idx + 1}`}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Validation Summary */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-slate-500">Valid Rows</div>
                    <div className="font-mono font-bold text-slate-900 text-sm">
                      {csvSummary.validCount}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200">
                    <div className="text-emerald-800">New Batches</div>
                    <div className="font-mono font-bold text-emerald-900 text-sm">
                      {csvSummary.createCount}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-sky-50 border border-sky-200">
                    <div className="text-sky-800">Batch Updates</div>
                    <div className="font-mono font-bold text-sky-900 text-sm">
                      {csvSummary.updateCount}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-slate-500">Movements</div>
                    <div className="font-mono font-bold text-slate-900 text-sm">
                      {csvSummary.movementCount}
                    </div>
                  </div>
                  <div
                    className={`p-2.5 rounded-lg border ${
                      csvSummary.errorCount > 0
                        ? 'bg-red-50 border-red-200'
                        : 'bg-slate-50 border-slate-200'
                    }`}
                  >
                    <div
                      className={
                        csvSummary.errorCount > 0 ? 'text-red-700' : 'text-slate-500'
                      }
                    >
                      Row Errors
                    </div>
                    <div
                      className={`font-mono font-bold text-sm ${
                        csvSummary.errorCount > 0 ? 'text-red-800' : 'text-slate-900'
                      }`}
                    >
                      {csvSummary.errorCount}
                    </div>
                  </div>
                </div>

                {/* Row Preview Table */}
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto max-h-64 overflow-y-auto">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 sticky top-0">
                        <tr>
                          <th className="px-3 py-2 font-semibold">Row</th>
                          <th className="px-3 py-2 font-semibold">Action</th>
                          <th className="px-3 py-2 font-semibold">Product &amp; SKU</th>
                          <th className="px-3 py-2 font-semibold">Batch &amp; Exp</th>
                          <th className="px-3 py-2 font-semibold">Movement</th>
                          <th className="px-3 py-2 font-semibold text-right">Stock</th>
                          <th className="px-3 py-2 font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {mappedCsvRows.map((r) => (
                          <tr
                            key={r.rowNumber}
                            className={r.error ? 'bg-red-50/70' : 'hover:bg-slate-50/60'}
                          >
                            <td className="px-3 py-2 font-mono text-slate-500">
                              #{r.rowNumber}
                            </td>
                            <td className="px-3 py-2 font-medium">
                              {r.action === 'create_product' ? (
                                <span className="text-[#15803D]">New Batch</span>
                              ) : (
                                <span className="text-[#0F2744]">Update Batch</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <div className="font-semibold text-slate-900">
                                {r.productName || '—'}
                              </div>
                              <div className="font-mono text-slate-500">
                                {r.sku || '—'}
                              </div>
                            </td>
                            <td className="px-3 py-2 font-mono">
                              <div>{r.batchNumber || '—'}</div>
                              <div className="text-slate-500">Exp {r.expiryDate}</div>
                            </td>
                            <td className="px-3 py-2">
                              <div>
                                {r.movementType} ({r.quantity})
                              </div>
                              <div className="text-slate-400 truncate max-w-[160px]">
                                {r.reason}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums">
                              {r.previousStock} → <strong>{r.newStock}</strong>
                            </td>
                            <td className="px-3 py-2">
                              {r.error ? (
                                <span className="text-red-700 font-medium">
                                  {r.error}
                                </span>
                              ) : (
                                <span className="text-[#15803D] font-semibold">Ready</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowCsvModal(false)}
                className="px-4 py-2 text-xs text-slate-600 hover:bg-slate-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={importingCsv || csvSummary.validCount === 0}
                onClick={handleCommitCsvImport}
                className="px-5 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg disabled:opacity-50"
              >
                {importingCsv
                  ? 'Importing...'
                  : `Import ${csvSummary.validCount} Valid Row(s)`}
              </button>
            </div>
          </div>
        </div>
      )}

      <InventoryReorderAdvisor
        isOpen={showReorderAdvisor}
        onClose={() => setShowReorderAdvisor(false)}
        currentUser={currentUser}
        products={products}
        salesOrders={salesOrders}
        stockMovements={stockMovements}
      />
    </div>
  );
};
