import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import { Product } from '../types/erp';

export interface CatalogProductSeed {
  id: string;
  productName: string;
  saltName: string;
  name: string;
  sku: string;
  category: string;
  brand: string;
  unit: string;
  batchNumber: string;
  mfgDate: string;
  expiryDate: string;
  purchasePrice: number;
  sellingPrice: number;
  openingStock: number;
  availableStock: number;
  minStockLevel: number;
  warehouse: string;
  imageUrl: string;
}

function makeItem(
  id: string,
  productName: string,
  saltName: string,
  sku: string,
  category: string,
  brand: string,
  unit: string,
  batchNumber: string
): CatalogProductSeed {
  return {
    id,
    productName,
    saltName,
    name: `${productName} (${saltName})`,
    sku,
    category,
    brand,
    unit,
    batchNumber,
    mfgDate: '2026-06-01',
    expiryDate: '2028-05-31',
    purchasePrice: 0,
    sellingPrice: 0,
    openingStock: 0,
    availableStock: 0,
    minStockLevel: 50,
    warehouse: 'Central Warehouse',
    imageUrl: '',
  };
}

export const GLACETOR_OFFICIAL_PRODUCTS: CatalogProductSeed[] = [
  makeItem(
    'glc_anxiera',
    'Anxiera',
    'Flupentixol 0.5mg + Melitracen 10mg Tablets',
    'GLC-ANX-01',
    'CNS & Psychiatry',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26ANX1'
  ),
  makeItem(
    'glc_sertaura_25',
    'Sertaura-25',
    'Sertraline Tablets IP 25mg',
    'GLC-SRT-25',
    'CNS & Psychiatry',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26SR25'
  ),
  makeItem(
    'glc_sertaura_50',
    'Sertaura-50',
    'Sertraline Tablets IP 50mg',
    'GLC-SRT-50',
    'CNS & Psychiatry',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26SR50'
  ),
  makeItem(
    'glc_cinnera',
    'Cinnera',
    'Cinnarizine 20mg + Dimenhydrinate 40mg Tablets',
    'GLC-CIN-01',
    'Antivertigo',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26CIN1'
  ),
  makeItem(
    'glc_empagalce_l',
    'Empagalce-L',
    'Empagliflozin 10mg + Linagliptin 5mg Tablets',
    'GLC-EMP-105',
    'Diabetology',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26EMP1'
  ),
  makeItem(
    'glc_nebiera_2_5',
    'Nebiera-2.5',
    'Nebivolol Tablets 2.5mg',
    'GLC-NEB-25',
    'Cardiology',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26NB25'
  ),
  makeItem(
    'glc_nebiera_5',
    'Nebiera-5',
    'Nebivolol Tablets 5mg',
    'GLC-NEB-05',
    'Cardiology',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26NB05'
  ),
  makeItem(
    'glc_losadil_25',
    'Losadil-25',
    'Losartan Tablets IP 25mg',
    'GLC-LOS-25',
    'Cardiology',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26LS25'
  ),
  makeItem(
    'glc_losadil_50',
    'Losadil-50',
    'Losartan Tablets IP 50mg',
    'GLC-LOS-50',
    'Cardiology',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26LS50'
  ),
  makeItem(
    'glc_telocean_am',
    'Telocean-AM 40/5',
    'Telmisartan 40mg + Amlodipine 5mg Tablets',
    'GLC-TEL-405',
    'Cardiology',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26TAM1'
  ),
  makeItem(
    'glc_redolift_xt',
    'Redolift-XT',
    'Methylcobalamin 1500mcg + Folic Acid 1.5mg + Ferrous Ascorbate 100mg + Zinc 22.5mg Tablets',
    'GLC-RED-XT',
    'Hematinics',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26RDX1'
  ),
  makeItem(
    'glc_d3_qtaera_60k',
    'D3-Qtaera 60K',
    'Cholecalciferol (Vitamin D3) IP 60,000 IU',
    'GLC-D3Q-60K',
    'Vitamin D',
    'Glacetor Remedies',
    'Box (10x4 Caps)',
    'GLC26D3Q1'
  ),
  makeItem(
    'glc_tizidip_mr',
    'Tizidip MR',
    'Trimetazidine 35mg Modified Release Tablets',
    'GLC-TIZ-35',
    'Cardiology',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26TIZ1'
  ),
  makeItem(
    'glc_nicoera_5',
    'Nicoera-5',
    'Nicorandil Tablets 5mg',
    'GLC-NIC-05',
    'Cardiology',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26NC05'
  ),
  makeItem(
    'glc_nicoera_10',
    'Nicoera-10',
    'Nicorandil Tablets 10mg',
    'GLC-NIC-10',
    'Cardiology',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26NC10'
  ),
  makeItem(
    'glc_ranolock_500',
    'Ranolock-500',
    'Ranolazine Extended Release Tablets 500mg',
    'GLC-RAN-500',
    'Cardiology',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26RAN1'
  ),
  makeItem(
    'glc_qtaera_cd3',
    'Qtaera CD3',
    'Methylcobalamin 1500mcg + ALA 200mg + Benfotiamine 150mg + Inositol + Chromium + B6 + Folic Acid + Vit D3 + Calcium Tablets',
    'GLC-QTR-CD3',
    'Neuropathy Care',
    'Glacetor Remedies',
    'Box (10x10)',
    'GLC26QCD3'
  ),
];

