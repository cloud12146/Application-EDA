export type UserRole =
  | 'Super Admin'
  | 'Admin'
  | 'Zonal Sales Manager (ZSM)'
  | 'Regional Sales Manager (RSM)'
  | 'Area Sales Manager (ASM)'
  | 'Marketing Executive (ME)'
  | 'Zonal Sales Manager'
  | 'Area Sales Manager'
  | 'RSM (Zonal Sales Manager)'
  | 'Manager'
  | 'Field Sales Employee'
  | 'Stock Manager'
  | 'Distributor'
  | 'Pending';

export type AdminTab =
  | 'dashboard'
  | 'employees'
  | 'live-location'
  | 'attendance'
  | 'tour-plan'
  | 'tasks'
  | 'activity'
  | 'products'
  | 'inventory'
  | 'stock-movements'
  | 'customers'
  | 'doctors'
  | 'sales'
  | 'orders'
  | 'distributors'
  | 'payments'
  | 'expenses'
  | 'reports'
  | 'notifications'
  | 'settings';

export type EmployeeTab =
  | 'my-dashboard'
  | 'my-attendance'
  | 'my-tour-plan'
  | 'my-tasks'
  | 'my-activity'
  | 'my-customers'
  | 'my-doctors'
  | 'my-visits'
  | 'my-stock'
  | 'my-sales'
  | 'my-orders'
  | 'my-expenses'
  | 'notifications'
  | 'my-profile';

export type AppTab = AdminTab | EmployeeTab;

export interface UserAccount {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  employeeId?: string;
  isActive: boolean;
  phone?: string;
  department?: string;
  designation?: string;
  territory?: string;
  fcmEnabled?: boolean;
  createdAt: any;
  updatedAt: any;
}

export interface Employee {
  id: string;
  uid?: string;
  employeeCode: string;
  fullName: string;
  email: string;
  phone?: string;
  role: Exclude<UserRole, 'Pending'>;
  department: string;
  designation?: string;
  territory?: string;
  assignedWarehouse?: string;
  geofenceLat?: number;
  geofenceLng?: number;
  geofenceRadiusM?: number;
  status: 'Active' | 'Inactive' | 'On Leave';
  joiningDate?: string;
  isDemo?: boolean;
  createdAt: any;
  updatedAt: any;
}

export interface AttendanceRecord {
  id: string;
  userId: string;
  employeeId?: string;
  employeeName: string;
  department?: string;
  date: string; // YYYY-MM-DD
  workMode: 'Office' | 'Field';
  status: 'Present' | 'Absent' | 'Late' | 'Half-day' | 'Leave';
  checkInTime?: string;
  checkOutTime?: string;
  checkInLat?: number;
  checkInLng?: number;
  checkInAccuracy?: number;
  checkOutLat?: number;
  checkOutLng?: number;
  workingMinutes?: number;
  locationLabel?: string;
  correctedBy?: string;
  correctionReason?: string;
  isDemo?: boolean;
  createdAt: any;
  updatedAt: any;
}

export interface LeaveRequest {
  id: string;
  userId: string;
  employeeName: string;
  leaveType: 'Casual' | 'Sick' | 'Earned' | 'Field Off';
  startDate: string;
  endDate: string;
  reason: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  reviewedBy?: string;
  reviewRemarks?: string;
  isDemo?: boolean;
  createdAt: any;
  updatedAt: any;
}

export interface LocationPing {
  id: string;
  userId: string;
  employeeName: string;
  territory?: string;
  lat: number;
  lng: number;
  accuracy: number;
  trackingActive: boolean;
  status: 'On Duty' | 'Customer Visit' | 'In Transit' | 'Checked Out';
  customerId?: string;
  customerName?: string;
  withinGeofence?: boolean;
  note?: string;
  recordedAt: any;
  isDemo?: boolean;
}

export type TaskCategory =
  | 'Sales'
  | 'Customer Visit'
  | 'Stock Management'
  | 'Delivery'
  | 'Collection'
  | 'Reporting'
  | 'General Work';

export type TaskPriority = 'Low' | 'Medium' | 'High' | 'Urgent';

export type TaskStatus =
  | 'Assigned'
  | 'Accepted'
  | 'In Progress'
  | 'Completed'
  | 'Pending Approval'
  | 'Approved'
  | 'Rejected'
  | 'Overdue'
  | 'Cancelled';

