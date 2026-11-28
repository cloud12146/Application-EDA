import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import {
  Banknote,
  Camera,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Eye,
  FileImage,
  MapPin,
  Pencil,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import {
  db,
  handleFirestoreError,
  OperationType,
  storage,
} from '../lib/firebase';
import { logActivity, pushNotification } from '../lib/erpActions';
import {
  currentMonthKey,
  exportToCsv,
  formatCurrency,
  formatTimestamp,
  generateId,
  todayIsoDate,
} from '../lib/utils';
import {
  blobToDataUrl,
  clearFormDraft,
  dataUrlToBlob,
  formatDraftAge,
  getExpenseDraftKey,
  loadFormDraft,
  saveFormDraft,
} from '../lib/formDrafts';
import { getRoleDisplayLabel } from '../lib/roles';
import {
  Employee,
  ExpenseCategory,
  ExpenseClaim,
  ExpenseStatus,
  ExpenseWorkingType,
  UserAccount,
} from '../types/erp';

interface ExpensesModuleProps {
  currentUser: UserAccount;
  isAdminView: boolean;
  expenses: ExpenseClaim[];
  employees: Employee[];
}

const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'Travel / Fuel',
  'Daily Allowance',
  'Meals & Hospitality',
  'Lodging / Hotel',
  'Doctor Visit / CME',
  'Courier / Misc',
];

const WORKING_TYPES: ExpenseWorkingType[] = [
  'HQ Working',
  'Ex-HQ Working',
  'Outstation',
  'Transit',
  'Field Camp / CME',
  'Office / Admin',
];

const EXPENSE_STATUSES: ExpenseStatus[] = [
  'Draft',
  'Pending Approval',
  'Approved',
  'Rejected',
  'Reimbursed',
];

const STATUS_BADGE: Record<ExpenseStatus, string> = {
  Draft: 'bg-slate-100 text-slate-700 border-slate-200',
  'Pending Approval': 'bg-amber-50 text-amber-800 border-amber-200',
  Approved: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  Rejected: 'bg-red-50 text-red-700 border-red-200',
  Reimbursed: 'bg-sky-50 text-sky-800 border-sky-200',
};

interface ExpenseFormDraft {
  expenseDate: string;
  category: ExpenseCategory;
  workingType: ExpenseWorkingType;
  patchArea: string;
  dailyAllowance: string;
  travellingAllowance: string;
  otherExpense: string;
  amount: string;
  travelFrom: string;
  travelTo: string;
  distanceKm: string;
  description: string;
  receiptDataUrl?: string;
}

function hasExpenseDraftContent(d: ExpenseFormDraft): boolean {
  return Boolean(
    d.amount.trim() ||
      (d.dailyAllowance || '').trim() ||
      (d.travellingAllowance || '').trim() ||
      (d.otherExpense || '').trim() ||
      (d.patchArea || '').trim() ||
      d.travelFrom.trim() ||
      d.travelTo.trim() ||
      d.distanceKm.trim() ||
      d.description.trim() ||
      d.receiptDataUrl
  );
}

async function compressImageToJpegBlob(
  source: HTMLVideoElement | File,
  maxWidth = 1200,
  quality = 0.8
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to initialize image canvas.');
  }

  if (source instanceof HTMLVideoElement) {
    const vw = source.videoWidth || 1280;
    const vh = source.videoHeight || 720;
    const scale = vw > maxWidth ? maxWidth / vw : 1;
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  } else {
    const imgUrl = URL.createObjectURL(source);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Invalid receipt image file.'));
        el.src = imgUrl;
      });
      const scale = img.width > maxWidth ? maxWidth / img.width : 1;
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } finally {
      URL.revokeObjectURL(imgUrl);
    }
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error('Failed to encode receipt JPEG.'));
        else resolve(blob);
      },
      'image/jpeg',
      quality
    );
  });
}

