import React, { useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  onSnapshotsInSync,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  Bell,
  Boxes,
  Building2,
  CalendarCheck,
  CalendarDays,
  ClipboardList,
  CreditCard,
  Fingerprint,
  LayoutDashboard,
  Lock,
  LogOut,
  MapPin,
  Menu,
  Package,
  Receipt,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Stethoscope,
  TrendingUp,
  Truck,
  User as UserIcon,
  Users,
  X,
} from 'lucide-react';
import {
  auth,
  db,
  handleFirestoreError,
  isFirebaseConfigured,
  OperationType,
  testConnection,
} from './lib/firebase';
import { calculateHaversineMeters, emailToKey, todayIsoDate, tsToMs } from './lib/utils';
import { logActivity } from './lib/erpActions';
import {
  LIVE_TRACKING_CONSENT_PREFIX,
  LIVE_TRACKING_DUTY_STORAGE_PREFIX,
  LiveTrackingController,
  LiveTrackingCoords,
  writeValidatedLocationPing,
} from './lib/liveLocation';
import {
  getMissingOfficialCatalogProducts,
  getProductsNeedingV2CleanMigration,
  OFFICIAL_CATALOG_STORAGE_KEY,
  syncOfficialGlacetorCatalog,
} from './lib/glacetorCatalog';
import {
  getRoleDisplayLabel,
  isManagementRole,
  isStockAuthorizedRole,
} from './lib/roles';
import {
  getDeviceBiometricBinding,
  getSessionLockFlag,
  SENSITIVE_MODULE_TABS,
  setSessionLockFlag,
  touchBiometricLastUsed,
  verifyDeviceBiometrics,
} from './lib/biometrics';
import { AuthPortal } from './components/AuthPortal';
import { BrandLoader, BrandMark } from './components/BrandMark';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { QuickActionMenu } from './components/QuickActionMenu';
import {
  CollectionSyncState,
  SyncStatusIndicator,
} from './components/SyncStatusIndicator';
import { AdminDashboard } from './modules/AdminDashboard';
import { EmployeeDashboard } from './modules/EmployeeDashboard';
import {
  DistributorDashboard,
  StockManagerDashboard,
} from './modules/DistributorStockPanels';
import { EmployeesModule } from './modules/EmployeesModule';
import { LocationTrackingModule } from './modules/LocationTrackingModule';
import { AttendanceModule } from './modules/AttendanceModule';
import { TasksModule } from './modules/TasksModule';
import { ActivityModule } from './modules/ActivityModule';
import { InventoryModule } from './modules/InventoryModule';
import { SalesCustomersModule } from './modules/SalesCustomersModule';
import { ReportsModule } from './modules/ReportsModule';
import { NotificationsModule } from './modules/NotificationsModule';
import { ProfileModule, SettingsModule } from './modules/SettingsProfileModule';
import { TourPlanModule } from './modules/TourPlanModule';
import { DoctorsModule } from './modules/DoctorsModule';
import { ExpensesModule } from './modules/ExpensesModule';
import {
  ActivityLog,
  AdminTab,
  AppTab,
  AttendanceRecord,
  BiometricCredential,
  CompanySettings,
  Customer,
  Distributor,
  Doctor,
  DoctorCallRecord,
  Employee,
  EmployeeTab,
  ExpenseClaim,
  LeaveRequest,
  LocationPing,
  NotificationItem,
  PaymentRecord,
  Product,
  SalesOrder,
  StockAllocation,
  StockMovement,
  TaskItem,
  TaskUpdate,
  TourPlanEntry,
  UserAccount,
} from './types/erp';

interface NavItem {
  id: AppTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const ADMIN_NAV: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'employees', label: 'Employees', icon: Users },
  { id: 'live-location', label: 'Live Location', icon: MapPin },
  { id: 'attendance', label: 'Attendance', icon: CalendarCheck },
  { id: 'tour-plan', label: 'Tour Plan', icon: CalendarDays },
  { id: 'tasks', label: 'Tasks', icon: ClipboardList },
  { id: 'activity', label: 'Activity Reports', icon: Activity },
  { id: 'products', label: 'Products', icon: Package },
  { id: 'inventory', label: 'Inventory', icon: Boxes },
  { id: 'stock-movements', label: 'Stock Movements', icon: ArrowLeftRight },
  { id: 'customers', label: 'Customers', icon: Building2 },
  { id: 'doctors', label: 'Doctors & Calls', icon: Stethoscope },
  { id: 'sales', label: 'Sales', icon: TrendingUp },
  { id: 'orders', label: 'Orders', icon: ShoppingCart },
  { id: 'distributors', label: 'Distributors', icon: Truck },
  { id: 'payments', label: 'Payments', icon: CreditCard },
  { id: 'expenses', label: 'Expenses', icon: Receipt },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const STOCK_MANAGER_NAV: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'products', label: 'Products', icon: Package },
  { id: 'inventory', label: 'Inventory', icon: Boxes },
  { id: 'stock-movements', label: 'Stock Movements', icon: ArrowLeftRight },
  { id: 'orders', label: 'Orders', icon: ShoppingCart },
  { id: 'distributors', label: 'Distributors', icon: Truck },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'my-profile', label: 'My Profile', icon: UserIcon },
];

const EMPLOYEE_NAV: NavItem[] = [
  { id: 'my-dashboard', label: 'My Dashboard', icon: LayoutDashboard },
  { id: 'my-attendance', label: 'My Attendance', icon: CalendarCheck },
  { id: 'my-tour-plan', label: 'My Tour Plan', icon: CalendarDays },
  { id: 'my-tasks', label: 'My Tasks', icon: ClipboardList },
  { id: 'my-activity', label: 'My Activity', icon: Activity },
  { id: 'my-customers', label: 'My Customers', icon: Building2 },
  { id: 'my-doctors', label: 'My Doctors', icon: Stethoscope },
  { id: 'my-visits', label: 'My Visits', icon: MapPin },
  { id: 'my-stock', label: 'My Stock', icon: Package },
  { id: 'my-sales', label: 'My Sales', icon: TrendingUp },
  { id: 'my-orders', label: 'My Orders', icon: ShoppingCart },
  { id: 'my-expenses', label: 'My Expenses', icon: Receipt },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'my-profile', label: 'My Profile', icon: UserIcon },
];

