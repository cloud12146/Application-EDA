import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import { logActivity } from './erpActions';
import { generateId, todayIsoDate } from './utils';
import { Product, StockMovementType } from '../types/erp';

export type CsvInventoryField =
  | 'productName'
  | 'sku'
  | 'batchNumber'
  | 'category'
  | 'brand'
  | 'unit'
  | 'mfgDate'
  | 'expiryDate'
  | 'purchasePrice'
  | 'sellingPrice'
  | 'quantity'
  | 'minStockLevel'
  | 'warehouse'
  | 'movementType'
  | 'fromLocation'
  | 'toLocation'
  | 'reason';

export type CsvColumnMapping = Partial<Record<CsvInventoryField, number>>;

export interface ParsedCsvData {
  headers: string[];
  rows: string[][];
}

export interface MappedInventoryRow {
  rowNumber: number;
  action: 'create_product' | 'update_product';
  matchedProductId?: string;
  productName: string;
  sku: string;
  batchNumber: string;
  category: string;
  brand: string;
  unit: string;
  mfgDate: string;
  expiryDate: string;
  purchasePrice?: number;
  sellingPrice?: number;
  minStockLevel?: number;
  warehouse: string;
  movementType: StockMovementType;
  quantity: number;
  previousStock: number;
  newStock: number;
  damagedDelta: number;
  fromLocation: string;
  toLocation: string;
  reason: string;
  error?: string;
}

const VALID_MOVEMENT_TYPES: StockMovementType[] = [
  'Stock In',
  'Stock Out',
  'Stock Transfer',
  'Stock Return',
  'Stock Adjustment',
  'Damaged',
  'Expired',
  'Allocation',
];

const HEADER_ALIASES: Record<CsvInventoryField, string[]> = {
  productName: ['productname', 'product', 'name', 'itemname', 'item', 'medicine', 'drugname'],
  sku: ['sku', 'productcode', 'itemcode', 'code', 'skucode'],
  batchNumber: ['batchnumber', 'batchno', 'batch', 'lotnumber', 'lotno', 'lot'],
  category: ['category', 'therapeuticcategory', 'therapeuticclass', 'group', 'type'],
  brand: ['brand', 'division', 'manufacturer', 'company'],
  unit: ['unit', 'pack', 'packing', 'packaging', 'uom', 'packsize'],
  mfgDate: ['mfgdate', 'mfg', 'manufacturingdate', 'mfd'],
  expiryDate: ['expirydate', 'expiry', 'expdate', 'exp'],
  purchasePrice: ['purchaseprice', 'pts', 'ptr', 'costprice', 'cost', 'rate', 'purchaserate'],
  sellingPrice: ['sellingprice', 'mrp', 'price', 'sellingrate', 'retailprice'],
  quantity: ['quantity', 'qty', 'stock', 'openingstock', 'availablestock', 'units', 'count'],
  minStockLevel: ['minstocklevel', 'minstock', 'reorderlevel', 'minlevel', 'minqty', 'alertlevel'],
  warehouse: ['warehouse', 'depot', 'location', 'branch', 'godown', 'store'],
  movementType: ['movementtype', 'transactiontype', 'txtype', 'movement', 'stockaction'],
  fromLocation: ['fromlocation', 'from', 'source', 'origin'],
  toLocation: ['tolocation', 'to', 'destination', 'target'],
  reason: ['reason', 'notes', 'note', 'remarks', 'remark', 'reference', 'grn'],
};

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * RFC-4180 CSV parser supporting quoted fields, embedded commas, escaped quotes,
 * CRLF/LF/CR newlines, and UTF-8 BOM stripping.
 */
export function parseCsvText(rawText: string): ParsedCsvData {
  const text = rawText.replace(/^\uFEFF/, '');
  const allRows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          currentCell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      currentRow.push(currentCell.trim());
      if (currentRow.some((cell) => cell !== '')) {
        allRows.push(currentRow);
      }
      currentRow = [];
      currentCell = '';
    } else {
      currentCell += ch;
    }
  }

  currentRow.push(currentCell.trim());
  if (currentRow.some((cell) => cell !== '')) {
    allRows.push(currentRow);
  }

  if (allRows.length === 0) {
    return { headers: [], rows: [] };
  }

  const [headers, ...rows] = allRows;
  return { headers, rows };
}