export const ExpensesModule: React.FC<ExpensesModuleProps> = ({
  currentUser,
  isAdminView,
  expenses,
  employees,
}) => {
  const isSuperAdmin = currentUser.role === 'Super Admin';
  const isExecutiveRole =
    currentUser.role === 'Super Admin' || currentUser.role === 'Admin';
  // All posts except Super Admin & Admin get Working/Patch + Daily Allowance (₹) + Travelling Allowance (₹) self-entry
  const allowSelfAllowanceEntry = !isExecutiveRole;

  const myEmployee = useMemo(
    () =>
      employees.find(
        (e) =>
          e.uid === currentUser.uid ||
          e.email.toLowerCase() === currentUser.email.toLowerCase()
      ),
    [employees, currentUser.uid, currentUser.email]
  );

  const myDesignation =
    myEmployee?.designation ||
    currentUser.designation ||
    getRoleDisplayLabel(currentUser.role);
  const defaultPatchArea = myEmployee?.territory || currentUser.territory || '';

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | ExpenseStatus>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | ExpenseCategory>('ALL');
  const [monthFilter, setMonthFilter] = useState<string>(currentMonthKey());
  const [employeeFilter, setEmployeeFilter] = useState<string>('ALL');
  const [scopeTab, setScopeTab] = useState<'ALL' | 'MINE'>('ALL');

  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Form modal state
  const [showFormModal, setShowFormModal] = useState(false);
  const [editingClaim, setEditingClaim] = useState<ExpenseClaim | null>(null);
  const [expenseDate, setExpenseDate] = useState(todayIsoDate());
  const [category, setCategory] = useState<ExpenseCategory>('Travel / Fuel');
  const [workingType, setWorkingType] = useState<ExpenseWorkingType>('HQ Working');
  const [patchArea, setPatchArea] = useState(defaultPatchArea);
  const [dailyAllowance, setDailyAllowance] = useState('');
  const [travellingAllowance, setTravellingAllowance] = useState('');
  const [otherExpense, setOtherExpense] = useState('');
  const [amount, setAmount] = useState('');
  const [travelFrom, setTravelFrom] = useState('');
  const [travelTo, setTravelTo] = useState('');
  const [distanceKm, setDistanceKm] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Camera & Receipt Capture state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [pendingBlob, setPendingBlob] = useState<Blob | null>(null);
  const [pendingReceiptDataUrl, setPendingReceiptDataUrl] = useState<string>('');
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [existingReceiptUrl, setExistingReceiptUrl] = useState<string>('');
  const [existingReceiptPath, setExistingReceiptPath] = useState<string>('');

  // LocalStorage draft persistence state
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [savedNewDraftMeta, setSavedNewDraftMeta] = useState<{
    savedAt: number;
    amount: string;
    category: ExpenseCategory;
  } | null>(null);

  // Super Admin review / lightbox state
  const [inspectClaim, setInspectClaim] = useState<ExpenseClaim | null>(null);
  const [reviewRemarks, setReviewRemarks] = useState('');
  const [reimburseRef, setReimburseRef] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  };

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (previewUrl && previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const clearPreviewBlob = () => {
    if (previewUrl && previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(previewUrl);
    }
    setPendingBlob(null);
    setPendingReceiptDataUrl('');
    setPreviewUrl('');
  };

  const refreshSavedNewDraftBanner = () => {
    const stored = loadFormDraft<ExpenseFormDraft>(getExpenseDraftKey(currentUser.uid));
    if (stored && hasExpenseDraftContent(stored.data)) {
      setSavedNewDraftMeta({
        savedAt: stored.savedAt,
        amount: stored.data.amount,
        category: stored.data.category,
      });
    } else {
      setSavedNewDraftMeta(null);
    }
  };

  useEffect(() => {
    refreshSavedNewDraftBanner();
  }, [currentUser.uid]);

  const computeTotalFromBreakdown = (da: string, ta: string, other: string): number => {
    const d = Number(da) || 0;
    const t = Number(ta) || 0;
    const o = Number(other) || 0;
    return Math.round((d + t + o) * 100) / 100;
  };

  const applyDraftToForm = (draft: ExpenseFormDraft, savedAt: number) => {
    setExpenseDate(draft.expenseDate || todayIsoDate());
    setCategory(draft.category || 'Travel / Fuel');
    setWorkingType(draft.workingType || 'HQ Working');
    setPatchArea(draft.patchArea ?? defaultPatchArea);
    setDailyAllowance(draft.dailyAllowance || '');
    setTravellingAllowance(draft.travellingAllowance || '');
    setOtherExpense(draft.otherExpense || '');
    setAmount(draft.amount || '');
    setTravelFrom(draft.travelFrom || '');
    setTravelTo(draft.travelTo || '');
    setDistanceKm(draft.distanceKm || '');
    setDescription(draft.description || '');
    if (draft.receiptDataUrl) {
      const restoredBlob = dataUrlToBlob(draft.receiptDataUrl);
      if (restoredBlob) {
        setPendingBlob(restoredBlob);
        setPendingReceiptDataUrl(draft.receiptDataUrl);
        setPreviewUrl(URL.createObjectURL(restoredBlob));
      }
    }
    setDraftRestored(true);
    setDraftSavedAt(savedAt);
  };

  const populateFormFromClaim = (claim: ExpenseClaim) => {
    setExpenseDate(claim.expenseDate);
    setCategory(claim.category);
    setWorkingType(claim.workingType || 'HQ Working');
    setPatchArea(claim.patchArea || claim.territory || defaultPatchArea);

    const hasStructured =
      typeof claim.dailyAllowance === 'number' ||
      typeof claim.travellingAllowance === 'number' ||
      typeof claim.otherExpense === 'number';

    if (hasStructured) {
      setDailyAllowance(
        typeof claim.dailyAllowance === 'number' && claim.dailyAllowance > 0
          ? String(claim.dailyAllowance)
          : ''
      );
      setTravellingAllowance(
        typeof claim.travellingAllowance === 'number' && claim.travellingAllowance > 0
          ? String(claim.travellingAllowance)
          : ''
      );
      setOtherExpense(
        typeof claim.otherExpense === 'number' && claim.otherExpense > 0
          ? String(claim.otherExpense)
          : ''
      );
    } else if (claim.category === 'Daily Allowance') {
      setDailyAllowance(String(claim.amount));
      setTravellingAllowance('');
      setOtherExpense('');
    } else if (claim.category === 'Travel / Fuel') {
      setDailyAllowance('');
      setTravellingAllowance(String(claim.amount));
      setOtherExpense('');
    } else {
      setDailyAllowance('');
      setTravellingAllowance('');
      setOtherExpense(String(claim.amount));
    }

    setAmount(String(claim.amount));
    setTravelFrom(claim.travelFrom || '');
    setTravelTo(claim.travelTo || '');
    setDistanceKm(
      typeof claim.distanceKm === 'number' && claim.distanceKm > 0
        ? String(claim.distanceKm)
        : ''
    );
    setDescription(claim.description);
  };

  const openCreateModal = () => {
    stopCamera();
    clearPreviewBlob();
    setEditingClaim(null);
    setExistingReceiptUrl('');
    setExistingReceiptPath('');
    setCameraError('');
    setFormError('');

    const stored = loadFormDraft<ExpenseFormDraft>(getExpenseDraftKey(currentUser.uid));
    if (stored && hasExpenseDraftContent(stored.data)) {
      applyDraftToForm(stored.data, stored.savedAt);
    } else {
      setExpenseDate(todayIsoDate());
      setCategory('Travel / Fuel');
      setWorkingType('HQ Working');
      setPatchArea(defaultPatchArea);
      setDailyAllowance('');
      setTravellingAllowance('');
      setOtherExpense('');
      setAmount('');
      setTravelFrom('');
      setTravelTo('');
      setDistanceKm('');
      setDescription('');
      setDraftRestored(false);
      setDraftSavedAt(null);
    }
    setShowFormModal(true);
  };

  const openEditModal = (claim: ExpenseClaim) => {
    stopCamera();
    clearPreviewBlob();
    setEditingClaim(claim);
    setExistingReceiptUrl(claim.receiptUrl || '');
    setExistingReceiptPath(claim.receiptPath || '');
    setCameraError('');
    setFormError('');

    const stored = loadFormDraft<ExpenseFormDraft>(
      getExpenseDraftKey(currentUser.uid, claim.id)
    );
    if (stored && hasExpenseDraftContent(stored.data)) {
      applyDraftToForm(stored.data, stored.savedAt);
    } else {
      populateFormFromClaim(claim);
      setDraftRestored(false);
      setDraftSavedAt(null);
    }
    setShowFormModal(true);
  };

  const closeFormModal = () => {
    persistCurrentExpenseDraft();
    stopCamera();
    clearPreviewBlob();
    setShowFormModal(false);
    refreshSavedNewDraftBanner();
  };

  const handleDiscardActiveDraft = () => {
    clearFormDraft(getExpenseDraftKey(currentUser.uid, editingClaim?.id));
    stopCamera();
    clearPreviewBlob();
    setDraftRestored(false);
    setDraftSavedAt(null);
    if (editingClaim) {
      populateFormFromClaim(editingClaim);
      setExistingReceiptUrl(editingClaim.receiptUrl || '');
      setExistingReceiptPath(editingClaim.receiptPath || '');
    } else {
      setExpenseDate(todayIsoDate());
      setCategory('Travel / Fuel');
      setWorkingType('HQ Working');
      setPatchArea(defaultPatchArea);
      setDailyAllowance('');
      setTravellingAllowance('');
      setOtherExpense('');
      setAmount('');
      setTravelFrom('');
      setTravelTo('');
      setDistanceKm('');
      setDescription('');
      setExistingReceiptUrl('');
      setExistingReceiptPath('');
    }
    refreshSavedNewDraftBanner();
  };

  // Auto-cache active expense form draft to localStorage & flush on tab close
  const latestExpenseDraftRef = useRef<{
    key: string;
    draft: ExpenseFormDraft;
    active: boolean;
  }>({
    key: getExpenseDraftKey(currentUser.uid),
    draft: {
      expenseDate,
      category,
      workingType,
      patchArea,
      dailyAllowance,
      travellingAllowance,
      otherExpense,
      amount,
      travelFrom,
      travelTo,
      distanceKm,
      description,
    },
    active: false,
  });

  latestExpenseDraftRef.current = {
    key: getExpenseDraftKey(currentUser.uid, editingClaim?.id),
    draft: {
      expenseDate,
      category,
      workingType,
      patchArea,
      dailyAllowance,
      travellingAllowance,
      otherExpense,
      amount: allowSelfAllowanceEntry
        ? String(computeTotalFromBreakdown(dailyAllowance, travellingAllowance, otherExpense) || '')
        : amount,
      travelFrom,
      travelTo,
      distanceKm,
      description,
      ...(pendingReceiptDataUrl ? { receiptDataUrl: pendingReceiptDataUrl } : {}),
    },
    active: showFormModal,
  };

  const persistCurrentExpenseDraft = () => {
    const { key, draft, active } = latestExpenseDraftRef.current;
    if (!active) return;
    if (!hasExpenseDraftContent(draft)) {
      clearFormDraft(key);
      setDraftSavedAt(null);
      return;
    }
    let saved = saveFormDraft(key, draft);
    if (!saved && draft.receiptDataUrl) {
      const { receiptDataUrl: _omit, ...textOnly } = draft;
      saved = saveFormDraft(key, textOnly);
    }
    if (saved) {
      setDraftSavedAt(Date.now());
    }
  };

  useEffect(() => {
    if (!showFormModal) return;
    const timer = window.setTimeout(persistCurrentExpenseDraft, 200);
    return () => window.clearTimeout(timer);
  }, [
    showFormModal,
    editingClaim?.id,
    currentUser.uid,
    expenseDate,
    category,
    workingType,
    patchArea,
    dailyAllowance,
    travellingAllowance,
    otherExpense,
    amount,
    travelFrom,
    travelTo,
    distanceKm,
    description,
    pendingReceiptDataUrl,
  ]);

  useEffect(() => {
    const flush = () => persistCurrentExpenseDraft();
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  const startLiveCamera = async () => {
    setCameraError('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        'Live camera preview is unavailable in this browser. Use "Take Photo / Upload" instead.'
      );
      return;
    }
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setCameraActive(true);
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {
            // Autoplay fallback handled by muted+playsInline
          });
        }
      });
    } catch (e: any) {
      setCameraActive(false);
      setCameraError(
        e?.name === 'NotAllowedError'
          ? 'Camera permission denied. Allow camera access or use "Take Photo / Upload".'
          : 'Could not start camera preview. Use "Take Photo / Upload" below.'
      );
    }
  };

  const captureFromVideo = async () => {
    if (!videoRef.current) return;
    setCameraError('');
    try {
      const blob = await compressImageToJpegBlob(videoRef.current, 1200, 0.8);
      clearPreviewBlob();
      const objectUrl = URL.createObjectURL(blob);
      const dataUrl = await blobToDataUrl(blob);
      setPendingBlob(blob);
      if (dataUrl) setPendingReceiptDataUrl(dataUrl);
      setPreviewUrl(objectUrl);
      stopCamera();
    } catch (e: any) {
      setCameraError(e?.message || 'Unable to capture frame.');
    }
  };

  const handleFileReceiptChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCameraError('');
    try {
      const blob = await compressImageToJpegBlob(file, 1200, 0.8);
      clearPreviewBlob();
      const objectUrl = URL.createObjectURL(blob);
      const dataUrl = await blobToDataUrl(blob);
      setPendingBlob(blob);
      if (dataUrl) setPendingReceiptDataUrl(dataUrl);
      setPreviewUrl(objectUrl);
      stopCamera();
    } catch (error: any) {
      setCameraError(error?.message || 'Could not process selected image.');
    }
  };

  const uploadReceiptIfNeeded = async (
    expenseId: string
  ): Promise<{ receiptUrl?: string; receiptPath?: string }> => {
    if (!pendingBlob) {
      if (existingReceiptUrl) {
        return {
          receiptUrl: existingReceiptUrl,
          receiptPath: existingReceiptPath || undefined,
        };
      }
      return {};
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new Error(
        'You are offline. Uploading a receipt image requires an internet connection—save as Draft without the photo or retry when online.'
      );
    }

    const storagePath = `expenses/${currentUser.uid}/${expenseId}_${Date.now()}.jpg`;
    const storageRef = ref(storage, storagePath);
    try {
      await uploadBytes(storageRef, pendingBlob, { contentType: 'image/jpeg' });
      const downloadUrl = await getDownloadURL(storageRef);
      return { receiptUrl: downloadUrl, receiptPath: storagePath };
    } catch (error: any) {
      const code = error?.code || '';
      if (code === 'storage/unauthorized') {
        throw new Error(
          'Firebase Storage permission denied for receipt upload. Please verify Firebase Storage rules.'
        );
      }
      throw new Error(
        error?.message || 'Failed to upload receipt image to Firebase Storage.'
      );
    }
  };

  const handleSaveExpense = async (targetStatus: 'Draft' | 'Pending Approval') => {
    setFormError('');
    setMsg('');
    setErr('');

    if (!expenseDate) {
      setFormError('Select the expense date.');
      return;
    }

    const daNum = dailyAllowance.trim() ? Number(dailyAllowance) : 0;
    const taNum = travellingAllowance.trim() ? Number(travellingAllowance) : 0;
    const otherNum = otherExpense.trim() ? Number(otherExpense) : 0;

    if (allowSelfAllowanceEntry) {
      if (!patchArea.trim()) {
        setFormError('Enter your working patch, beat, or market area.');
        return;
      }
      if (!Number.isFinite(daNum) || daNum < 0 || daNum > 100000) {
        setFormError('Daily Allowance (DA) must be between ₹0 and ₹1,00,000.');
        return;
      }
      if (!Number.isFinite(taNum) || taNum < 0 || taNum > 100000) {
        setFormError('Travelling Allowance (TA) must be between ₹0 and ₹1,00,000.');
        return;
      }
      if (!Number.isFinite(otherNum) || otherNum < 0 || otherNum > 1000000) {
        setFormError('Other Expense must be ₹0 or greater.');
        return;
      }
    }

    const numericAmount = allowSelfAllowanceEntry
      ? Math.round((daNum + taNum + otherNum) * 100) / 100
      : Math.round(Number(amount) * 100) / 100;

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setFormError(
        allowSelfAllowanceEntry
          ? 'Enter Daily Allowance (₹), Travelling Allowance (₹), or Other Expense greater than ₹0.'
          : 'Enter a valid expense amount greater than ₹0.'
      );
      return;
    }

    const resolvedDescription =
      description.trim() ||
      (allowSelfAllowanceEntry
        ? `${workingType} — ${patchArea.trim()} (DA ₹${daNum} + TA ₹${taNum}${
            otherNum > 0 ? ` + Other ₹${otherNum}` : ''
          })`
        : '');

    if (!resolvedDescription) {
      setFormError('Enter expense details or trip purpose.');
      return;
    }

    const numericKm = distanceKm.trim() ? Number(distanceKm) : undefined;
    if (
      numericKm !== undefined &&
      (!Number.isFinite(numericKm) || numericKm < 0 || numericKm > 10000)
    ) {
      setFormError('Distance must be between 0 and 10,000 km.');
      return;
    }

    const resolvedCategory: ExpenseCategory = allowSelfAllowanceEntry
      ? taNum > 0
        ? 'Travel / Fuel'
        : daNum > 0
        ? 'Daily Allowance'
        : category
      : category;

    setSaving(true);
    const expenseId = editingClaim ? editingClaim.id : generateId('exp');

    try {
      const { receiptUrl, receiptPath } = await uploadReceiptIfNeeded(expenseId);

      const basePayload: Record<string, any> = {
        expenseDate,
        category: resolvedCategory,
        amount: numericAmount,
        description: resolvedDescription.slice(0, 500),
        status: targetStatus,
        updatedAt: serverTimestamp(),
      };

      if (myDesignation) {
        basePayload.designation = myDesignation.slice(0, 80);
      }

      if (allowSelfAllowanceEntry) {
        basePayload.workingType = workingType;
        basePayload.patchArea = patchArea.trim().slice(0, 160);
        basePayload.dailyAllowance = Math.round(daNum * 100) / 100;
        basePayload.travellingAllowance = Math.round(taNum * 100) / 100;
        basePayload.otherExpense = Math.round(otherNum * 100) / 100;
      }

      if (travelFrom.trim()) basePayload.travelFrom = travelFrom.trim().slice(0, 120);
      if (travelTo.trim()) basePayload.travelTo = travelTo.trim().slice(0, 120);
      if (numericKm !== undefined) basePayload.distanceKm = numericKm;
      if (receiptUrl) basePayload.receiptUrl = receiptUrl;
      if (receiptPath) basePayload.receiptPath = receiptPath;

      if (editingClaim) {
        await updateDoc(doc(db, 'expenses', expenseId), basePayload);
      } else {
        await setDoc(doc(db, 'expenses', expenseId), {
          id: expenseId,
          userId: currentUser.uid,
          employeeName: currentUser.displayName,
          ...(currentUser.department ? { department: currentUser.department } : {}),
          ...(currentUser.territory ? { territory: currentUser.territory } : {}),
          ...basePayload,
          createdAt: serverTimestamp(),
        });
      }

      if (targetStatus === 'Pending Approval') {
        await logActivity({
          userId: currentUser.uid,
          employeeName: currentUser.displayName,
          action: editingClaim ? 'Expense Updated & Submitted' : 'Expense Submitted',
          entityType: 'expense',
          entityId: expenseId,
          details: `${resolvedCategory}: ${formatCurrency(numericAmount)} on ${expenseDate}${
            allowSelfAllowanceEntry ? ` (${workingType} · ${patchArea.trim()})` : ''
          }`,
        });
      }

      clearFormDraft(getExpenseDraftKey(currentUser.uid, editingClaim?.id));
      setDraftRestored(false);
      setDraftSavedAt(null);
      closeFormModal();
      setMsg(
        targetStatus === 'Pending Approval'
          ? editingClaim
            ? 'Expense updated and submitted for Super Admin approval.'
            : 'Expense submitted for Super Admin approval.'
          : editingClaim
          ? 'Expense draft updated.'
          : 'Expense saved as draft.'
      );
    } catch (error: any) {
      if (
        error instanceof Error &&
        (error.message.includes('Firebase Storage') || error.message.includes('offline'))
      ) {
        setFormError(error.message);
      } else {
        handleFirestoreError(
          error,
          editingClaim ? OperationType.UPDATE : OperationType.CREATE,
          `expenses/${expenseId}`
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const handleQuickSubmitDraft = async (claim: ExpenseClaim) => {
    setErr('');
    setMsg('');
    try {
      await updateDoc(doc(db, 'expenses', claim.id), {
        status: 'Pending Approval',
        updatedAt: serverTimestamp(),
      });
      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: 'Expense Submitted',
        entityType: 'expense',
        entityId: claim.id,
        details: `${claim.category}: ${formatCurrency(claim.amount)} on ${claim.expenseDate}`,
      });
      setMsg(`Expense claim for ${claim.expenseDate} submitted for approval.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `expenses/${claim.id}`);
    }
  };

  const handleDeleteClaim = async (claim: ExpenseClaim) => {
    setErr('');
    setMsg('');
    try {
      await deleteDoc(doc(db, 'expenses', claim.id));
      setMsg(`Deleted expense claim (${formatCurrency(claim.amount)}).`);
      if (inspectClaim?.id === claim.id) {
        setInspectClaim(null);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `expenses/${claim.id}`);
    }
  };

  const handleAdminStatusUpdate = async (
    claim: ExpenseClaim,
    nextStatus: 'Approved' | 'Rejected' | 'Reimbursed',
    remarksOverride?: string,
    payoutRefOverride?: string
  ) => {
    setErr('');
    setMsg('');
    const cleanRemark = (remarksOverride ?? reviewRemarks).trim();
    if (nextStatus === 'Rejected' && !cleanRemark) {
      setErr('Please provide rejection remarks so the employee knows what to revise.');
      return;
    }

    setReviewBusy(true);
    try {
      const updates: Record<string, any> = {
        status: nextStatus,
        reviewedByUid: currentUser.uid,
        reviewedByName: currentUser.displayName,
        updatedAt: serverTimestamp(),
      };
      if (cleanRemark) {
        updates.reviewRemarks = cleanRemark.slice(0, 400);
      }
      const cleanRef = (payoutRefOverride ?? reimburseRef).trim();
      if (nextStatus === 'Reimbursed' && cleanRef) {
        updates.reimbursedRef = cleanRef.slice(0, 80);
      }

      await updateDoc(doc(db, 'expenses', claim.id), updates);

      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: `Expense ${nextStatus}`,
        entityType: 'expense',
        entityId: claim.id,
        details: `${claim.employeeName} · ${claim.category} ${formatCurrency(claim.amount)} -> ${nextStatus}`,
      });

      await pushNotification({
        recipientUid: claim.userId,
        title: `Expense ${nextStatus}: ${formatCurrency(claim.amount)}`,
        message:
          nextStatus === 'Rejected'
            ? `${claim.category} (${claim.expenseDate}) rejected: ${cleanRemark}`
            : nextStatus === 'Reimbursed'
            ? `${claim.category} (${claim.expenseDate}) marked reimbursed${cleanRef ? ` (Ref: ${cleanRef})` : ''}.`
            : `${claim.category} (${claim.expenseDate}) approved by ${currentUser.displayName}.`,
        category: 'Expense',
        severity: nextStatus === 'Rejected' ? 'warning' : 'info',
        linkTab: 'my-expenses',
      });

      setMsg(`Marked ${claim.employeeName}'s claim as ${nextStatus}.`);
      setInspectClaim(null);
      setReviewRemarks('');
      setReimburseRef('');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `expenses/${claim.id}`);
    } finally {
      setReviewBusy(false);
    }
  };

  // Filtered claims list
  const filteredClaims = useMemo(() => {
    const q = search.trim().toLowerCase();
    return expenses.filter((c) => {
      if (isAdminView && scopeTab === 'MINE' && c.userId !== currentUser.uid) {
        return false;
      }
      if (monthFilter && !c.expenseDate.startsWith(monthFilter)) return false;
      if (statusFilter !== 'ALL' && c.status !== statusFilter) return false;
      if (categoryFilter !== 'ALL' && c.category !== categoryFilter) return false;
      if (isAdminView && employeeFilter !== 'ALL' && c.userId !== employeeFilter) {
        return false;
      }
      if (!q) return true;
      return (
        c.employeeName.toLowerCase().includes(q) ||
        (c.designation || '').toLowerCase().includes(q) ||
        (c.patchArea || '').toLowerCase().includes(q) ||
        (c.workingType || '').toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q) ||
        (c.travelFrom || '').toLowerCase().includes(q) ||
        (c.travelTo || '').toLowerCase().includes(q)
      );
    });
  }, [
    expenses,
    monthFilter,
    statusFilter,
    categoryFilter,
    employeeFilter,
    isAdminView,
    scopeTab,
    currentUser.uid,
    search,
  ]);

  // Summary metrics (scoped to selected month or all)
  const monthScoped = useMemo(
    () =>
      expenses.filter((c) => {
        if (isAdminView && scopeTab === 'MINE' && c.userId !== currentUser.uid) {
          return false;
        }
        return monthFilter ? c.expenseDate.startsWith(monthFilter) : true;
      }),
    [expenses, monthFilter, isAdminView, scopeTab, currentUser.uid]
  );

  const pendingList = monthScoped.filter((c) => c.status === 'Pending Approval');
  const pendingAmount = pendingList.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const approvedList = monthScoped.filter((c) => c.status === 'Approved');
  const approvedAmount = approvedList.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const reimbursedAmount = monthScoped
    .filter((c) => c.status === 'Reimbursed')
    .reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const totalSubmittedAmount = monthScoped
    .filter((c) => c.status !== 'Draft' && c.status !== 'Rejected')
    .reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const receiptsAttachedCount = monthScoped.filter((c) => Boolean(c.receiptUrl)).length;

  const uniqueEmployeeOptions = useMemo(() => {
    const map = new Map<string, string>();
    employees.forEach((e) => {
      const uid = e.uid || e.id;
      if (uid) map.set(uid, e.fullName);
    });
    expenses.forEach((ex) => {
      if (ex.userId && !map.has(ex.userId)) map.set(ex.userId, ex.employeeName);
    });
    return Array.from(map.entries()).map(([uid, name]) => ({ uid, name }));
  }, [employees, expenses]);

  const handleExportCsv = () => {
    exportToCsv(
      `glacetor-expenses-${monthFilter || 'all'}.csv`,
      [
        'Date',
        'Employee',
        'Designation',
        'Working Type',
        'Patch / Area',
        'Category',
        'Daily Allowance (INR)',
        'Travelling Allowance (INR)',
        'Other Expense (INR)',
        'Total Amount (INR)',
        'Route / From-To',
        'Distance (km)',
        'Description',
        'Status',
        'Receipt Attached',
        'Reviewed By',
        'Review Remarks',
        'Reimbursement Ref',
      ],
      filteredClaims.map((c) => [
        c.expenseDate,
        c.employeeName,
        c.designation || '',
        c.workingType || '',
        c.patchArea || c.territory || '',
        c.category,
        c.dailyAllowance ?? '',
        c.travellingAllowance ?? '',
        c.otherExpense ?? '',
        c.amount,
        c.travelFrom || c.travelTo ? `${c.travelFrom || ''} -> ${c.travelTo || ''}` : '',
        c.distanceKm ?? '',
        c.description,
        c.status,
        c.receiptUrl ? 'Yes' : 'No',
        c.reviewedByName || '',
        c.reviewRemarks || '',
        c.reimbursedRef || '',
      ])
    );
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            {isSuperAdmin
              ? 'Employee Expense Claims · Super Admin Approval & Payment'
              : isAdminView
              ? 'Expense Claims & My Daily / Travel Allowances'
              : 'My Working, Patch, DA & TA Expenses'}
          </h2>
          <p className="text-xs text-slate-500">
            {isSuperAdmin
              ? 'Review employee working, patch, Daily Allowance (DA) & Travelling Allowance (TA) claims, approve, and record payouts.'
              : 'Enter your working type, patch/area, Daily Allowance (₹), and Travelling Allowance (₹) directly. You can edit claims anytime before Super Admin approval.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isAdminView && (
            <div className="inline-flex rounded-lg bg-slate-100 p-1 text-xs font-semibold">
              <button
                type="button"
                onClick={() => setScopeTab('ALL')}
                className={`px-2.5 py-1.5 rounded-md transition-colors ${
                  scopeTab === 'ALL'
                    ? 'bg-[#0F2744] text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                All Claims
              </button>
              <button
                type="button"
                onClick={() => setScopeTab('MINE')}
                className={`px-2.5 py-1.5 rounded-md transition-colors ${
                  scopeTab === 'MINE'
                    ? 'bg-[#15803D] text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                My Claims
              </button>
            </div>
          )}
          {isAdminView && (
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg min-h-[40px]"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
          )}
          {!isExecutiveRole && (
            <button
              type="button"
              onClick={openCreateModal}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[40px]"
            >
              <Plus className="w-4 h-4" />
              Add DA / TA Expense
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center justify-between">
          <span>{msg}</span>
          <button type="button" onClick={() => setMsg('')} className="p-0.5 text-emerald-700">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {err && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs flex items-center justify-between">
          <span>{err}</span>
          <button type="button" onClick={() => setErr('')} className="p-0.5 text-red-700">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {savedNewDraftMeta && !showFormModal && (
        <div className="p-3.5 rounded-xl bg-sky-50 border border-sky-200 text-xs text-[#0F2744] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
          <div>
            <span className="font-semibold">Unsaved expense draft preserved locally:</span>{' '}
            <span className="text-slate-700">
              {savedNewDraftMeta.category}
              {savedNewDraftMeta.amount ? ` · ₹${savedNewDraftMeta.amount}` : ''} · saved{' '}
              {formatDraftAge(savedNewDraftMeta.savedAt)}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={openCreateModal}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-[#0F2744] hover:bg-slate-800 rounded-lg"
            >
              Resume Draft
            </button>
            <button
              type="button"
              onClick={() => {
                clearFormDraft(getExpenseDraftKey(currentUser.uid));
                setSavedNewDraftMeta(null);
              }}
              className="px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-red-700 hover:bg-white rounded-lg border border-slate-200"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div
          className={`bg-white border rounded-xl p-4 ${
            pendingList.length > 0 ? 'border-amber-300' : 'border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
            <span>Pending Approval</span>
            <Clock className="w-4 h-4 text-amber-600" />
          </div>
          <div className="text-xl font-bold font-mono tabular-nums text-amber-700">
            {formatCurrency(pendingAmount)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {pendingList.length} claim{pendingList.length === 1 ? '' : 's'} awaiting review
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
            <span>Approved (Unpaid)</span>
            <CheckCircle2 className="w-4 h-4 text-[#15803D]" />
          </div>
          <div className="text-xl font-bold font-mono tabular-nums text-[#15803D]">
            {formatCurrency(approvedAmount)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {approvedList.length} verified claim{approvedList.length === 1 ? '' : 's'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
            <span>Reimbursed</span>
            <Banknote className="w-4 h-4 text-sky-600" />
          </div>
          <div className="text-xl font-bold font-mono tabular-nums text-[#0F2744]">
            {formatCurrency(reimbursedAmount)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Settled in {monthFilter || 'all months'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
            <span>Total Valid Claims</span>
            <Receipt className="w-4 h-4 text-slate-500" />
          </div>
          <div className="text-xl font-bold font-mono tabular-nums text-slate-900">
            {formatCurrency(totalSubmittedAmount)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {receiptsAttachedCount} of {monthScoped.length} with receipt photo
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="relative lg:col-span-2">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search employee, route, or notes..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <input
              type="month"
              value={monthFilter}
              onChange={(e) => setMonthFilter(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
              aria-label="Filter by month"
            />
            {monthFilter && (
              <button
                type="button"
                onClick={() => setMonthFilter('')}
                className="px-2.5 py-2 text-xs text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                title="Show all months"
              >
                All
              </button>
            )}
          </div>

          <select
            value={categoryFilter}
            onChange={(e) =>
              setCategoryFilter(e.target.value as 'ALL' | ExpenseCategory)
            }
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
          >
            <option value="ALL">All Categories</option>
            {EXPENSE_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'ALL' | ExpenseStatus)}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
          >
            <option value="ALL">All Statuses</option>
            {EXPENSE_STATUSES.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        </div>

        {isAdminView && (
          <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-500 font-medium">Employee:</label>
              <select
                value={employeeFilter}
                onChange={(e) => setEmployeeFilter(e.target.value)}
                className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
              >
                <option value="ALL">All Field Staff</option>
                {uniqueEmployeeOptions.map((opt) => (
                  <option key={opt.uid} value={opt.uid}>
                    {opt.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              {pendingList.length > 0 && statusFilter !== 'Pending Approval' && (
                <button
                  type="button"
                  onClick={() => setStatusFilter('Pending Approval')}
                  className="px-3 py-1.5 text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200 rounded-lg hover:bg-amber-100"
                >
                  Show Pending Queue ({pendingList.length})
                </button>
              )}
              {statusFilter !== 'ALL' && (
                <button
                  type="button"
                  onClick={() => setStatusFilter('ALL')}
                  className="px-2.5 py-1.5 text-xs text-slate-600 hover:underline"
                >
                  Clear Status Filter
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Expense List */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filteredClaims.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500 space-y-2">
            <Receipt className="w-8 h-8 text-slate-300 mx-auto" />
            <div>No expense claims match the selected filters.</div>
            {!isExecutiveRole && (
              <button
                type="button"
                onClick={openCreateModal}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
              >
                <Camera className="w-3.5 h-3.5" />
                Add Working, Patch &amp; DA / TA Claim
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-semibold">Date</th>
                  {isAdminView && <th className="px-4 py-3 font-semibold">Employee &amp; Post</th>}
                  <th className="px-4 py-3 font-semibold">Working, Patch &amp; Details</th>
                  <th className="px-4 py-3 font-semibold">Receipt</th>
                  <th className="px-4 py-3 font-semibold text-right">DA / TA &amp; Total</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredClaims.map((c) => {
                  const isOwner = c.userId === currentUser.uid;
                  const canEmployeeEdit =
                    isOwner &&
                    (c.status === 'Draft' ||
                      c.status === 'Pending Approval' ||
                      c.status === 'Rejected');
                  const canEmployeeDelete =
                    isOwner && (c.status === 'Draft' || c.status === 'Rejected');
                  const hasDaTaBreakdown =
                    typeof c.dailyAllowance === 'number' ||
                    typeof c.travellingAllowance === 'number' ||
                    typeof c.otherExpense === 'number';
                  return (
                    <tr key={c.id} className="hover:bg-slate-50/70 align-top">
                      <td className="px-4 py-3 font-mono whitespace-nowrap text-slate-700">
                        {c.expenseDate}
                      </td>
                      {isAdminView && (
                        <td className="px-4 py-3">
                          <div className="font-semibold text-slate-900">
                            {c.employeeName}
                          </div>
                          {(c.designation || c.territory) && (
                            <div className="text-[11px] text-slate-500">
                              {[c.designation, c.territory].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </td>
                      )}
                      <td className="px-4 py-3 max-w-xs">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-slate-900">{c.category}</span>
                          {c.workingType && (
                            <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-slate-100 text-[#0F2744] rounded border border-slate-200">
                              {c.workingType}
                            </span>
                          )}
                        </div>
                        {c.patchArea && (
                          <div className="text-[11px] font-medium text-[#15803D] mt-0.5">
                            Patch: {c.patchArea}
                          </div>
                        )}
                        {(c.travelFrom || c.travelTo || typeof c.distanceKm === 'number') && (
                          <div className="text-[11px] text-[#0F2744] flex items-center gap-1 mt-0.5">
                            <MapPin className="w-3 h-3 shrink-0" />
                            <span>
                              {c.travelFrom || 'Start'} &rarr; {c.travelTo || 'End'}
                              {typeof c.distanceKm === 'number' && c.distanceKm > 0
                                ? ` (${c.distanceKm} km)`
                                : ''}
                            </span>
                          </div>
                        )}
                        <div className="text-slate-600 mt-0.5 line-clamp-2">
                          {c.description}
                        </div>
                        {c.reviewRemarks && (
                          <div className="text-[11px] text-slate-500 mt-1 italic">
                            Review: &ldquo;{c.reviewRemarks}&rdquo;
                          </div>
                        )}
                        {c.reimbursedRef && (
                          <div className="text-[11px] font-mono text-sky-700 mt-0.5">
                            Payout Ref: {c.reimbursedRef}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {c.receiptUrl ? (
                          <button
                            type="button"
                            onClick={() => {
                              setInspectClaim(c);
                              setReviewRemarks(c.reviewRemarks || '');
                              setReimburseRef(c.reimbursedRef || '');
                            }}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-[#0F2744] font-medium"
                          >
                            <FileImage className="w-3.5 h-3.5 text-[#15803D]" />
                            View Photo
                          </button>
                        ) : (
                          <span className="text-slate-400">No receipt</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums whitespace-nowrap">
                        <div className="font-bold text-slate-900">
                          {formatCurrency(c.amount)}
                        </div>
                        {hasDaTaBreakdown && (
                          <div className="text-[10px] text-slate-500 mt-0.5 space-y-0.5">
                            {typeof c.dailyAllowance === 'number' && c.dailyAllowance > 0 && (
                              <div>DA: {formatCurrency(c.dailyAllowance)}</div>
                            )}
                            {typeof c.travellingAllowance === 'number' &&
                              c.travellingAllowance > 0 && (
                                <div>TA: {formatCurrency(c.travellingAllowance)}</div>
                              )}
                            {typeof c.otherExpense === 'number' && c.otherExpense > 0 && (
                              <div>Other: {formatCurrency(c.otherExpense)}</div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span
                          className={`inline-block px-2 py-0.5 text-[11px] font-semibold border rounded ${
                            STATUS_BADGE[c.status]
                          }`}
                        >
                          {c.status}
                        </span>
                        {c.reviewedByName && c.status !== 'Draft' && (
                          <div className="text-[10px] text-slate-400 mt-0.5">
                            by {c.reviewedByName}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5 justify-end">
                          {(isSuperAdmin || isAdminView) && (
                            <button
                              type="button"
                              onClick={() => {
                                setInspectClaim(c);
                                setReviewRemarks(c.reviewRemarks || '');
                                setReimburseRef(c.reimbursedRef || '');
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-white bg-[#0F2744] hover:bg-slate-800 rounded-lg"
                            >
                              <Eye className="w-3 h-3" />
                              {isSuperAdmin ? 'Review / Pay' : 'View'}
                            </button>
                          )}

                          {canEmployeeEdit && c.status === 'Draft' && (
                            <button
                              type="button"
                              onClick={() => handleQuickSubmitDraft(c)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg"
                              title="Submit for Super Admin Approval"
                            >
                              <Send className="w-3 h-3" />
                              Submit
                            </button>
                          )}

                          {canEmployeeEdit && (
                            <button
                              type="button"
                              onClick={() => openEditModal(c)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-[#0F2744] bg-slate-100 hover:bg-slate-200 rounded-lg"
                              title="Edit DA, TA, Patch, Details or Receipt"
                            >
                              <Pencil className="w-3 h-3" />
                              Edit
                            </button>
                          )}

                          {canEmployeeDelete && (
                            <button
                              type="button"
                              onClick={() => handleDeleteClaim(c)}
                              className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg"
                              title="Delete Draft / Rejected Claim"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add / Edit Expense & Camera Receipt Modal */}
      {showFormModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-5 sm:p-6 shadow-xl my-auto max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {editingClaim ? 'Edit Expense Claim' : 'Log Working, Patch & DA / TA Expense'}
                </h3>
                <p className="text-xs text-slate-500">
                  {allowSelfAllowanceEntry
                    ? `Post: ${myDesignation} · Enter Daily Allowance (₹), Travelling Allowance (₹) & Patch for Super Admin approval.`
                    : 'Capture receipt via camera and log claim details.'}
                </p>
              </div>
              <button
                type="button"
                onClick={closeFormModal}
                className="p-1.5 text-slate-500 hover:text-slate-800 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <div className="mb-3 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs">
                {formError}
              </div>
            )}

            {(draftRestored || draftSavedAt) && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-[11px] text-slate-600 flex items-center justify-between gap-2">
                <span>
                  {draftRestored
                    ? 'Unsaved draft restored from local storage.'
                    : `Auto-saved locally (${formatDraftAge(draftSavedAt!)})`}
                </span>
                <button
                  type="button"
                  onClick={handleDiscardActiveDraft}
                  className="font-semibold text-red-700 hover:underline shrink-0"
                >
                  {editingClaim ? 'Revert to Saved' : 'Discard Draft'}
                </button>
              </div>
            )}

            <div className="space-y-3.5">
              {allowSelfAllowanceEntry ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Expense Date
                      </label>
                      <input
                        type="date"
                        value={expenseDate}
                        max={todayIsoDate()}
                        onChange={(e) => setExpenseDate(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Working Type
                      </label>
                      <select
                        value={workingType}
                        onChange={(e) => setWorkingType(e.target.value as ExpenseWorkingType)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                      >
                        {WORKING_TYPES.map((wt) => (
                          <option key={wt} value={wt}>
                            {wt}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Working Patch / Beat / Market Area
                      </label>
                      <input
                        type="text"
                        value={patchArea}
                        onChange={(e) => setPatchArea(e.target.value)}
                        placeholder="e.g. North Zone - Civil Hospital & Main Market"
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Employee Post / Designation
                      </label>
                      <input
                        type="text"
                        value={myDesignation}
                        readOnly
                        className="w-full px-3 py-2 text-sm border border-slate-200 bg-slate-50 text-slate-700 rounded-lg"
                      />
                    </div>
                  </div>

                  {/* Employee self-entered Daily Allowance (₹) + Travelling Allowance (₹) */}
                  <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-3.5 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-[#0F2744]">
                        Self-Entered Allowance &amp; Travel (₹)
                      </span>
                      <span className="text-xs font-mono font-bold text-[#15803D]">
                        Total:{' '}
                        {formatCurrency(
                          computeTotalFromBreakdown(
                            dailyAllowance,
                            travellingAllowance,
                            otherExpense
                          )
                        )}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Daily Allowance (DA ₹)
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={dailyAllowance}
                          onChange={(e) => setDailyAllowance(e.target.value)}
                          placeholder="e.g. 300"
                          className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Travelling Allowance (TA ₹)
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={travellingAllowance}
                          onChange={(e) => setTravellingAllowance(e.target.value)}
                          placeholder="e.g. 250"
                          className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Other / Hotel / Misc (₹)
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={otherExpense}
                          onChange={(e) => setOtherExpense(e.target.value)}
                          placeholder="0"
                          className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                        />
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Expense Date
                      </label>
                      <input
                        type="date"
                        value={expenseDate}
                        max={todayIsoDate()}
                        onChange={(e) => setExpenseDate(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Amount (₹)
                      </label>
                      <input
                        type="number"
                        min="1"
                        step="0.01"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="e.g. 450"
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                        required
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Expense Category
                    </label>
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      {EXPENSE_CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {(allowSelfAllowanceEntry || category === 'Travel / Fuel') && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2.5">
                  <div className="text-[11px] font-semibold text-slate-700">
                    Travel Route &amp; Distance (Optional)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input
                      type="text"
                      value={travelFrom}
                      onChange={(e) => setTravelFrom(e.target.value)}
                      placeholder="From (e.g. HQ)"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    />
                    <input
                      type="text"
                      value={travelTo}
                      onChange={(e) => setTravelTo(e.target.value)}
                      placeholder="To (e.g. Sector 18)"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={distanceKm}
                      onChange={(e) => setDistanceKm(e.target.value)}
                      placeholder="Distance (km)"
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg bg-white"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Working Details / Remarks
                </label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe calls covered, patch visited, or expense breakdown..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              {/* Camera Receipt Capture */}
              <div className="border border-slate-200 rounded-xl p-3.5 space-y-3 bg-slate-50/70">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-800">
                      Receipt Image Capture
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Snap a bill photo with the camera or attach from gallery.
                    </div>
                  </div>
                  {(previewUrl || existingReceiptUrl) && (
                    <span className="text-[11px] font-mono text-[#15803D] font-semibold">
                      {pendingBlob
                        ? `${Math.round(pendingBlob.size / 1024)} KB JPEG`
                        : 'Attached'}
                    </span>
                  )}
                </div>

                {cameraError && (
                  <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-[11px]">
                    {cameraError}
                  </div>
                )}

                {cameraActive && (
                  <div className="space-y-2">
                    <div className="relative rounded-xl overflow-hidden bg-slate-900 border border-slate-300">
                      <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full max-h-60 object-cover"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={captureFromVideo}
                        className="flex-1 py-2.5 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg inline-flex items-center justify-center gap-1.5 min-h-[44px]"
                      >
                        <Camera className="w-4 h-4" />
                        Capture Receipt
                      </button>
                      <button
                        type="button"
                        onClick={stopCamera}
                        className="px-4 py-2.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg min-h-[44px]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {!cameraActive && (previewUrl || existingReceiptUrl) && (
                  <div className="space-y-2">
                    <div className="rounded-xl overflow-hidden border border-slate-200 bg-white">
                      <img
                        src={previewUrl || existingReceiptUrl}
                        alt="Captured receipt preview"
                        className="w-full max-h-52 object-contain bg-slate-100"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={startLiveCamera}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#0F2744] bg-white border border-slate-300 rounded-lg"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Retake Photo
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          clearPreviewBlob();
                          setExistingReceiptUrl('');
                          setExistingReceiptPath('');
                        }}
                        className="text-xs text-red-600 hover:underline px-2 py-1"
                      >
                        Remove Image
                      </button>
                    </div>
                  </div>
                )}

                {!cameraActive && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={startLiveCamera}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-white bg-[#0F2744] hover:bg-slate-800 rounded-lg min-h-[44px]"
                    >
                      <Camera className="w-4 h-4" />
                      Open Camera
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg min-h-[44px]"
                    >
                      <Upload className="w-4 h-4" />
                      Take Photo / Upload
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={handleFileReceiptChange}
                      className="hidden"
                    />
                  </div>
                )}
              </div>

              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  disabled={saving}
                  onClick={closeFormModal}
                  className="px-4 py-2.5 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg min-h-[44px]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => handleSaveExpense('Draft')}
                  className="px-4 py-2.5 text-xs font-semibold text-[#0F2744] bg-slate-100 hover:bg-slate-200 rounded-lg min-h-[44px] disabled:opacity-60"
                >
                  {saving ? 'Saving...' : 'Save as Draft'}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => handleSaveExpense('Pending Approval')}
                  className="px-5 py-2.5 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg inline-flex items-center justify-center gap-1.5 min-h-[44px] disabled:opacity-60"
                >
                  <Send className="w-3.5 h-3.5" />
                  {saving ? 'Uploading & Submitting...' : 'Submit for Approval'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Receipt Lightbox & Admin Review Modal */}
      {inspectClaim && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full p-5 sm:p-6 shadow-xl my-auto max-h-[92vh] overflow-y-auto space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-slate-900">
                    {inspectClaim.category} · {formatCurrency(inspectClaim.amount)}
                  </h3>
                  <span
                    className={`px-2 py-0.5 text-[11px] font-semibold border rounded ${
                      STATUS_BADGE[inspectClaim.status]
                    }`}
                  >
                    {inspectClaim.status}
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {inspectClaim.employeeName} · Expense Date: {inspectClaim.expenseDate} ·
                  Logged {formatTimestamp(inspectClaim.createdAt)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setInspectClaim(null)}
                className="p-1.5 text-slate-500 hover:text-slate-800 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs space-y-1.5">
              {(inspectClaim.designation || inspectClaim.workingType || inspectClaim.patchArea) && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-[#0F2744]">
                  {inspectClaim.designation && <span>Post: {inspectClaim.designation}</span>}
                  {inspectClaim.workingType && <span>· {inspectClaim.workingType}</span>}
                  {inspectClaim.patchArea && (
                    <span className="text-[#15803D]">· Patch: {inspectClaim.patchArea}</span>
                  )}
                </div>
              )}
              {(typeof inspectClaim.dailyAllowance === 'number' ||
                typeof inspectClaim.travellingAllowance === 'number' ||
                typeof inspectClaim.otherExpense === 'number') && (
                <div className="flex flex-wrap gap-3 font-mono text-[11px] text-slate-800 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5">
                  <span>DA: {formatCurrency(inspectClaim.dailyAllowance || 0)}</span>
                  <span>TA: {formatCurrency(inspectClaim.travellingAllowance || 0)}</span>
                  {typeof inspectClaim.otherExpense === 'number' &&
                    inspectClaim.otherExpense > 0 && (
                      <span>Other: {formatCurrency(inspectClaim.otherExpense)}</span>
                    )}
                </div>
              )}
              {(inspectClaim.travelFrom || inspectClaim.travelTo) && (
                <div className="font-medium text-[#0F2744]">
                  Route: {inspectClaim.travelFrom || 'Start'} &rarr;{' '}
                  {inspectClaim.travelTo || 'End'}
                  {typeof inspectClaim.distanceKm === 'number' &&
                  inspectClaim.distanceKm > 0
                    ? ` (${inspectClaim.distanceKm} km)`
                    : ''}
                </div>
              )}
              <div className="text-slate-800">{inspectClaim.description}</div>
              {inspectClaim.reviewedByName && (
                <div className="text-[11px] text-slate-500 pt-1">
                  Last reviewed by {inspectClaim.reviewedByName}
                  {inspectClaim.reviewRemarks
                    ? ` — "${inspectClaim.reviewRemarks}"`
                    : ''}
                </div>
              )}
            </div>

            {inspectClaim.receiptUrl ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-700">Attached Receipt</span>
                  <a
                    href={inspectClaim.receiptUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[#0F2744] font-medium hover:underline"
                  >
                    Open Full Size <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-900/5 overflow-hidden">
                  <img
                    src={inspectClaim.receiptUrl}
                    alt={`Receipt for ${inspectClaim.employeeName}`}
                    className="w-full max-h-[380px] object-contain mx-auto"
                  />
                </div>
              </div>
            ) : (
              <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-300 rounded-xl">
                No receipt photo attached to this claim.
              </div>
            )}

            {isSuperAdmin && inspectClaim.status !== 'Draft' ? (
              <div className="border-t border-slate-200 pt-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Super Admin Review Remarks
                    </label>
                    <input
                      type="text"
                      value={reviewRemarks}
                      onChange={(e) => setReviewRemarks(e.target.value)}
                      placeholder="Approval note or rejection reason..."
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Payment / Payout Reference (for Reimbursement)
                    </label>
                    <input
                      type="text"
                      value={reimburseRef}
                      onChange={(e) => setReimburseRef(e.target.value)}
                      placeholder="UTR / UPI / NEFT / Cash Voucher #"
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  {inspectClaim.status !== 'Rejected' && (
                    <button
                      type="button"
                      disabled={reviewBusy}
                      onClick={() => handleAdminStatusUpdate(inspectClaim, 'Rejected')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg min-h-[40px] disabled:opacity-60"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Reject
                    </button>
                  )}
                  {inspectClaim.status === 'Pending Approval' && (
                    <button
                      type="button"
                      disabled={reviewBusy}
                      onClick={() => handleAdminStatusUpdate(inspectClaim, 'Approved')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[40px] disabled:opacity-60"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Approve Claim
                    </button>
                  )}
                  {(inspectClaim.status === 'Approved' ||
                    inspectClaim.status === 'Pending Approval') && (
                    <button
                      type="button"
                      disabled={reviewBusy}
                      onClick={() => handleAdminStatusUpdate(inspectClaim, 'Reimbursed')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-slate-800 rounded-lg min-h-[40px] disabled:opacity-60"
                    >
                      <Banknote className="w-3.5 h-3.5" />
                      Mark Paid / Reimbursed
                    </button>
                  )}
                </div>
              </div>
            ) : (
              inspectClaim.status !== 'Draft' && (
                <div className="border-t border-slate-200 pt-3 text-[11px] text-slate-500">
                  Expense approval and payment settlement is restricted to Super Admin.
                </div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
};