export interface TaskItem {
  id: string;
  title: string;
  description?: string;
  instructions?: string;
  assignedToUid: string;
  assignedToName: string;
  teamName?: string;
  category: TaskCategory;
  priority: TaskPriority;
  startDate: string;
  deadline: string;
  status: TaskStatus;
  progressPct?: number;
  completionProofUrl?: string;
  completionNotes?: string;
  extensionRequestedDate?: string;
  extensionReason?: string;
  adminRemarks?: string;
  rejectionReason?: string;
  createdByUid: string;
  isDemo?: boolean;
  createdAt: any;
  updatedAt: any;
}

export interface TaskUpdate {
  id: string;
  taskId: string;
  authorUid: string;
  authorName: string;
  actionType: string;
  comment: string;
  progressPct?: number;
  attachmentUrl?: string;
  attachmentName?: string;
  createdAt: any;
}

export interface ActivityLog {
  id: string;
  userId: string;
  employeeName: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details: string;
  lat?: number;
  lng?: number;
  isDemo?: boolean;
  createdAt: any;
}

export interface Product {
  id: string;
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
  damagedStock?: number;
  warehouse?: string;
  imageUrl?: string;
  isDemo?: boolean;
  createdAt: any;
  updatedAt: any;
}

export type StockMovementType =
  | 'Stock In'
  | 'Stock Out'
  | 'Stock Transfer'
  | 'Stock Return'
  | 'Stock Adjustment'
  | 'Damaged'
  | 'Expired'
  | 'Allocation';

export interface StockMovement {
  id: string;
  productId: string;
  productName: string;
  sku?: string;
  batchNumber: string;
  movementType: StockMovementType;
  quantity: number;
  previousStock?: number;
  newStock?: number;
  fromLocation?: string;
  toLocation?: string;
  targetUserId?: string;
  targetName?: string;
  status: 'Approved' | 'Pending Approval' | 'Rejected';
  reason?: string;
  performedByUid: string;
  performedByName: string;
  approvedByUid?: string;
  isDemo?: boolean;
  createdAt: any;
}

export interface StockAllocation {
  id: string;
  productId: string;
  productName: string;
  sku?: string;
  batchNumber: string;
  holderUid: string;
  holderName: string;
  holderRole: 'Employee' | 'Distributor';
  allocatedQty: number;
  soldQty: number;
  remainingQty: number;
  isDemo?: boolean;
  updatedAt: any;
}

export interface Customer {
  id: string;
  name: string;
  businessName: string;
  phone: string;
  address?: string;
  city: string;
  category: 'Retail Pharmacy' | 'Hospital' | 'Clinic' | 'Stockist' | 'Wholesaler';
  assignedEmployeeUid: string;
  assignedEmployeeName: string;
  lat?: number;
  lng?: number;
  outstandingBalance?: number;
  isDemo?: boolean;
  createdAt: any;
  updatedAt: any;
}