export const OFFICIAL_CATALOG_STORAGE_KEY = 'glacetor_official_catalog_v2_clean';

export function splitProductAndSaltName(fullName: string): {
  productName: string;
  saltName: string;
} {
  const idx = fullName.indexOf('(');
  if (idx > 0 && fullName.endsWith(')')) {
    return {
      productName: fullName.slice(0, idx).trim(),
      saltName: fullName.slice(idx + 1, -1).trim(),
    };
  }
  return { productName: fullName.trim(), saltName: '' };
}

export function getMissingOfficialCatalogProducts(
  existingProducts: Product[]
): CatalogProductSeed[] {
  const existingIds = new Set(existingProducts.map((p) => p.id));
  const existingSkus = new Set(
    existingProducts.map((p) => (p.sku || '').trim().toUpperCase())
  );
  return GLACETOR_OFFICIAL_PRODUCTS.filter(
    (item) =>
      !existingIds.has(item.id) &&
      !existingSkus.has(item.sku.trim().toUpperCase())
  );
}

export function getProductsNeedingV2CleanMigration(
  existingProducts: Product[]
): CatalogProductSeed[] {
  const byId = new Map(existingProducts.map((p) => [p.id, p]));
  return GLACETOR_OFFICIAL_PRODUCTS.filter((item) => {
    const cur = byId.get(item.id);
    if (!cur) return false;
    return Boolean(cur.imageUrl) || cur.name !== item.name;
  });
}

export async function syncOfficialGlacetorCatalog(
  existingProducts: Product[],
  cleanExistingImagesAndPrices = false
): Promise<number> {
  const missing = getMissingOfficialCatalogProducts(existingProducts);
  const existingById = new Map(existingProducts.map((p) => [p.id, p]));
  const toUpdate = cleanExistingImagesAndPrices
    ? GLACETOR_OFFICIAL_PRODUCTS.filter((item) => {
        const cur = existingById.get(item.id);
        return Boolean(cur && (cur.imageUrl || cur.name !== item.name));
      })
    : [];

  if (missing.length === 0 && toUpdate.length === 0) return 0;

  const batch = writeBatch(db);
  for (const prod of missing) {
    const { productName: _pn, saltName: _sn, ...firestoreFields } = prod;
    batch.set(doc(db, 'products', prod.id), {
      ...firestoreFields,
      damagedStock: 0,
      isDemo: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  for (const prod of toUpdate) {
    batch.update(doc(db, 'products', prod.id), {
      name: prod.name,
      imageUrl: '',
      purchasePrice: 0,
      sellingPrice: 0,
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
    return missing.length + toUpdate.length;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'products');
    return 0;
  }
}