export function autoDetectCsvMapping(headers: string[]): CsvColumnMapping {
  const mapping: CsvColumnMapping = {};
  const normalizedHeaders = headers.map(normalizeHeader);

  (Object.keys(HEADER_ALIASES) as CsvInventoryField[]).forEach((field) => {
    const aliases = HEADER_ALIASES[field];
    // Exact alias match first
    let foundIdx = normalizedHeaders.findIndex((h) => aliases.includes(h));
    // Fallback substring match for compound headers like "Batch Number (Lot)"
    if (foundIdx === -1) {
      foundIdx = normalizedHeaders.findIndex((h) =>
        aliases.some((alias) => alias.length >= 4 && h.includes(alias))
      );
    }
    if (foundIdx !== -1) {
      mapping[field] = foundIdx;
    }
  });

  return mapping;
}

function normalizeIsoDate(raw: string, fallback: string): { date: string; valid: boolean } {
  const clean = raw.trim();
  if (!clean) return { date: fallback, valid: true };

  // YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = clean.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return {
        date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        valid: true,
      };
    }
  }

  // DD-MM-YYYY or DD/MM/YYYY
  const dmyMatch = clean.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    const d = Number(dmyMatch[1]);
    const m = Number(dmyMatch[2]);
    const y = Number(dmyMatch[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return {
        date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        valid: true,
      };
    }
  }

  return { date: clean, valid: false };
}

function parseMovementType(raw: string): StockMovementType {
  const clean = raw.trim().toLowerCase();
  if (!clean) return 'Stock In';
  const exact = VALID_MOVEMENT_TYPES.find((t) => t.toLowerCase() === clean);
  if (exact) return exact;

  if (clean.includes('out') || clean.includes('issue') || clean.includes('sale')) {
    return 'Stock Out';
  }
  if (clean.includes('transfer')) return 'Stock Transfer';
  if (clean.includes('return')) return 'Stock Return';
  if (clean.includes('damage')) return 'Damaged';
  if (clean.includes('expir')) return 'Expired';
  if (clean.includes('adjust')) return 'Stock Adjustment';
  if (clean.includes('alloc')) return 'Allocation';
  return 'Stock In';
}

function defaultExpiryFrom(mfgIso: string): string {
  const year = Number(mfgIso.slice(0, 4)) || new Date().getFullYear();
  return `${year + 2}${mfgIso.slice(4)}`;
}

function parseOptionalNumber(raw: string): number | undefined {
  const clean = raw.replace(/[₹,\s]/g, '').trim();
  if (!clean) return undefined;
  const num = Number(clean);
  return Number.isFinite(num) ? num : NaN;
}