export interface OrderLineItem {
  productId: string;
  productName: string;
  batchNumber: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export type OrderStatus =
  | 'Pending'
  | 'Approved'
  | 'Packed'
  | 'Dispatched'
  | 'Delivered'
  | 'Cancelled'
  | 'Returned';

export type PaymentStatus = 'Paid' | 'Partially Paid' | 'Pending';

export interface SalesOrder {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  customerBusiness?: string;
  distributorUid?: string;
  createdByUid: string;
  createdByName: string;
  items: OrderLineItem[];
  subtotal?: number;
  discountPct?: number;
  discountAmount?: number;
  totalAmount: number;
  paidAmount: number;
  pendingAmount: number;
  orderStatus: OrderStatus;
  paymentStatus: PaymentStatus;
  orderType: 'Customer Sale' | 'Distributor Purchase';
  notes?: string;
  isDemo?: boolean;
  createdAt: any;
  updatedAt: any;
}

export interface PaymentRecord {
  id: string;
  orderId: string;
  orderNumber: string;
  payerUid?: string;
  payerName: string;
  amount: number;
  method: 'Bank Transfer' | 'UPI' | 'Cheque' | 'Cash' | 'NEFT';
  referenceNo?: string;
  collectedByUid: string;
  collectedByName: string;
  paymentDate: string;
  notes?: string;
  isDemo?: boolean;
  createdAt: any;
}

export interface Distributor {
  id: string;
  uid?: string;
  companyName: string;
  contactPerson: string;
  email: string;
  phone?: string;
  city: string;
  region?: string;
  gstNumber?: string;
  creditLimit?: number;
  outstandingAmount?: number;
  status: 'Active' | 'Suspended';
  isDemo?: boolean;
  createdAt: any;
  updatedAt: any;
}

export interface NotificationItem {
  id: string;
  recipientUid: string;
  targetRole?: string;
  title: string;
  message: string;
  category: 'Task' | 'Attendance' | 'Inventory' | 'Order' | 'Payment' | 'Leave' | 'Expense' | 'System';
  severity: 'info' | 'warning' | 'urgent';
  isRead: boolean;
  linkTab?: string;
  createdAt: any;
}

export interface CompanySettings {
  companyName: string;
  ownerUid: string;
  ownerEmail: string;
  officeLat: number;
  officeLng: number;
  officeRadiusM: number;
  workStartTime?: string;
  workEndTime?: string;
  lowStockDefault?: number;
  expiryAlertDays?: number;
  currencySymbol?: string;
  demoDataSeeded?: boolean;
  updatedAt: any;
}

export type TourWorkType =
  | 'Field Visit'
  | 'HQ / Office'
  | 'Outstation'
  | 'Transit'
  | 'Stockist Meet'
  | 'CME / Camp'
  | 'Leave / Holiday';

export type TourApprovalStatus = 'Draft' | 'Submitted' | 'Approved' | 'Rejected';

export interface TourPlanEntry {
  id: string;
  employeeUid: string;
  employeeName: string;
  month: string; // YYYY-MM
  date: string; // YYYY-MM-DD
  workType: TourWorkType;
  headquarters?: string;
  placesToVisit: string;
  routeZone?: string;
  plannedCustomers?: string;
  objective?: string;
  overnightStay?: boolean;
  approvalStatus: TourApprovalStatus;
  adminRemarks?: string;
  createdByUid: string;
  isDemo?: boolean;
  createdAt: any;
  updatedAt: any;
}

export type DoctorCallOutcome =
  | 'Interested'
  | 'Prescribing'
  | 'Follow-up Required'
  | 'Sample Requested'
  | 'Not Available'
  | 'Declined';

export interface Doctor {
  id: string;
  name: string;
  specialty: string;
  qualification?: string;
  clinicName: string;
  phone?: string;
  city: string;
  areaBeat?: string;
  address?: string;
  tier?: 'Core A+' | 'Class A' | 'Class B';
  assignedEmployeeUid: string;
  assignedEmployeeName: string;
  totalCalls?: number;
  lastVisitedDate?: string;
  lastCallOutcome?: DoctorCallOutcome;
  lastDoctorRemark?: string;
  lastProductsShown?: string;
  lastCallLat?: number;
  lastCallLng?: number;
  lastCallLocation?: string;
  isDemo?: boolean;
  createdAt: any;
  updatedAt: any;
}

export interface DoctorCallRecord {
  id: string;
  doctorId: string;
  doctorName: string;
  clinicName?: string;
  specialty?: string;
  areaBeat?: string;
  employeeUid: string;
  employeeName: string;
  callDate: string; // YYYY-MM-DD
  productsShown: string[];
  samplesGiven?: string;
  callOutcome: DoctorCallOutcome;
  doctorRemark: string;
  nextFollowUpDate?: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
  locationName?: string;
  isDemo?: boolean;
  createdAt: any;
}

export interface BiometricCredential {
  id: string;
  credentialId: string;
  userId: string;
  email: string;
  displayName: string;
  deviceLabel: string;
  isActive: boolean;
  lastUsedAt?: any;
  createdAt: any;
}

export type ExpenseCategory =
  | 'Travel / Fuel'
  | 'Daily Allowance'
  | 'Meals & Hospitality'
  | 'Lodging / Hotel'
  | 'Doctor Visit / CME'
  | 'Courier / Misc';

export type ExpenseWorkingType =
  | 'HQ Working'
  | 'Ex-HQ Working'
  | 'Outstation'
  | 'Transit'
  | 'Field Camp / CME'
  | 'Office / Admin';

export type ExpenseStatus =
  | 'Draft'
  | 'Pending Approval'
  | 'Approved'
  | 'Rejected'
  | 'Reimbursed';

export interface ExpenseClaim {
  id: string;
  userId: string;
  employeeName: string;
  department?: string;
  designation?: string;
  territory?: string;
  workingType?: ExpenseWorkingType;
  patchArea?: string;
  dailyAllowance?: number;
  travellingAllowance?: number;
  otherExpense?: number;
  expenseDate: string; // YYYY-MM-DD
  category: ExpenseCategory;
  amount: number;
  travelFrom?: string;
  travelTo?: string;
  distanceKm?: number;
  description: string;
  receiptUrl?: string;
  receiptPath?: string;
  status: ExpenseStatus;
  reviewedByUid?: string;
  reviewedByName?: string;
  reviewRemarks?: string;
  reimbursedRef?: string;
  isDemo?: boolean;
  createdAt: any;
  updatedAt: any;
}