const DISTRIBUTOR_NAV: NavItem[] = [
  { id: 'my-dashboard', label: 'My Dashboard', icon: LayoutDashboard },
  { id: 'my-stock', label: 'My Stock', icon: Package },
  { id: 'my-orders', label: 'My Orders', icon: ShoppingCart },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'my-profile', label: 'My Profile', icon: UserIcon },
];

function WorkspaceApp() {
  const [authReady, setAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  const [needsFirstAdminSetup, setNeedsFirstAdminSetup] = useState(false);
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [bootstrapTick, setBootstrapTick] = useState(0);
  const [biometricBindingTick, setBiometricBindingTick] = useState(0);
  const [biometricLocked, setBiometricLocked] = useState<boolean>(() =>
    getSessionLockFlag()
  );
  const [sensitiveModulesUnlocked, setSensitiveModulesUnlocked] = useState(false);
  const [unlockingSensitive, setUnlockingSensitive] = useState(false);
  const [sensitiveUnlockError, setSensitiveUnlockError] = useState('');
  const initialAuthRestoreHandledRef = React.useRef(false);

  // Operational Firestore state
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [locations, setLocations] = useState<LocationPing[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [taskUpdates, setTaskUpdates] = useState<TaskUpdate[]>([]);
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);
  const [allocations, setAllocations] = useState<StockAllocation[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [distributors, setDistributors] = useState<Distributor[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [tourPlans, setTourPlans] = useState<TourPlanEntry[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [doctorCalls, setDoctorCalls] = useState<DoctorCallRecord[]>([]);
  const [expenses, setExpenses] = useState<ExpenseClaim[]>([]);
  const [biometricCredentials, setBiometricCredentials] = useState<BiometricCredential[]>([]);
  const [syncMap, setSyncMap] = useState<Record<string, CollectionSyncState>>({});
  const [snapshotsInSyncTick, setSnapshotsInSyncTick] = useState(0);

  // Persistent App-Level Live GPS Tracking state (survives tab switches)
  const [isLiveTracking, setIsLiveTracking] = useState(false);
  const [livePermissionState, setLivePermissionState] = useState<string>('prompt');
  const [liveTrackingError, setLiveTrackingError] = useState('');
  const [lastLivePingAtMs, setLastLivePingAtMs] = useState<number | null>(null);
  const [liveTrackingCoords, setLiveTrackingCoords] = useState<LiveTrackingCoords | null>(null);
  const [focusedLiveEmployeeUid, setFocusedLiveEmployeeUid] = useState<string | null>(null);

  const liveWatchIdRef = useRef<number | null>(null);
  const lastLivePingWriteRef = useRef<number>(0);
  const lastLivePingCoordsRef = useRef<{ lat: number; lng: number } | null>(null);
  const liveNoteRef = useRef<string>('Authorized work-hour live GPS tracking');
  const latestTrackingContextRef = useRef<{
    currentUser: UserAccount | null;
    employees: Employee[];
    settings: CompanySettings | null;
  }>({ currentUser: null, employees: [], settings: null });
  latestTrackingContextRef.current = { currentUser, employees, settings };

  useEffect(() => {
    if (isFirebaseConfigured) {
      testConnection();
    }
  }, []);

  // Auth & Role Resolution
  useEffect(() => {
    if (!isFirebaseConfigured) {
      setAuthReady(true);
      return;
    }

    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      if (!fbUser) {
        initialAuthRestoreHandledRef.current = true;
        setSessionLockFlag(false);
        setBiometricLocked(false);
        setCurrentUser(null);
        setNeedsFirstAdminSetup(false);
        setAuthReady(true);
        return;
      }

      try {
        const settingsSnap = await getDoc(doc(db, 'settings', 'company'));
        if (!settingsSnap.exists()) {
          setNeedsFirstAdminSetup(true);
          setCurrentUser(null);
          setAuthReady(true);
          return;
        }
        setNeedsFirstAdminSetup(false);
        setSettings(settingsSnap.data() as CompanySettings);

        const userRef = doc(db, 'users', fbUser.uid);
        let userSnap = await getDoc(userRef);

        if (!userSnap.exists()) {
          const cleanEmail = (fbUser.email || '').toLowerCase();
          const inviteSnap = cleanEmail
            ? await getDoc(doc(db, 'invites', emailToKey(cleanEmail)))
            : null;
          const isBootstrapOwner = cleanEmail === 'dp7037506@gmail.com' && fbUser.emailVerified;

          let resolvedRole: UserAccount['role'] = 'Pending';
          let dept = 'Field Sales';
          let desig = '';
          let terr = '';
          let empId = '';

          if (isBootstrapOwner) {
            resolvedRole = 'Super Admin';
            dept = 'Executive Administration';
            desig = 'Super Administrator';
            terr = 'Corporate HQ';
            await setDoc(doc(db, 'admins', fbUser.uid), {
              uid: fbUser.uid,
              email: cleanEmail,
              role: 'Super Admin',
              grantedAt: serverTimestamp(),
              grantedBy: 'owner-bootstrap',
            });
          } else if (inviteSnap && inviteSnap.exists()) {
            const inv = inviteSnap.data();
            resolvedRole = inv.role;
            dept = inv.department || 'General';
            desig = inv.designation || '';
            terr = inv.territory || '';
            empId = inv.employeeId || '';
            if (empId) {
              try {
                await updateDoc(doc(db, 'employees', empId), {
                  uid: fbUser.uid,
                  updatedAt: serverTimestamp(),
                });
              } catch {
                // optional link
              }
            }
          }

          await setDoc(userRef, {
            uid: fbUser.uid,
            email: cleanEmail,
            displayName: fbUser.displayName || cleanEmail.split('@')[0] || 'User',
            role: resolvedRole,
            ...(empId ? { employeeId: empId } : {}),
            isActive: true,
            department: dept,
            ...(desig ? { designation: desig } : {}),
            ...(terr ? { territory: terr } : {}),
            fcmEnabled: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          userSnap = await getDoc(userRef);
        }

        const account = userSnap.data() as UserAccount;
        setCurrentUser(account);

        if (!initialAuthRestoreHandledRef.current) {
          initialAuthRestoreHandledRef.current = true;
          const binding = getDeviceBiometricBinding();
          if (
            account.isActive &&
            account.role !== 'Pending' &&
            binding &&
            binding.userId === account.uid &&
            (binding.lockOnReopen || getSessionLockFlag())
          ) {
            setSessionLockFlag(true);
            setBiometricLocked(true);
          }
        } else {
          setSessionLockFlag(false);
          setBiometricLocked(false);
        }

        if (
          !isManagementRole(account.role) &&
          account.role !== 'Stock Manager' &&
          account.role !== 'Pending'
        ) {
          setActiveTab('my-dashboard');
        } else {
          setActiveTab('dashboard');
        }

        if (account.isActive && account.role !== 'Pending') {
          await logActivity({
            userId: account.uid,
            employeeName: account.displayName,
            action: 'Login',
            details: `Signed in as ${account.role}`,
          });
        }
      } catch (error) {
        console.error('Auth initialization error:', error);
      } finally {
        setAuthReady(true);
      }
    });

    return () => unsub();
  }, [bootstrapTick]);

  // Scoped Real-Time Firestore Listeners + Offline Sync Metadata Tracking
  useEffect(() => {
    if (!currentUser || !currentUser.isActive || currentUser.role === 'Pending') {
      setSyncMap({});
      return;
    }

    const uid = currentUser.uid;
    const isAdminOrMgr = isManagementRole(currentUser.role);
    const isStockMgr = currentUser.role === 'Stock Manager';
    const isDistributor = currentUser.role === 'Distributor';

    const unsubs: (() => void)[] = [];

    const updateColSync = (colName: string, pendingWrites: number, fromCache: boolean) => {
      setSyncMap((prev) => {
        const existing = prev[colName];
        if (
          existing &&
          existing.pendingWrites === pendingWrites &&
          existing.fromCache === fromCache
        ) {
          return prev;
        }
        return { ...prev, [colName]: { pendingWrites, fromCache } };
      });
    };

    const subscribe = <T,>(
      colName: string,
      qRef: any,
      setter: React.Dispatch<React.SetStateAction<T[]>>,
      sortByTimeField?: string
    ) => {
      const u = onSnapshot(
        qRef,
        { includeMetadataChanges: true },
        (snap: any) => {
          let pendingWrites = 0;
          const items = snap.docs.map((d: any) => {
            if (d.metadata?.hasPendingWrites) pendingWrites += 1;
            return { id: d.id, ...d.data() };
          }) as T[];
          if (pendingWrites === 0 && snap.metadata?.hasPendingWrites) {
            pendingWrites = 1;
          }
          updateColSync(colName, pendingWrites, Boolean(snap.metadata?.fromCache));

          if (sortByTimeField) {
            items.sort(
              (a: any, b: any) => tsToMs(b[sortByTimeField]) - tsToMs(a[sortByTimeField])
            );
          }
          setter(items);
        },
        (err: unknown) => handleFirestoreError(err, OperationType.LIST, colName)
      );
      unsubs.push(u);
    };

    unsubs.push(
      onSnapshotsInSync(db, () => {
        setSnapshotsInSyncTick((t) => t + 1);
      })
    );

    // Company Settings listener
    unsubs.push(
      onSnapshot(
        doc(db, 'settings', 'company'),
        { includeMetadataChanges: true },
        (snap) => {
          updateColSync(
            'settings',
            snap.metadata.hasPendingWrites ? 1 : 0,
            snap.metadata.fromCache
          );
          if (snap.exists()) setSettings(snap.data() as CompanySettings);
        },
        (err) => handleFirestoreError(err, OperationType.GET, 'settings/company')
      )
    );

    // Products available to all active roles
    subscribe<Product>('products', collection(db, 'products'), setProducts);

    // Notifications scoped to user or broadcast
    subscribe<NotificationItem>(
      'notifications',
      isAdminOrMgr
        ? collection(db, 'notifications')
        : query(collection(db, 'notifications'), where('recipientUid', 'in', [uid, 'ALL'])),
      setNotifications,
      'createdAt'
    );

    // Registered Biometric Passkeys (Super Admin / Admin see company-wide; others see own only)
    const isAdminOnly = ['Super Admin', 'Admin'].includes(currentUser.role);
    subscribe<BiometricCredential>(
      'biometricCredentials',
      isAdminOnly
        ? collection(db, 'biometricCredentials')
        : query(collection(db, 'biometricCredentials'), where('userId', '==', uid)),
      setBiometricCredentials,
      'createdAt'
    );

    if (isAdminOrMgr) {
      subscribe<UserAccount>('users', collection(db, 'users'), setUsers);
      subscribe<Employee>('employees', collection(db, 'employees'), setEmployees);
      subscribe<AttendanceRecord>('attendance', collection(db, 'attendance'), setAttendance, 'createdAt');
      subscribe<LeaveRequest>('leaveRequests', collection(db, 'leaveRequests'), setLeaveRequests, 'createdAt');
      subscribe<LocationPing>('locations', query(collection(db, 'locations'), orderBy('recordedAt', 'desc')), setLocations);
      subscribe<TaskItem>('tasks', collection(db, 'tasks'), setTasks, 'createdAt');
      subscribe<TaskUpdate>('taskUpdates', collection(db, 'taskUpdates'), setTaskUpdates, 'createdAt');
      subscribe<ActivityLog>('activityLogs', query(collection(db, 'activityLogs'), orderBy('createdAt', 'desc')), setActivities);
      subscribe<StockMovement>('stockMovements', collection(db, 'stockMovements'), setStockMovements, 'createdAt');
      subscribe<StockAllocation>('stockAllocations', collection(db, 'stockAllocations'), setAllocations);
      subscribe<Customer>('customers', collection(db, 'customers'), setCustomers);
      subscribe<SalesOrder>('salesOrders', collection(db, 'salesOrders'), setSalesOrders, 'createdAt');
      subscribe<PaymentRecord>('payments', collection(db, 'payments'), setPayments, 'createdAt');
      subscribe<Distributor>('distributors', collection(db, 'distributors'), setDistributors);
      subscribe<TourPlanEntry>('tourPlans', collection(db, 'tourPlans'), setTourPlans);
      subscribe<Doctor>('doctors', collection(db, 'doctors'), setDoctors);
      subscribe<DoctorCallRecord>('doctorCalls', collection(db, 'doctorCalls'), setDoctorCalls, 'createdAt');
      subscribe<ExpenseClaim>('expenses', collection(db, 'expenses'), setExpenses, 'createdAt');
    } else if (isStockMgr) {
      subscribe<StockMovement>('stockMovements', collection(db, 'stockMovements'), setStockMovements, 'createdAt');
      subscribe<StockAllocation>('stockAllocations', collection(db, 'stockAllocations'), setAllocations);
      subscribe<SalesOrder>('salesOrders', collection(db, 'salesOrders'), setSalesOrders, 'createdAt');
      subscribe<Distributor>('distributors', collection(db, 'distributors'), setDistributors);
      subscribe<AttendanceRecord>(
        'attendance',
        query(collection(db, 'attendance'), where('userId', '==', uid)),
        setAttendance,
        'createdAt'
      );
      subscribe<TaskItem>(
        'tasks',
        query(collection(db, 'tasks'), where('assignedToUid', '==', uid)),
        setTasks,
        'createdAt'
      );
    } else if (isDistributor) {
      subscribe<StockAllocation>(
        'stockAllocations',
        query(collection(db, 'stockAllocations'), where('holderUid', '==', uid)),
        setAllocations
      );
      subscribe<SalesOrder>(
        'salesOrders',
        query(collection(db, 'salesOrders'), where('createdByUid', '==', uid)),
        setSalesOrders,
        'createdAt'
      );
      subscribe<PaymentRecord>(
        'payments',
        query(collection(db, 'payments'), where('payerUid', '==', uid)),
        setPayments,
        'createdAt'
      );
      subscribe<Distributor>(
        'distributors',
        query(collection(db, 'distributors'), where('uid', '==', uid)),
        setDistributors
      );
    } else {
      // Field Sales Employee — strictly scoped to own data
      subscribe<AttendanceRecord>(
        'attendance',
        query(collection(db, 'attendance'), where('userId', '==', uid)),
        setAttendance,
        'createdAt'
      );
      subscribe<LeaveRequest>(
        'leaveRequests',
        query(collection(db, 'leaveRequests'), where('userId', '==', uid)),
        setLeaveRequests,
        'createdAt'
      );
      subscribe<LocationPing>(
        'locations',
        query(collection(db, 'locations'), where('userId', '==', uid)),
        setLocations,
        'recordedAt'
      );
      subscribe<TaskItem>(
        'tasks',
        query(collection(db, 'tasks'), where('assignedToUid', '==', uid)),
        setTasks,
        'createdAt'
      );
      subscribe<TaskUpdate>(
        'taskUpdates',
        query(collection(db, 'taskUpdates'), where('authorUid', '==', uid)),
        setTaskUpdates,
        'createdAt'
      );
      subscribe<ActivityLog>(
        'activityLogs',
        query(collection(db, 'activityLogs'), where('userId', '==', uid)),
        setActivities,
        'createdAt'
      );
      subscribe<StockAllocation>(
        'stockAllocations',
        query(collection(db, 'stockAllocations'), where('holderUid', '==', uid)),
        setAllocations
      );
      subscribe<Customer>(
        'customers',
        query(collection(db, 'customers'), where('assignedEmployeeUid', '==', uid)),
        setCustomers
      );
      subscribe<SalesOrder>(
        'salesOrders',
        query(collection(db, 'salesOrders'), where('createdByUid', '==', uid)),
        setSalesOrders,
        'createdAt'
      );
      subscribe<PaymentRecord>(
        'payments',
        query(collection(db, 'payments'), where('collectedByUid', '==', uid)),
        setPayments,
        'createdAt'
      );
      subscribe<TourPlanEntry>(
        'tourPlans',
        query(collection(db, 'tourPlans'), where('employeeUid', '==', uid)),
        setTourPlans
      );
      subscribe<Doctor>(
        'doctors',
        query(collection(db, 'doctors'), where('assignedEmployeeUid', '==', uid)),
        setDoctors
      );
      subscribe<DoctorCallRecord>(
        'doctorCalls',
        query(collection(db, 'doctorCalls'), where('employeeUid', '==', uid)),
        setDoctorCalls,
        'createdAt'
      );
      subscribe<ExpenseClaim>(
        'expenses',
        query(collection(db, 'expenses'), where('userId', '==', uid)),
        setExpenses,
        'createdAt'
      );
    }

    return () => unsubs.forEach((fn) => fn());
  }, [currentUser]);

  const catalogAutoSyncedRef = useRef(false);
  useEffect(() => {
    if (!currentUser || catalogAutoSyncedRef.current) return;
    if (!isStockAuthorizedRole(currentUser.role)) {
      return;
    }
    const productsSync = syncMap.products;
    if (!productsSync || productsSync.fromCache) return;

    try {
      if (localStorage.getItem(OFFICIAL_CATALOG_STORAGE_KEY) === '1') {
        catalogAutoSyncedRef.current = true;
        return;
      }
    } catch {
      // ignore storage read issues
    }

    const missing = getMissingOfficialCatalogProducts(products);
    const needsClean = getProductsNeedingV2CleanMigration(products);
    catalogAutoSyncedRef.current = true;
    if (missing.length === 0 && needsClean.length === 0) {
      try {
        localStorage.setItem(OFFICIAL_CATALOG_STORAGE_KEY, '1');
      } catch {
        // ignore
      }
      return;
    }

    void syncOfficialGlacetorCatalog(products, true).then((updated) => {
      if (updated > 0) {
        try {
          localStorage.setItem(OFFICIAL_CATALOG_STORAGE_KEY, '1');
        } catch {
          // ignore
        }
      }
    });
  }, [currentUser, syncMap.products, products]);

  const navItems = useMemo(() => {
    if (!currentUser) return [];
    if (isManagementRole(currentUser.role)) return ADMIN_NAV;
    if (currentUser.role === 'Stock Manager') return STOCK_MANAGER_NAV;
    if (currentUser.role === 'Distributor') return DISTRIBUTOR_NAV;
    return EMPLOYEE_NAV;
  }, [currentUser]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.isRead).length,
    [notifications]
  );

  // Monitor browser geolocation permission state & clean up watch on unmount
  useEffect(() => {
    if ('permissions' in navigator && navigator.permissions?.query) {
      navigator.permissions
        .query({ name: 'geolocation' })
        .then((res) => {
          setLivePermissionState(res.state);
          res.onchange = () => setLivePermissionState(res.state);
        })
        .catch(() => {});
    }
    return () => {
      if (liveWatchIdRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(liveWatchIdRef.current);
        liveWatchIdRef.current = null;
      }
    };
  }, []);

  const persistTrackingFlags = (uid: string, active: boolean) => {
    try {
      const today = todayIsoDate();
      if (active) {
        localStorage.setItem(`${LIVE_TRACKING_DUTY_STORAGE_PREFIX}${uid}`, today);
        localStorage.setItem(`${LIVE_TRACKING_CONSENT_PREFIX}${uid}`, '1');
      } else {
        localStorage.removeItem(`${LIVE_TRACKING_DUTY_STORAGE_PREFIX}${uid}`);
      }
    } catch {
      // ignore storage errors
    }
  };

  const stopAppLiveTracking = async (options?: {
    recordCheckoutPing?: boolean;
    finalPosition?: GeolocationPosition;
    note?: string;
  }) => {
    if (liveWatchIdRef.current !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(liveWatchIdRef.current);
      liveWatchIdRef.current = null;
    }
    setIsLiveTracking(false);
    const ctx = latestTrackingContextRef.current;
    if (ctx.currentUser) {
      persistTrackingFlags(ctx.currentUser.uid, false);
    }

    if (options?.recordCheckoutPing && ctx.currentUser && ctx.currentUser.isActive) {
      const writeCheckout = async (coords: GeolocationCoordinates) => {
        if (!ctx.currentUser) return;
        await writeValidatedLocationPing({
          currentUser: ctx.currentUser,
          employees: ctx.employees,
          settings: ctx.settings,
          coords,
          status: 'Checked Out',
          trackingActive: false,
          note: options?.note || 'Checked out / stopped live tracking',
        });
      };

      if (options.finalPosition) {
        await writeCheckout(options.finalPosition.coords);
      } else if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            void writeCheckout(pos.coords);
          },
          () => {},
          { enableHighAccuracy: true, timeout: 8000 }
        );
      }
    }
  };

  const startAppLiveTracking = (options?: {
    initialPosition?: GeolocationPosition;
    note?: string;
    silentIfUnavailable?: boolean;
  }) => {
    const ctx = latestTrackingContextRef.current;
    if (!ctx.currentUser || !ctx.currentUser.isActive || ctx.currentUser.role === 'Pending') {
      return;
    }

    if (!('geolocation' in navigator)) {
      if (!options?.silentIfUnavailable) {
        setLiveTrackingError('Geolocation is not supported by this browser or device.');
      }
      return;
    }

    setLiveTrackingError('');
    if (options?.note) {
      liveNoteRef.current = options.note;
    }

    const handleNewPosition = async (pos: GeolocationPosition, forceWrite = false) => {
      const activeCtx = latestTrackingContextRef.current;
      if (!activeCtx.currentUser || !activeCtx.currentUser.isActive) return;

      const now = Date.now();
      setIsLiveTracking(true);
      setLivePermissionState('granted');
      setLiveTrackingCoords({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: Math.round(pos.coords.accuracy || 0),
        capturedAtMs: now,
      });
      persistTrackingFlags(activeCtx.currentUser.uid, true);

      const elapsed = now - lastLivePingWriteRef.current;
      const movedMeters = lastLivePingCoordsRef.current
        ? calculateHaversineMeters(
            lastLivePingCoordsRef.current.lat,
            lastLivePingCoordsRef.current.lng,
            pos.coords.latitude,
            pos.coords.longitude
          )
        : Infinity;

      // Immediate write on first ping, or every 20s, or on >= 40m movement after 8s
      if (forceWrite || elapsed >= 20000 || (movedMeters >= 40 && elapsed >= 8000)) {
        lastLivePingWriteRef.current = now;
        lastLivePingCoordsRef.current = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        };
        setLastLivePingAtMs(now);
        await writeValidatedLocationPing({
          currentUser: activeCtx.currentUser,
          employees: activeCtx.employees,
          settings: activeCtx.settings,
          coords: pos.coords,
          status: 'On Duty',
          trackingActive: true,
          note: liveNoteRef.current,
        });
      }
    };

    if (options?.initialPosition) {
      void handleNewPosition(options.initialPosition, true);
    }

    if (liveWatchIdRef.current !== null) {
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        void handleNewPosition(pos);
      },
      (err) => {
        setIsLiveTracking(false);
        if (err.code === err.PERMISSION_DENIED) {
          setLivePermissionState('denied');
          if (latestTrackingContextRef.current.currentUser) {
            persistTrackingFlags(latestTrackingContextRef.current.currentUser.uid, false);
          }
          if (!options?.silentIfUnavailable) {
            setLiveTrackingError(
              'Location permission was denied. Enable GPS access in your browser/Android site settings.'
            );
          }
        } else if (!options?.silentIfUnavailable) {
          if (err.code === err.POSITION_UNAVAILABLE) {
            setLiveTrackingError('GPS signal unavailable. Ensure device location/GPS is turned on.');
          } else {
            setLiveTrackingError('Location request timed out. Move to an open area and try again.');
          }
        }
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );

    liveWatchIdRef.current = watchId;
    setIsLiveTracking(true);
    persistTrackingFlags(ctx.currentUser.uid, true);
  };

  // Auto-resume live GPS tracking across page reloads if employee consented & is still checked in today
  const autoResumedUidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentUser || !currentUser.isActive || currentUser.role === 'Pending') {
      autoResumedUidRef.current = null;
      return;
    }
    if (autoResumedUidRef.current === currentUser.uid) return;
    if (liveWatchIdRef.current !== null) return;

    const today = todayIsoDate();
    let storedDutyToday = false;
    try {
      storedDutyToday =
        localStorage.getItem(`${LIVE_TRACKING_DUTY_STORAGE_PREFIX}${currentUser.uid}`) ===
        today;
    } catch {
      storedDutyToday = false;
    }

    const checkedInToday = attendance.some(
      (a) =>
        a.userId === currentUser.uid &&
        a.date === today &&
        Boolean(a.checkInTime) &&
        !a.checkOutTime
    );

    if (checkedInToday && storedDutyToday && livePermissionState === 'granted') {
      autoResumedUidRef.current = currentUser.uid;
      startAppLiveTracking({
        silentIfUnavailable: true,
        note: 'Resumed active duty GPS tracking',
      });
    }
  }, [currentUser, attendance, livePermissionState]);

  const liveTrackingController: LiveTrackingController = {
    isTracking: isLiveTracking,
    permissionState: livePermissionState,
    trackingError: liveTrackingError,
    lastPingAtMs: lastLivePingAtMs,
    currentCoords: liveTrackingCoords,
    startLiveTracking: startAppLiveTracking,
    stopLiveTracking: stopAppLiveTracking,
    recordManualPing: async ({ coords, status, trackingActive, customer, note }) => {
      if (!currentUser) return;
      const now = Date.now();
      setLastLivePingAtMs(now);
      setLiveTrackingCoords({
        lat: coords.latitude,
        lng: coords.longitude,
        accuracy: Math.round(coords.accuracy || 0),
        capturedAtMs: now,
      });
      await writeValidatedLocationPing({
        currentUser,
        employees,
        settings,
        coords,
        status,
        trackingActive,
        customer,
        note,
      });
    },
    clearTrackingError: () => setLiveTrackingError(''),
  };

  const handleShiftCheckIn = async (
    pos: GeolocationPosition,
    workMode: 'Field' | 'Office'
  ) => {
    startAppLiveTracking({
      initialPosition: pos,
      note: `${workMode} Attendance Check-In (Live)`,
      silentIfUnavailable: false,
    });
  };

  const handleShiftCheckOut = async (pos: GeolocationPosition) => {
    await stopAppLiveTracking({
      recordCheckoutPing: true,
      finalPosition: pos,
      note: 'Attendance Check-Out',
    });
  };

  const handleCheckEmployeeLiveLocation = (employeeUid: string) => {
    setFocusedLiveEmployeeUid(employeeUid);
    setActiveTab(isManagementRole(currentUser?.role) ? 'live-location' : 'my-visits');
  };

  const handleLogout = async () => {
    await stopAppLiveTracking({ recordCheckoutPing: false });
    setSessionLockFlag(false);
    setBiometricLocked(false);
    setSensitiveModulesUnlocked(false);
    if (currentUser) {
      try {
        await logActivity({
          userId: currentUser.uid,
          employeeName: currentUser.displayName,
          action: 'Logout',
          details: 'Signed out of Glacetor Remedies BMS',
        });
      } catch {
        // non-blocking
      }
    }
    await signOut(auth);
  };

  const deviceBinding = useMemo(() => {
    void biometricBindingTick;
    return getDeviceBiometricBinding();
  }, [biometricBindingTick, currentUser?.uid]);

  const hasDeviceBiometric = Boolean(
    currentUser && deviceBinding && deviceBinding.userId === currentUser.uid
  );
  const showBiometricLockScreen = Boolean(biometricLocked && hasDeviceBiometric);

  const handleLockWithBiometrics = () => {
    if (!hasDeviceBiometric) return;
    setSessionLockFlag(true);
    setBiometricLocked(true);
    setSensitiveModulesUnlocked(false);
    setMobileMenuOpen(false);
  };

  const handleUnlockSensitiveModules = async () => {
    if (!deviceBinding) return;
    setUnlockingSensitive(true);
    setSensitiveUnlockError('');
    try {
      const res = await verifyDeviceBiometrics(deviceBinding.credentialId);
      await touchBiometricLastUsed(res.credentialId);
      setSensitiveModulesUnlocked(true);
    } catch (err: any) {
      setSensitiveUnlockError(
        err?.message || 'Could not verify Fingerprint / Face ID.'
      );
    } finally {
      setUnlockingSensitive(false);
    }
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <BrandLoader
          size={80}
          showFullLogo
          label="Loading Glacetor Remedies ERP..."
        />
      </div>
    );
  }

  if (
    !isFirebaseConfigured ||
    !firebaseUser ||
    needsFirstAdminSetup ||
    !currentUser ||
    currentUser.role === 'Pending' ||
    !currentUser.isActive ||
    showBiometricLockScreen
  ) {
    return (
      <>
        <AuthPortal
          firebaseUser={firebaseUser}
          currentUser={currentUser}
          needsFirstAdminSetup={needsFirstAdminSetup}
          pendingApproval={Boolean(currentUser && currentUser.role === 'Pending')}
          accountDeactivated={Boolean(currentUser && !currentUser.isActive)}
          biometricLocked={showBiometricLockScreen}
          onBootstrapComplete={() => setBootstrapTick((t) => t + 1)}
          onBiometricUnlock={() => {
            setSessionLockFlag(false);
            setBiometricLocked(false);
            setSensitiveModulesUnlocked(true);
          }}
        />
        <OfflineIndicator />
      </>
    );
  }

  const isAdminPanel = isManagementRole(currentUser.role);
  const isStockManager = currentUser.role === 'Stock Manager';
  const isDistributor = currentUser.role === 'Distributor';
  const activeNavLabel =
    navItems.find((i) => i.id === activeTab)?.label || 'Workspace';

  const mobileQuickTabs = navItems.slice(0, 4);

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        if (isStockManager) {
          return (
            <StockManagerDashboard
              products={products}
              stockMovements={stockMovements}
              onNavigate={(tab) => setActiveTab(tab)}
            />
          );
        }
        return (
          <AdminDashboard
            employees={employees}
            attendance={attendance}
            locations={locations}
            doctorCalls={doctorCalls}
            tasks={tasks}
            products={products}
            salesOrders={salesOrders}
            leaveRequests={leaveRequests}
            stockMovements={stockMovements}
            settings={settings}
            onNavigate={(tab: AdminTab) => setActiveTab(tab)}
            onCheckLiveLocation={handleCheckEmployeeLiveLocation}
          />
        );
      case 'my-dashboard':
        if (isDistributor) {
          const distProfile = distributors.find(
            (d) =>
              d.uid === currentUser.uid ||
              d.email.toLowerCase() === currentUser.email.toLowerCase()
          );
          return (
            <DistributorDashboard
              currentUser={currentUser}
              distributorProfile={distProfile}
              allocations={allocations}
              orders={salesOrders}
              payments={payments}
              products={products}
              onNavigate={(tab) => setActiveTab(tab)}
            />
          );
        }
        return (
          <EmployeeDashboard
            currentUser={currentUser}
            attendance={attendance}
            tasks={tasks}
            activities={activities}
            customers={customers}
            allocations={allocations}
            salesOrders={salesOrders}
            leaveRequests={leaveRequests}
            locations={locations}
            notifications={notifications}
            isLiveTrackingActive={isLiveTracking}
            onNavigate={(tab: EmployeeTab) => setActiveTab(tab)}
          />
        );
      case 'employees':
        return (
          <EmployeesModule
            currentUser={currentUser}
            employees={employees}
            users={users}
            onCheckLiveLocation={handleCheckEmployeeLiveLocation}
          />
        );
      case 'live-location':
      case 'my-visits':
        return (
          <LocationTrackingModule
            currentUser={currentUser}
            isAdminView={isAdminPanel}
            locations={locations}
            employees={employees}
            customers={customers}
            doctorCalls={doctorCalls}
            settings={settings}
            liveTracking={liveTrackingController}
            initialFocusEmployeeUid={focusedLiveEmployeeUid}
            onClearInitialFocus={() => setFocusedLiveEmployeeUid(null)}
          />
        );
      case 'attendance':
      case 'my-attendance':
        return (
          <AttendanceModule
            currentUser={currentUser}
            isAdminView={isAdminPanel}
            attendance={attendance}
            leaveRequests={leaveRequests}
            employees={employees}
            settings={settings}
            onShiftCheckIn={handleShiftCheckIn}
            onShiftCheckOut={handleShiftCheckOut}
          />
        );
      case 'tour-plan':
      case 'my-tour-plan':
        return (
          <TourPlanModule
            currentUser={currentUser}
            isAdminView={isAdminPanel}
            tourPlans={tourPlans}
            employees={employees}
            customers={customers}
          />
        );
      case 'tasks':
      case 'my-tasks':
        return (
          <TasksModule
            currentUser={currentUser}
            isAdminView={isAdminPanel}
            tasks={tasks}
            taskUpdates={taskUpdates}
            employees={employees}
          />
        );
      case 'activity':
      case 'my-activity':
        return (
          <ActivityModule
            isAdminView={isAdminPanel}
            activities={activities}
            employees={employees}
          />
        );
      case 'products':
      case 'inventory':
      case 'stock-movements':
      case 'my-stock':
        return (
          <InventoryModule
            currentUser={currentUser}
            mode={activeTab}
            isStockAuthorized={isAdminPanel || isStockManager}
            products={products}
            stockMovements={stockMovements}
            salesOrders={salesOrders}
            allocations={allocations}
            employees={employees}
            distributors={distributors}
          />
        );
      case 'doctors':
      case 'my-doctors':
        return (
          <DoctorsModule
            currentUser={currentUser}
            isAdminView={isAdminPanel}
            doctors={doctors}
            doctorCalls={doctorCalls}
            products={products}
            employees={employees}
            settings={settings}
          />
        );
      case 'customers':
      case 'sales':
      case 'orders':
      case 'distributors':
      case 'payments':
      case 'my-customers':
      case 'my-sales':
      case 'my-orders':
        return (
          <SalesCustomersModule
            currentUser={currentUser}
            mode={activeTab}
            isAdminView={isAdminPanel || isStockManager}
            customers={customers}
            products={products}
            orders={salesOrders}
            payments={payments}
            distributors={distributors}
            employees={employees}
            onOpenExpenses={() =>
              setActiveTab(isAdminPanel ? 'expenses' : 'my-expenses')
            }
          />
        );
      case 'expenses':
      case 'my-expenses':
        return (
          <ExpensesModule
            currentUser={currentUser}
            isAdminView={isAdminPanel}
            expenses={expenses}
            employees={employees}
          />
        );
      case 'reports':
        return (
          <ReportsModule
            employees={employees}
            attendance={attendance}
            activities={activities}
            tasks={tasks}
            locations={locations}
            doctorCalls={doctorCalls}
            salesOrders={salesOrders}
            products={products}
            customers={customers}
            distributors={distributors}
            payments={payments}
          />
        );
      case 'notifications':
        return <NotificationsModule notifications={notifications} />;
      case 'settings':
        return (
          <SettingsModule
            currentUser={currentUser}
            settings={settings}
            biometricCredentials={biometricCredentials}
            onLockWithBiometrics={handleLockWithBiometrics}
            onBiometricBindingChange={() =>
              setBiometricBindingTick((t) => t + 1)
            }
            onEnrolledHere={() => setSensitiveModulesUnlocked(true)}
          />
        );
      case 'my-profile':
        return (
          <ProfileModule
            currentUser={currentUser}
            biometricCredentials={biometricCredentials}
            onLockWithBiometrics={handleLockWithBiometrics}
            onBiometricBindingChange={() =>
              setBiometricBindingTick((t) => t + 1)
            }
            onEnrolledHere={() => setSensitiveModulesUnlocked(true)}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-[#F4F6F9] flex flex-col md:flex-row">
      {/* Desktop Fixed Sidebar (256px) */}
      <aside className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 bg-[#0F2744] text-white z-30 no-print">
        <div className="px-5 py-4 border-b border-white/10 flex items-center gap-3">
          <BrandMark size={34} />
          <div className="min-w-0">
            <div className="text-sm font-bold tracking-tight truncate">
              Glacetor Remedies
            </div>
            <div className="text-[11px] text-slate-300 truncate">
              {currentUser.designation &&
              currentUser.designation !== getRoleDisplayLabel(currentUser.role)
                ? `${currentUser.designation} · ${getRoleDisplayLabel(currentUser.role)}`
                : getRoleDisplayLabel(currentUser.role)}
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-colors ${
                  active
                    ? 'bg-[#16A34A] text-white'
                    : 'text-slate-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2.5 truncate">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.id === 'notifications' && unreadCount > 0 && (
                  <span className="font-mono text-[11px] font-bold bg-white text-[#0F2744] px-1.5 py-0.5 rounded">
                    {unreadCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-white/10">
          <div className="px-2 py-2 text-xs">
            <div className="font-semibold text-white truncate">
              {currentUser.displayName}
            </div>
            <div className="text-[11px] text-slate-400 truncate">
              {currentUser.email}
            </div>
          </div>
          {hasDeviceBiometric && (
            <button
              type="button"
              onClick={handleLockWithBiometrics}
              className="mt-1 w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-white/10 hover:text-emerald-200 rounded-lg transition-colors"
            >
              <Lock className="w-4 h-4" />
              Lock App
            </button>
          )}
          <button
            type="button"
            onClick={handleLogout}
            className="mt-1 w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/10 hover:text-white rounded-lg transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 md:pl-64 flex flex-col min-h-screen">
        {/* Top Bar (Desktop & Mobile compact <=52px) */}
        <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-4 md:px-6 h-13 flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <div className="md:hidden">
              <BrandMark size={28} />
            </div>
            <div className="min-w-0">
              <div className="text-xs text-slate-400 hidden sm:block truncate">
                Glacetor Remedies Pvt. Ltd. / {activeNavLabel}
              </div>
              <h1 className="text-sm font-bold text-slate-900 sm:hidden truncate">
                {activeNavLabel}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isLiveTracking && (
              <button
                type="button"
                onClick={() => setActiveTab(isAdminPanel ? 'live-location' : 'my-visits')}
                title="Live GPS tracking is active across all tabs"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-bold text-[#15803D] bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 rounded-lg whitespace-nowrap"
              >
                <span className="w-2 h-2 rounded-full bg-[#15803D] animate-pulse shrink-0" />
                <span>GPS Live</span>
              </button>
            )}
            <SyncStatusIndicator
              syncMap={syncMap}
              snapshotsInSyncTick={snapshotsInSyncTick}
            />
            <PWAInstallButton />
            {hasDeviceBiometric && (
              <button
                type="button"
                onClick={handleLockWithBiometrics}
                title="Lock with Fingerprint / Face ID"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[#15803D] bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg whitespace-nowrap min-h-[36px]"
              >
                <Lock className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Lock</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setActiveTab('notifications')}
              className="relative p-2 text-slate-600 hover:text-[#0F2744] hover:bg-slate-100 rounded-lg min-h-[40px] min-w-[40px] flex items-center justify-center"
              aria-label="Notifications"
            >
              <Bell className="w-4 h-4" />
              {unreadCount > 0 && (
                <span className="absolute top-1.5 right-1.5 text-[10px] font-mono font-bold text-white bg-[#15803D] rounded px-1 leading-tight">
                  {unreadCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out
            </button>
          </div>
        </header>

        {/* Scrollable Workspace */}
        <main className="flex-1 p-4 md:p-6 pb-24 md:pb-8 max-w-7xl w-full mx-auto">
          {hasDeviceBiometric &&
          deviceBinding?.protectSensitiveModules !== false &&
          SENSITIVE_MODULE_TABS.has(activeTab) &&
          !sensitiveModulesUnlocked ? (
            <div className="max-w-md mx-auto mt-10 bg-white border border-slate-200 rounded-2xl p-6 text-center space-y-4 shadow-sm">
              <div className="w-12 h-12 rounded-xl bg-emerald-50 border border-emerald-200 text-[#15803D] flex items-center justify-center mx-auto">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  Biometric Verification Required
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  <strong>{activeNavLabel}</strong> is protected on {deviceBinding?.deviceLabel}. Verify with Fingerprint or Face ID to view this module.
                </p>
              </div>
              {sensitiveUnlockError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs text-left">
                  {sensitiveUnlockError}
                </div>
              )}
              <div className="space-y-2 pt-1">
                <button
                  type="button"
                  disabled={unlockingSensitive}
                  onClick={handleUnlockSensitiveModules}
                  className="w-full py-3 px-4 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-xl flex items-center justify-center gap-2 min-h-[44px] disabled:opacity-60"
                >
                  <Fingerprint className="w-4 h-4" />
                  {unlockingSensitive
                    ? 'Verifying Hardware...'
                    : 'Unlock with Fingerprint / Face ID'}
                </button>
                <button
                  type="button"
                  onClick={handleLockWithBiometrics}
                  className="w-full py-2.5 px-4 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-xl flex items-center justify-center gap-1.5"
                >
                  <Lock className="w-3.5 h-3.5" />
                  Lock Entire App
                </button>
              </div>
            </div>
          ) : (
            renderContent()
          )}
        </main>
      </div>

      {/* Android / Mobile Bottom Navigation Bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-slate-200 grid grid-cols-5 h-14 pb-safe no-print">
        {mobileQuickTabs.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setActiveTab(item.id);
                setMobileMenuOpen(false);
              }}
              className={`flex flex-col items-center justify-center min-h-[44px] ${
                active ? 'text-[#0F2744] font-semibold' : 'text-slate-500'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] mt-0.5 truncate max-w-[64px]">
                {item.label.replace('My ', '')}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setMobileMenuOpen((v) => !v)}
          className="flex flex-col items-center justify-center min-h-[44px] text-slate-600"
        >
          <Menu className="w-5 h-5" />
          <span className="text-[10px] mt-0.5">Menu</span>
        </button>
      </nav>

      {/* Mobile Full Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-slate-900/50 flex flex-col justify-end no-print">
          <div className="bg-white rounded-t-2xl max-h-[80vh] overflow-y-auto p-5 pb-20 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <div className="text-sm font-bold text-[#0F2744]">
                  {currentUser.displayName}
                </div>
                <div className="text-xs text-slate-500">
                  {currentUser.designation &&
                  currentUser.designation !== getRoleDisplayLabel(currentUser.role)
                    ? `${currentUser.designation} · ${getRoleDisplayLabel(currentUser.role)}`
                    : getRoleDisplayLabel(currentUser.role)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`flex items-center gap-2.5 px-3 py-3 rounded-xl text-xs font-medium text-left min-h-[44px] ${
                      active
                        ? 'bg-[#0F2744] text-white'
                        : 'bg-slate-50 text-slate-700 border border-slate-200'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="space-y-2">
              {hasDeviceBiometric && (
                <button
                  type="button"
                  onClick={handleLockWithBiometrics}
                  className="w-full py-3 text-xs font-semibold text-[#15803D] bg-emerald-50 border border-emerald-200 rounded-xl flex items-center justify-center gap-2"
                >
                  <Lock className="w-4 h-4" />
                  Lock App (Fingerprint / Face ID)
                </button>
              )}
              <button
                type="button"
                onClick={handleLogout}
                className="w-full py-3 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl flex items-center justify-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      {(activeTab === 'dashboard' || activeTab === 'my-dashboard') && !mobileMenuOpen && (
        <QuickActionMenu
          currentUser={currentUser}
          attendance={attendance}
          customers={customers}
          doctors={doctors}
          products={products}
          allocations={allocations}
          employees={employees}
          settings={settings}
          onNavigate={(tab) => setActiveTab(tab)}
          onShiftCheckIn={handleShiftCheckIn}
          onShiftCheckOut={handleShiftCheckOut}
        />
      )}

      <OfflineIndicator />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <WorkspaceApp />
    </ErrorBoundary>
  );
}