export function mapCsvRowsToInventory(
  parsed: ParsedCsvData,
  mapping: CsvColumnMapping,
  existingProducts: Product[]
): MappedInventoryRow[] {
  const today = todayIsoDate();

  // Working stock state so multiple rows targeting the same SKU/batch accumulate accurately
  const workingById = new Map<string, { product: Product; available: number; damaged: number }>();
  const idBySkuBatch = new Map<string, string>();
  const idBySkuOnly = new Map<string, string>();
  const idByNameBatch = new Map<string, string>();

  for (const p of existingProducts) {
    workingById.set(p.id, {
      product: p,
      available: Number(p.availableStock) || 0,
      damaged: Number(p.damagedStock) || 0,
    });
    const skuKey = (p.sku || '').trim().toLowerCase();
    const batchKey = (p.batchNumber || '').trim().toLowerCase();
    const nameKey = (p.name || '').trim().toLowerCase();
    if (skuKey && batchKey) idBySkuBatch.set(`${skuKey}::${batchKey}`, p.id);
    if (skuKey && !idBySkuOnly.has(skuKey)) idBySkuOnly.set(skuKey, p.id);
    if (nameKey && batchKey) idByNameBatch.set(`${nameKey}::${batchKey}`, p.id);
  }

  const getCell = (row: string[], field: CsvInventoryField): string => {
    const idx = mapping[field];
    if (typeof idx !== 'number' || idx < 0 || idx >= row.length) return '';
    return (row[idx] || '').trim();
  };

  return parsed.rows.map((row, index) => {
    const rowNumber = index + 2; // 1-indexed including header row
    const rawName = getCell(row, 'productName');
    const rawSku = getCell(row, 'sku');
    const rawBatch = getCell(row, 'batchNumber');
    const rawCategory = getCell(row, 'category');
    const rawBrand = getCell(row, 'brand');
    const rawUnit = getCell(row, 'unit');
    const rawMfg = getCell(row, 'mfgDate');
    const rawExp = getCell(row, 'expiryDate');
    const rawPurchase = getCell(row, 'purchasePrice');
    const rawSelling = getCell(row, 'sellingPrice');
    const rawQty = getCell(row, 'quantity');
    const rawMin = getCell(row, 'minStockLevel');
    const rawWarehouse = getCell(row, 'warehouse');
    const rawMovType = getCell(row, 'movementType');
    const rawFrom = getCell(row, 'fromLocation');
    const rawTo = getCell(row, 'toLocation');
    const rawReason = getCell(row, 'reason');

    const skuLower = rawSku.toLowerCase();
    const batchLower = rawBatch.toLowerCase();
    const nameLower = rawName.toLowerCase();

    let matchedId: string | undefined;
    if (skuLower && batchLower) {
      matchedId = idBySkuBatch.get(`${skuLower}::${batchLower}`);
    }
    if (!matchedId && nameLower && batchLower) {
      matchedId = idByNameBatch.get(`${nameLower}::${batchLower}`);
    }
    if (!matchedId && skuLower && !rawBatch) {
      matchedId = idBySkuOnly.get(skuLower);
    }

    const matchedState = matchedId ? workingById.get(matchedId) : undefined;
    const matchedProd = matchedState?.product;

    const productName = (rawName || matchedProd?.name || '').slice(0, 160);
    const sku = (rawSku || matchedProd?.sku || '').slice(0, 64);
    const batchNumber = (
      rawBatch ||
      matchedProd?.batchNumber ||
      `BTH${today.slice(2, 7).replace('-', '')}`
    ).slice(0, 64);

    const category = (rawCategory || matchedProd?.category || 'Pharmaceuticals').slice(0, 80);
    const brand = (rawBrand || matchedProd?.brand || 'Glacetor Remedies').slice(0, 80);
    const unit = (rawUnit || matchedProd?.unit || 'Box (10x10)').slice(0, 40);
    const warehouse = (rawWarehouse || matchedProd?.warehouse || 'Central Warehouse').slice(0, 120);

    const mfgRes = normalizeIsoDate(rawMfg, matchedProd?.mfgDate || today);
    const expRes = normalizeIsoDate(
      rawExp,
      matchedProd?.expiryDate || defaultExpiryFrom(mfgRes.date)
    );

    const parsedPurchase = parseOptionalNumber(rawPurchase);
    const parsedSelling = parseOptionalNumber(rawSelling);
    const parsedMin = parseOptionalNumber(rawMin);
    const parsedQty = parseOptionalNumber(rawQty);

    const movementType = parseMovementType(rawMovType);
    const signedQty = parsedQty === undefined ? 0 : parsedQty;
    const absQty = Math.abs(signedQty);

    const errors: string[] = [];
    if (!productName) errors.push('Missing Product Name');
    if (!sku) errors.push('Missing SKU');
    if (!batchNumber) errors.push('Missing Batch Number');
    if (!mfgRes.valid) errors.push(`Invalid Mfg Date "${rawMfg}"`);
    if (!expRes.valid) errors.push(`Invalid Expiry Date "${rawExp}"`);
    if (parsedPurchase !== undefined && (Number.isNaN(parsedPurchase) || parsedPurchase < 0)) {
      errors.push(`Invalid Purchase Price "${rawPurchase}"`);
    }
    if (parsedSelling !== undefined && (Number.isNaN(parsedSelling) || parsedSelling < 0)) {
      errors.push(`Invalid MRP / Selling Price "${rawSelling}"`);
    }
    if (parsedMin !== undefined && (Number.isNaN(parsedMin) || parsedMin < 0)) {
      errors.push(`Invalid Min Stock "${rawMin}"`);
    }
    if (parsedQty !== undefined && Number.isNaN(parsedQty)) {
      errors.push(`Invalid Quantity "${rawQty}"`);
    } else if (signedQty < 0 && movementType !== 'Stock Adjustment') {
      errors.push('Negative quantity only allowed with Stock Adjustment');
    }

    const previousStock = matchedState ? matchedState.available : 0;
    let newStock = previousStock;
    let damagedDelta = 0;

    if (errors.length === 0) {
      if (!matchedState) {
        if (
          movementType === 'Stock Out' ||
          movementType === 'Stock Transfer' ||
          movementType === 'Damaged' ||
          movementType === 'Expired'
        ) {
          errors.push(`Cannot record ${movementType} on non-existent batch`);
        } else {
          newStock = Math.max(0, absQty);
        }
      } else {
        const isAdd =
          movementType === 'Stock In' || movementType === 'Stock Return';
        const isDeduct =
          movementType === 'Stock Out' ||
          movementType === 'Stock Transfer' ||
          movementType === 'Damaged' ||
          movementType === 'Expired' ||
          movementType === 'Allocation';

        if (isAdd) {
          newStock = previousStock + absQty;
        } else if (isDeduct) {
          if (previousStock < absQty) {
            errors.push(
              `Insufficient stock (${previousStock} available, requested ${absQty})`
            );
          } else {
            newStock = previousStock - absQty;
            if (movementType === 'Damaged') {
              damagedDelta = absQty;
            }
          }
        } else {
          // Stock Adjustment
          newStock = Math.max(0, previousStock + signedQty);
        }
      }
    }

    const mappedRow: MappedInventoryRow = {
      rowNumber,
      action: matchedProd ? 'update_product' : 'create_product',
      matchedProductId: matchedProd?.id,
      productName,
      sku,
      batchNumber,
      category,
      brand,
      unit,
      mfgDate: mfgRes.date.slice(0, 20),
      expiryDate: expRes.date.slice(0, 20),
      ...(parsedPurchase !== undefined && !Number.isNaN(parsedPurchase)
        ? { purchasePrice: parsedPurchase }
        : {}),
      ...(parsedSelling !== undefined && !Number.isNaN(parsedSelling)
        ? { sellingPrice: parsedSelling }
        : {}),
      ...(parsedMin !== undefined && !Number.isNaN(parsedMin)
        ? { minStockLevel: parsedMin }
        : {}),
      warehouse,
      movementType,
      quantity: absQty,
      previousStock,
      newStock,
      damagedDelta,
      fromLocation: (
        rawFrom ||
        (movementType === 'Stock In' ? 'Supplier / Plant' : warehouse)
      ).slice(0, 120),
      toLocation: (
        rawTo ||
        (movementType === 'Stock In' ? warehouse : 'Field / Market')
      ).slice(0, 120),
      reason: (rawReason || 'CSV Batch Inventory Import').slice(0, 400),
      ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    };

    if (!mappedRow.error && matchedState) {
      matchedState.available = newStock;
      matchedState.damaged += damagedDelta;
    } else if (!mappedRow.error && !matchedState) {
      const syntheticId = `pending_${skuLower}_${batchLower}_${rowNumber}`;
      const syntheticProd: Product = {
        id: syntheticId,
        name: productName,
        sku,
        category,
        brand,
        unit,
        batchNumber,
        mfgDate: mappedRow.mfgDate,
        expiryDate: mappedRow.expiryDate,
        purchasePrice: mappedRow.purchasePrice ?? 0,
        sellingPrice: mappedRow.sellingPrice ?? 0,
        openingStock: newStock,
        availableStock: newStock,
        minStockLevel: mappedRow.minStockLevel ?? 50,
        damagedStock: 0,
        warehouse,
        createdAt: null,
        updatedAt: null,
      };
      workingById.set(syntheticId, {
        product: syntheticProd,
        available: newStock,
        damaged: 0,
      });
      if (skuLower && batchLower) {
        idBySkuBatch.set(`${skuLower}::${batchLower}`, syntheticId);
      }
      if (nameLower && batchLower) {
        idByNameBatch.set(`${nameLower}::${batchLower}`, syntheticId);
      }
    }

    return mappedRow;
  });
}

