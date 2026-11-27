import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import { generateId } from './utils';
import {
  NotificationItem,
  OrderLineItem,
  Product,
  StockAllocation,
  StockMovementType,
} from '../types/erp';

export async function logActivity(params: {
  userId: string;
  employeeName: string;
  action: string;
  details: string;
  entityType?: string;
  entityId?: string;
  lat?: number;
  lng?: number;
  isDemo?: boolean;
}) {
  const id = generateId('act');
  const path = `activityLogs/${id}`;
  try {
    await setDoc(doc(db, 'activityLogs', id), {
      id,
      userId: params.userId,
      employeeName: params.employeeName.slice(0, 120),
      action: params.action.slice(0, 80),
      details: params.details.slice(0, 500),
      ...(params.entityType ? { entityType: params.entityType.slice(0, 60) } : {}),
      ...(params.entityId ? { entityId: params.entityId.slice(0, 128) } : {}),
      ...(typeof params.lat === 'number' ? { lat: params.lat } : {}),
      ...(typeof params.lng === 'number' ? { lng: params.lng } : {}),
      ...(params.isDemo ? { isDemo: true } : {}),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function pushNotification(params: {
  recipientUid: string;
  targetRole?: string;
  title: string;
  message: string;
  category: NotificationItem['category'];
  severity?: NotificationItem['severity'];
  linkTab?: string;
}) {
  const id = generateId('ntf');
  const path = `notifications/${id}`;
  try {
    await setDoc(doc(db, 'notifications', id), {
      id,
      recipientUid: params.recipientUid,
      ...(params.targetRole ? { targetRole: params.targetRole } : {}),
      title: params.title.slice(0, 160),
      message: params.message.slice(0, 500),
      category: params.category,
      severity: params.severity || 'info',
      isRead: false,
      ...(params.linkTab ? { linkTab: params.linkTab } : {}),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function markNotificationRead(id: string) {
  const path = `notifications/${id}`;
  try {
    await updateDoc(doc(db, 'notifications', id), { isRead: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function executeAtomicStockMovement(params: {
  productId: string;
  movementType: StockMovementType;
  quantity: number;
  reason: string;
  fromLocation?: string;
  toLocation?: string;
  targetUserId?: string;
  targetName?: string;
  targetRole?: 'Employee' | 'Distributor';
  performedByUid: string;
  performedByName: string;
  requireApproval?: boolean;
}) {
  const movementId = generateId('stk');
  const productRef = doc(db, 'products', params.productId);
  const movementRef = doc(db, 'stockMovements', movementId);

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(productRef);
      if (!snap.exists()) {
        throw new Error('Product record not found.');
      }
      const prod = snap.data() as Product;
      const prevStock = Number(prod.availableStock) || 0;
      const qty = Math.abs(Number(params.quantity));
      if (qty <= 0) throw new Error('Quantity must be greater than zero.');

      if (params.requireApproval) {
        tx.set(movementRef, {
          id: movementId,
          productId: params.productId,
          productName: prod.name,
          sku: prod.sku,
          batchNumber: prod.batchNumber,
          movementType: params.movementType,
          quantity: qty,
          previousStock: prevStock,
          newStock: prevStock,
          fromLocation: params.fromLocation || prod.warehouse || 'Central Warehouse',
          toLocation: params.toLocation || 'Field / Branch',
          ...(params.targetUserId ? { targetUserId: params.targetUserId } : {}),
          ...(params.targetName ? { targetName: params.targetName } : {}),
          status: 'Pending Approval',
          reason: params.reason.slice(0, 400),
          performedByUid: params.performedByUid,
          performedByName: params.performedByName,
          createdAt: serverTimestamp(),
        });
        return;
      }

      const isAddition =
        params.movementType === 'Stock In' || params.movementType === 'Stock Return';
      const isDeduction =
        params.movementType === 'Stock Out' ||
        params.movementType === 'Stock Transfer' ||
        params.movementType === 'Damaged' ||
        params.movementType === 'Expired' ||
        params.movementType === 'Allocation';

      let nextStock = prevStock;
      if (isAddition) {
        nextStock = prevStock + qty;
      } else if (isDeduction) {
        if (prevStock < qty) {
          throw new Error(
            `Insufficient available stock (${prevStock} ${prod.unit}) for ${prod.name}.`
          );
        }
        nextStock = prevStock - qty;
      } else if (params.movementType === 'Stock Adjustment') {
        nextStock = Math.max(0, prevStock + qty);
      }

      const nextDamaged =
        params.movementType === 'Damaged'
          ? (Number(prod.damagedStock) || 0) + qty
          : Number(prod.damagedStock) || 0;

      tx.update(productRef, {
        availableStock: nextStock,
        damagedStock: nextDamaged,
        updatedAt: serverTimestamp(),
      });

      tx.set(movementRef, {
        id: movementId,
        productId: params.productId,
        productName: prod.name,
        sku: prod.sku,
        batchNumber: prod.batchNumber,
        movementType: params.movementType,
        quantity: qty,
        previousStock: prevStock,
        newStock: nextStock,
        fromLocation: params.fromLocation || prod.warehouse || 'Central Warehouse',
        toLocation: params.toLocation || (params.targetName ? params.targetName : 'Market'),
        ...(params.targetUserId ? { targetUserId: params.targetUserId } : {}),
        ...(params.targetName ? { targetName: params.targetName } : {}),
        status: 'Approved',
        reason: params.reason.slice(0, 400),
        performedByUid: params.performedByUid,
        performedByName: params.performedByName,
        approvedByUid: params.performedByUid,
        createdAt: serverTimestamp(),
      });

      if (
        params.movementType === 'Allocation' &&
        params.targetUserId &&
        params.targetName &&
        params.targetRole
      ) {
        const allocId = `alloc_${params.targetUserId}_${params.productId}`.slice(0, 120);
        const allocRef = doc(db, 'stockAllocations', allocId);
        const allocSnap = await tx.get(allocRef);
        if (allocSnap.exists()) {
          const existing = allocSnap.data() as StockAllocation;
          tx.update(allocRef, {
            allocatedQty: (Number(existing.allocatedQty) || 0) + qty,
            remainingQty: (Number(existing.remainingQty) || 0) + qty,
            updatedAt: serverTimestamp(),
          });
        } else {
          tx.set(allocRef, {
            id: allocId,
            productId: params.productId,
            productName: prod.name,
            sku: prod.sku,
            batchNumber: prod.batchNumber,
            holderUid: params.targetUserId,
            holderName: params.targetName,
            holderRole: params.targetRole,
            allocatedQty: qty,
            soldQty: 0,
            remainingQty: qty,
            updatedAt: serverTimestamp(),
          });
        }
      }
    });

    await logActivity({
      userId: params.performedByUid,
      employeeName: params.performedByName,
      action:
        params.movementType === 'Stock In'
          ? 'Stock Received'
          : params.movementType === 'Stock Transfer'
          ? 'Stock Transferred'
          : params.movementType === 'Stock Return'
          ? 'Stock Returned'
          : 'Stock Issued',
      entityType: 'product',
      entityId: params.productId,
      details: `${params.movementType}: ${params.quantity} units (${params.reason})`,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Insufficient available stock')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `products/${params.productId}`);
  }
}

export async function recordAtomicPayment(params: {
  orderId: string;
  amount: number;
  method: 'Bank Transfer' | 'UPI' | 'Cheque' | 'Cash' | 'NEFT';
  referenceNo?: string;
  paymentDate: string;
  notes?: string;
  collectedByUid: string;
  collectedByName: string;
}) {
  const paymentId = generateId('pay');
  const orderRef = doc(db, 'salesOrders', params.orderId);
  const paymentRef = doc(db, 'payments', paymentId);

  try {
    await runTransaction(db, async (tx) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists()) throw new Error('Order not found.');
      const order = orderSnap.data();
      const total = Number(order.totalAmount) || 0;
      const prevPaid = Number(order.paidAmount) || 0;
      const amt = Number(params.amount);
      if (amt <= 0) throw new Error('Payment amount must be greater than 0.');

      const nextPaid = Math.min(total, prevPaid + amt);
      const nextPending = Math.max(0, total - nextPaid);
      const paymentStatus =
        nextPending <= 0 ? 'Paid' : nextPaid > 0 ? 'Partially Paid' : 'Pending';

      tx.update(orderRef, {
        paidAmount: nextPaid,
        pendingAmount: nextPending,
        paymentStatus,
        updatedAt: serverTimestamp(),
      });

      tx.set(paymentRef, {
        id: paymentId,
        orderId: params.orderId,
        orderNumber: order.orderNumber,
        payerUid: order.distributorUid || order.createdByUid,
        payerName: order.customerBusiness || order.customerName,
        amount: amt,
        method: params.method,
        ...(params.referenceNo ? { referenceNo: params.referenceNo.slice(0, 80) } : {}),
        collectedByUid: params.collectedByUid,
        collectedByName: params.collectedByName,
        paymentDate: params.paymentDate,
        ...(params.notes ? { notes: params.notes.slice(0, 300) } : {}),
        createdAt: serverTimestamp(),
      });
    });

    await logActivity({
      userId: params.collectedByUid,
      employeeName: params.collectedByName,
      action: 'Payment Collected',
      entityType: 'salesOrder',
      entityId: params.orderId,
      details: `Recorded ₹${params.amount.toFixed(2)} via ${params.method}`,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Payment amount')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `salesOrders/${params.orderId}`);
  }
}

export async function createOrderWithOptionalStockDeduction(params: {
  orderNumber: string;
  customerId: string;
  customerName: string;
  customerBusiness?: string;
  distributorUid?: string;
  createdByUid: string;
  createdByName: string;
  items: OrderLineItem[];
  subtotal: number;
  discountPct: number;
  discountAmount: number;
  totalAmount: number;
  orderType: 'Customer Sale' | 'Distributor Purchase';
  notes?: string;
  autoApproveAndDeduct: boolean;
}) {
  const orderId = generateId('ord');
  const orderRef = doc(db, 'salesOrders', orderId);

  try {
    await runTransaction(db, async (tx) => {
      if (params.autoApproveAndDeduct) {
        for (const item of params.items) {
          const pRef = doc(db, 'products', item.productId);
          const pSnap = await tx.get(pRef);
          if (!pSnap.exists()) throw new Error(`Product ${item.productName} not found.`);
          const pData = pSnap.data() as Product;
          if (pData.availableStock < item.qty) {
            throw new Error(
              `Insufficient stock for ${item.productName} (${pData.availableStock} left).`
            );
          }
          tx.update(pRef, {
            availableStock: pData.availableStock - item.qty,
            updatedAt: serverTimestamp(),
          });
          const movId = generateId('stk');
          tx.set(doc(collection(db, 'stockMovements'), movId), {
            id: movId,
            productId: item.productId,
            productName: item.productName,
            sku: pData.sku,
            batchNumber: item.batchNumber,
            movementType: 'Stock Out',
            quantity: item.qty,
            previousStock: pData.availableStock,
            newStock: pData.availableStock - item.qty,
            fromLocation: pData.warehouse || 'Central Warehouse',
            toLocation: params.customerBusiness || params.customerName,
            status: 'Approved',
            reason: `Sales Order ${params.orderNumber}`,
            performedByUid: params.createdByUid,
            performedByName: params.createdByName,
            approvedByUid: params.createdByUid,
            createdAt: serverTimestamp(),
          });
        }
      }

      tx.set(orderRef, {
        id: orderId,
        orderNumber: params.orderNumber,
        customerId: params.customerId,
        customerName: params.customerName,
        ...(params.customerBusiness ? { customerBusiness: params.customerBusiness } : {}),
        ...(params.distributorUid ? { distributorUid: params.distributorUid } : {}),
        createdByUid: params.createdByUid,
        createdByName: params.createdByName,
        items: params.items,
        subtotal: params.subtotal,
        discountPct: params.discountPct,
        discountAmount: params.discountAmount,
        totalAmount: params.totalAmount,
        paidAmount: 0,
        pendingAmount: params.totalAmount,
        orderStatus: params.autoApproveAndDeduct ? 'Approved' : 'Pending',
        paymentStatus: 'Pending',
        orderType: params.orderType,
        ...(params.notes ? { notes: params.notes.slice(0, 500) } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });

    await logActivity({
      userId: params.createdByUid,
      employeeName: params.createdByName,
      action: 'Sales Order Created',
      entityType: 'salesOrder',
      entityId: orderId,
      details: `Order ${params.orderNumber} for ${params.customerName} (₹${params.totalAmount.toFixed(2)})`,
    });

    return orderId;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Insufficient stock')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `salesOrders/${orderId}`);
  }
}