export async function commitCsvInventoryImport(params: {
  rows: MappedInventoryRow[];
  existingProducts: Product[];
  performedByUid: string;
  performedByName: string;
}): Promise<{ createdCount: number; updatedCount: number; movementsCount: number }> {
  const validRows = params.rows.filter((r) => !r.error);
  if (validRows.length === 0) {
    throw new Error('No valid rows to import.');
  }

  const createdProductIdBySynthetic = new Map<string, string>();
  const existingById = new Map(params.existingProducts.map((p) => [p.id, p]));

  type WriteOp = (batch: ReturnType<typeof writeBatch>) => void;
  const ops: WriteOp[] = [];

  type ProductPlan = {
    isNew: boolean;
    id: string;
    productName: string;
    sku: string;
    category: string;
    brand: string;
    unit: string;
    batchNumber: string;
    mfgDate: string;
    expiryDate: string;
    purchasePrice?: number;
    sellingPrice?: number;
    minStockLevel?: number;
    warehouse: string;
    openingStock: number;
    finalStock: number;
    totalDamagedDelta: number;
  };

  const productPlans = new Map<string, ProductPlan>();
  let movementsCount = 0;

  for (const row of validRows) {
    let targetProductId = row.matchedProductId;
    const isSyntheticExisting = Boolean(
      targetProductId && targetProductId.startsWith('pending_')
    );

    if (isSyntheticExisting && targetProductId) {
      targetProductId = createdProductIdBySynthetic.get(targetProductId);
    }

    if (!targetProductId) {
      targetProductId = generateId('prd');
      const syntheticKey = `pending_${row.sku.toLowerCase()}_${row.batchNumber.toLowerCase()}_${row.rowNumber}`;
      createdProductIdBySynthetic.set(syntheticKey, targetProductId);
    }

    const realProductId = targetProductId;
    const existingProd = existingById.get(realProductId);
    const existingPlan = productPlans.get(realProductId);

    if (!existingPlan) {
      productPlans.set(realProductId, {
        isNew: !existingProd,
        id: realProductId,
        productName: row.productName,
        sku: row.sku,
        category: row.category,
        brand: row.brand,
        unit: row.unit,
        batchNumber: row.batchNumber,
        mfgDate: row.mfgDate,
        expiryDate: row.expiryDate,
        purchasePrice: row.purchasePrice,
        sellingPrice: row.sellingPrice,
        minStockLevel: row.minStockLevel,
        warehouse: row.warehouse,
        openingStock: row.newStock,
        finalStock: row.newStock,
        totalDamagedDelta: row.damagedDelta,
      });
    } else {
      existingPlan.finalStock = row.newStock;
      existingPlan.totalDamagedDelta += row.damagedDelta;
      if (typeof row.purchasePrice === 'number') {
        existingPlan.purchasePrice = row.purchasePrice;
      }
      if (typeof row.sellingPrice === 'number') {
        existingPlan.sellingPrice = row.sellingPrice;
      }
      if (typeof row.minStockLevel === 'number') {
        existingPlan.minStockLevel = row.minStockLevel;
      }
      if (row.warehouse) {
        existingPlan.warehouse = row.warehouse;
      }
    }

    // StockMovement rule requires quantity > 0
    if (row.quantity > 0) {
      movementsCount += 1;
      const movementId = generateId('stk');
      ops.push((batch) => {
        batch.set(doc(db, 'stockMovements', movementId), {
          id: movementId,
          productId: realProductId,
          productName: row.productName,
          sku: row.sku,
          batchNumber: row.batchNumber,
          movementType: row.movementType,
          quantity: row.quantity,
          previousStock: row.previousStock,
          newStock: row.newStock,
          fromLocation: row.fromLocation,
          toLocation: row.toLocation,
          status: 'Approved',
          reason: row.reason,
          performedByUid: params.performedByUid,
          performedByName: params.performedByName.slice(0, 120),
          approvedByUid: params.performedByUid,
          isDemo: false,
          createdAt: serverTimestamp(),
        });
      });
    }
  }

  let createdCount = 0;
  let updatedCount = 0;

  for (const plan of productPlans.values()) {
    if (plan.isNew) {
      createdCount += 1;
      ops.unshift((batch) => {
        batch.set(doc(db, 'products', plan.id), {
          id: plan.id,
          name: plan.productName,
          sku: plan.sku,
          category: plan.category,
          brand: plan.brand,
          unit: plan.unit,
          batchNumber: plan.batchNumber,
          mfgDate: plan.mfgDate,
          expiryDate: plan.expiryDate,
          purchasePrice: plan.purchasePrice ?? 0,
          sellingPrice: plan.sellingPrice ?? 0,
          openingStock: plan.openingStock,
          availableStock: plan.finalStock,
          minStockLevel: plan.minStockLevel ?? 50,
          damagedStock: 0,
          warehouse: plan.warehouse,
          isDemo: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });
    } else {
      updatedCount += 1;
      const existingProd = existingById.get(plan.id);
      const baseDamaged = Number(existingProd?.damagedStock) || 0;
      ops.unshift((batch) => {
        batch.update(doc(db, 'products', plan.id), {
          availableStock: plan.finalStock,
          ...(plan.totalDamagedDelta > 0
            ? { damagedStock: baseDamaged + plan.totalDamagedDelta }
            : {}),
          ...(typeof plan.purchasePrice === 'number'
            ? { purchasePrice: plan.purchasePrice }
            : {}),
          ...(typeof plan.sellingPrice === 'number'
            ? { sellingPrice: plan.sellingPrice }
            : {}),
          ...(typeof plan.minStockLevel === 'number'
            ? { minStockLevel: plan.minStockLevel }
            : {}),
          ...(plan.warehouse ? { warehouse: plan.warehouse } : {}),
          updatedAt: serverTimestamp(),
        });
      });
    }
  }

  // Commit in chunks safely below Firestore's 500-op batch limit
  const CHUNK_SIZE = 200;
  try {
    for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
      const batch = writeBatch(db);
      const slice = ops.slice(i, i + CHUNK_SIZE);
      slice.forEach((apply) => apply(batch));
      await batch.commit();
    }

    await logActivity({
      userId: params.performedByUid,
      employeeName: params.performedByName,
      action: 'CSV Inventory Imported',
      entityType: 'products',
      details: `Imported ${validRows.length} CSV row(s): ${createdCount} new batch(es), ${updatedCount} updated, ${movementsCount} stock movement(s).`,
    });

    return { createdCount, updatedCount, movementsCount };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'products');
    return { createdCount: 0, updatedCount: 0, movementsCount: 0 };
  }
}

export const CSV_TEMPLATE_HEADERS = [
  'productName',
  'sku',
  'batchNumber',
  'category',
  'brand',
  'unit',
  'mfgDate',
  'expiryDate',
  'purchasePrice',
  'sellingPrice',
  'quantity',
  'minStockLevel',
  'warehouse',
  'movementType',
  'fromLocation',
  'toLocation',
  'reason',
];

export const CSV_TEMPLATE_SAMPLE_ROWS = [
  [
    'Anxiera (Flupentixol 0.5mg + Melitracen 10mg Tablets)',
    'GLC-ANX-01',
    'GLC26ANX2',
    'CNS & Psychiatry',
    'Glacetor Remedies',
    'Box (10x10)',
    '2026-07-01',
    '2028-06-30',
    '0',
    '0',
    '250',
    '50',
    'Central Warehouse',
    'Stock In',
    'Manufacturing Plant',
    'Central Warehouse',
    'GRN #204 New Batch Receipt',
  ],
  [
    'Telocean-AM 40/5 (Telmisartan 40mg + Amlodipine 5mg Tablets)',
    'GLC-TEL-405',
    'GLC26TAM1',
    'Cardiology',
    'Glacetor Remedies',
    'Box (10x10)',
    '2026-07-01',
    '2028-06-30',
    '0',
    '0',
    '100',
    '100',
    'Central Warehouse',
    'Stock In',
    'Supplier Depot',
    'Central Warehouse',
    'Batch Replenishment',
  ],
];
