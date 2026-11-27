import React, { useMemo, useState } from 'react';
import {
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  Check,
  CheckCircle2,
  ClipboardList,
  Download,
  ExternalLink,
  ListPlus,
  Loader2,
  MapPin,
  MessageSquare,
  Navigation,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Stethoscope,
  Trash2,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { logActivity } from '../lib/erpActions';
import {
  buildGoogleMapsUrl,
  captureCurrentGps,
  CapturedGpsPoint,
  formatCallLocationSummary,
  reverseGeocodeCoords,
} from '../lib/callLocation';
import {
  calculateHaversineMeters,
  exportToCsv,
  generateId,
  todayIsoDate,
} from '../lib/utils';
import {
  CompanySettings,
  Doctor,
  DoctorCallOutcome,
  DoctorCallRecord,
  Employee,
  Product,
  UserAccount,
} from '../types/erp';

interface DoctorsModuleProps {
  currentUser: UserAccount;
  isAdminView: boolean;
  doctors: Doctor[];
  doctorCalls: DoctorCallRecord[];
  products: Product[];
  employees: Employee[];
  settings?: CompanySettings | null;
}

interface BulkDoctorRow {
  name: string;
  specialty: string;
  clinicName: string;
  city: string;
  phone: string;
  tier: 'Core A+' | 'Class A' | 'Class B';
}

const SPECIALTIES = [
  'General Physician',
  'Pediatrician',
  'Orthopedic',
  'Gynecologist',
  'ENT Specialist',
  'Cardiologist',
  'Dermatologist',
  'Gastroenterologist',
  'Dentist',
  'Consultant Surgeon',
];

const OUTCOMES: DoctorCallOutcome[] = [
  'Prescribing',
  'Interested',
  'Follow-up Required',
  'Sample Requested',
  'Not Available',
  'Declined',
];

function emptyBulkRow(): BulkDoctorRow {
  return {
    name: '',
    specialty: 'General Physician',
    clinicName: '',
    city: '',
    phone: '',
    tier: 'Class A',
  };
}

export const DoctorsModule: React.FC<DoctorsModuleProps> = ({
  currentUser,
  isAdminView,
  doctors,
  doctorCalls,
  products,
  employees,
  settings,
}) => {
  const today = todayIsoDate();

  const [subTab, setSubTab] = useState<'directory' | 'calls'>('directory');
  const [search, setSearch] = useState('');
  const [visitFilter, setVisitFilter] = useState<'ALL' | 'PENDING_TODAY' | 'VISITED_TODAY'>('ALL');
  const [specialtyFilter, setSpecialtyFilter] = useState('ALL');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  // Single Doctor Modal
  const [showSingleModal, setShowSingleModal] = useState(false);
  const [dName, setDName] = useState('');
  const [dSpecialty, setDSpecialty] = useState('General Physician');
  const [dQual, setDQual] = useState('');
  const [dClinic, setDClinic] = useState('');
  const [dPhone, setDPhone] = useState('');
  const [dCity, setDCity] = useState('');
  const [dBeat, setDBeat] = useState('');
  const [dAddress, setDAddress] = useState('');
  const [dTier, setDTier] = useState<'Core A+' | 'Class A' | 'Class B'>('Class A');
  const [dEmpUid, setDEmpUid] = useState(currentUser.uid);

  // Bulk Add Doctors Modal ("Ek baar me saare Dr add karna")
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkMode, setBulkMode] = useState<'grid' | 'paste'>('grid');
  const [bulkEmpUid, setBulkEmpUid] = useState(currentUser.uid);
  const [bulkRows, setBulkRows] = useState<BulkDoctorRow[]>(() =>
    Array.from({ length: 6 }, emptyBulkRow)
  );
  const [pasteText, setPasteText] = useState('');

  // Doctor Call & Product Detailing Modal
  const [callDoctor, setCallDoctor] = useState<Doctor | null>(null);
  const [callDate, setCallDate] = useState(today);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [customProduct, setCustomProduct] = useState('');
  const [samplesGiven, setSamplesGiven] = useState('');
  const [callOutcome, setCallOutcome] = useState<DoctorCallOutcome>('Interested');
  const [doctorRemark, setDoctorRemark] = useState('');
  const [nextFollowUpDate, setNextFollowUpDate] = useState('');
  const [callGps, setCallGps] = useState<CapturedGpsPoint | null>(null);
  const [callLocationName, setCallLocationName] = useState('');
  const [gpsCapturing, setGpsCapturing] = useState(false);
  const [gpsStatus, setGpsStatus] = useState('');

  // Pin / Update Location on an existing call missing GPS
  const [pinCall, setPinCall] = useState<DoctorCallRecord | null>(null);
  const [pinGps, setPinGps] = useState<CapturedGpsPoint | null>(null);
  const [pinLocName, setPinLocName] = useState('');
  const [pinCapturing, setPinCapturing] = useState(false);
  const [pinStatus, setPinStatus] = useState('');
  const [savingPin, setSavingPin] = useState(false);

  // Selected doctor history modal
  const [historyDoctor, setHistoryDoctor] = useState<Doctor | null>(null);

  const visitedTodaySet = useMemo(() => {
    const s = new Set<string>();
    doctorCalls.forEach((c) => {
      if (c.callDate === today) s.add(c.doctorId);
    });
    return s;
  }, [doctorCalls, today]);

  const filteredDoctors = useMemo(() => {
    const q = search.trim().toLowerCase();
    return doctors.filter((d) => {
      if (specialtyFilter !== 'ALL' && d.specialty !== specialtyFilter) return false;
      if (visitFilter === 'PENDING_TODAY' && visitedTodaySet.has(d.id)) return false;
      if (visitFilter === 'VISITED_TODAY' && !visitedTodaySet.has(d.id)) return false;
      if (!q) return true;
      return (
        d.name.toLowerCase().includes(q) ||
        d.clinicName.toLowerCase().includes(q) ||
        d.city.toLowerCase().includes(q) ||
        (d.areaBeat || '').toLowerCase().includes(q) ||
        (d.lastDoctorRemark || '').toLowerCase().includes(q)
      );
    });
  }, [doctors, search, specialtyFilter, visitFilter, visitedTodaySet]);

  const filteredCalls = useMemo(() => {
    const q = search.trim().toLowerCase();
    return doctorCalls.filter((c) => {
      if (!q) return true;
      return (
        c.doctorName.toLowerCase().includes(q) ||
        c.employeeName.toLowerCase().includes(q) ||
        (c.clinicName || '').toLowerCase().includes(q) ||
        (c.locationName || '').toLowerCase().includes(q) ||
        (c.areaBeat || '').toLowerCase().includes(q) ||
        c.doctorRemark.toLowerCase().includes(q) ||
        c.productsShown.join(' ').toLowerCase().includes(q)
      );
    });
  }, [doctorCalls, search]);

  const resolveAssignee = (targetUid: string) => {
    if (!isAdminView) {
      return { uid: currentUser.uid, name: currentUser.displayName };
    }
    const found = employees.find((e) => (e.uid || e.id) === targetUid);
    if (found) {
      return { uid: found.uid || found.id, name: found.fullName };
    }
    return { uid: currentUser.uid, name: currentUser.displayName };
  };

  const handleSaveSingleDoctor = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    if (!dName.trim() || !dClinic.trim() || !dCity.trim()) {
      setErr('Doctor name, clinic/hospital name, and city are required.');
      return;
    }
    setSaving(true);
    const id = generateId('doc');
    const assignee = resolveAssignee(dEmpUid);
    try {
      await setDoc(doc(db, 'doctors', id), {
        id,
        name: dName.trim().slice(0, 120),
        specialty: dSpecialty.trim().slice(0, 80),
        ...(dQual.trim() ? { qualification: dQual.trim().slice(0, 60) } : {}),
        clinicName: dClinic.trim().slice(0, 160),
        ...(dPhone.trim() ? { phone: dPhone.trim().slice(0, 32) } : {}),
        city: dCity.trim().slice(0, 100),
        ...(dBeat.trim() ? { areaBeat: dBeat.trim().slice(0, 120) } : {}),
        ...(dAddress.trim() ? { address: dAddress.trim().slice(0, 250) } : {}),
        tier: dTier,
        assignedEmployeeUid: assignee.uid,
        assignedEmployeeName: assignee.name.slice(0, 120),
        totalCalls: 0,
        isDemo: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: 'Doctor Added',
        entityType: 'doctors',
        entityId: id,
        details: `Added ${dName.trim()} (${dSpecialty}) · ${dClinic.trim()}`,
      });
      setShowSingleModal(false);
      setDName('');
      setDQual('');
      setDClinic('');
      setDPhone('');
      setDCity('');
      setDBeat('');
      setDAddress('');
      setMsg(`${dName.trim()} added to Doctor Directory.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `doctors/${id}`);
    } finally {
      setSaving(false);
    }
  };

  const handleBulkSaveDoctors = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');

    let parsedRows: BulkDoctorRow[] = [];
    if (bulkMode === 'grid') {
      parsedRows = bulkRows.filter(
        (r) => r.name.trim().length >= 2 && (r.clinicName.trim() || r.city.trim())
      );
    } else {
      const lines = pasteText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      parsedRows = lines.map((line) => {
        const parts = line.split(/[|,;\t]/).map((p) => p.trim());
        return {
          name: parts[0] || '',
          specialty: parts[1] || 'General Physician',
          clinicName: parts[2] || 'Clinic / OPD',
          city: parts[3] || 'HQ',
          phone: parts[4] || '',
          tier: 'Class A' as const,
        };
      }).filter((r) => r.name.length >= 2);
    }

    if (parsedRows.length === 0) {
      setErr('Enter at least one doctor (Doctor Name + Clinic/City) before saving.');
      return;
    }

    setSaving(true);
    const assignee = resolveAssignee(bulkEmpUid);
    try {
      // Firestore batch supports up to 500 ops; chunk safely at 400
      for (let i = 0; i < parsedRows.length; i += 400) {
        const chunk = parsedRows.slice(i, i + 400);
        const batch = writeBatch(db);
        chunk.forEach((row, idx) => {
          const docId = `${generateId('doc')}_${i + idx}`;
          batch.set(doc(db, 'doctors', docId), {
            id: docId,
            name: row.name.trim().slice(0, 120),
            specialty: (row.specialty.trim() || 'General Physician').slice(0, 80),
            clinicName: (row.clinicName.trim() || 'Private Clinic').slice(0, 160),
            city: (row.city.trim() || 'Assigned Area').slice(0, 100),
            ...(row.phone.trim() ? { phone: row.phone.trim().slice(0, 32) } : {}),
            tier: row.tier,
            assignedEmployeeUid: assignee.uid,
            assignedEmployeeName: assignee.name.slice(0, 120),
            totalCalls: 0,
            isDemo: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        });
        await batch.commit();
      }

      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: 'Bulk Doctors Added',
        entityType: 'doctors',
        details: `Added ${parsedRows.length} doctors in one batch for ${assignee.name}`,
      });

      setShowBulkModal(false);
      setBulkRows(Array.from({ length: 6 }, emptyBulkRow));
      setPasteText('');
      setMsg(`${parsedRows.length} doctor(s) added together in one batch!`);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'doctors');
    } finally {
      setSaving(false);
    }
  };

  const myEmployee = useMemo(
    () =>
      employees.find(
        (e) =>
          e.uid === currentUser.uid ||
          e.email.toLowerCase() === currentUser.email.toLowerCase()
      ),
    [employees, currentUser.uid, currentUser.email]
  );

  const runCallGpsCapture = async (fallbackPlace = '') => {
    setGpsCapturing(true);
    setGpsStatus('Capturing employee GPS location...');
    try {
      const point = await captureCurrentGps(10000);
      setCallGps(point);
      setGpsStatus(
        `GPS ready: ${point.lat.toFixed(4)}, ${point.lng.toFixed(4)} (±${point.accuracy}m)`
      );
      const place = await reverseGeocodeCoords(point.lat, point.lng);
      if (place) {
        setCallLocationName((prev) =>
          !prev.trim() || prev.trim() === fallbackPlace ? place : prev
        );
        setGpsStatus(
          `GPS ready: ${place} (${point.lat.toFixed(4)}, ${point.lng.toFixed(4)} ±${point.accuracy}m)`
        );
      }
      return point;
    } catch (geoErr: any) {
      setGpsStatus(geoErr?.message || 'Unable to acquire GPS.');
      return null;
    } finally {
      setGpsCapturing(false);
    }
  };

  const openCallModal = (docItem: Doctor) => {
    const fallbackPlace = [docItem.areaBeat, docItem.city].filter(Boolean).join(', ');
    setCallDoctor(docItem);
    setCallDate(today);
    setSelectedProducts([]);
    setCustomProduct('');
    setSamplesGiven('');
    setCallOutcome('Interested');
    setDoctorRemark('');
    setNextFollowUpDate('');
    setCallGps(null);
    setCallLocationName(fallbackPlace);
    setGpsStatus('');
    setErr('');
    void runCallGpsCapture(fallbackPlace);
  };

  const toggleProductShown = (name: string) => {
    setSelectedProducts((prev) =>
      prev.includes(name) ? prev.filter((p) => p !== name) : [...prev, name]
    );
  };

  const addCustomProductToCall = () => {
    const clean = customProduct.trim();
    if (!clean) return;
    if (!selectedProducts.includes(clean)) {
      setSelectedProducts((prev) => [...prev, clean]);
    }
    setCustomProduct('');
  };

  const captureCallGps = () => {
    const fallbackPlace = callDoctor
      ? [callDoctor.areaBeat, callDoctor.city].filter(Boolean).join(', ')
      : '';
    void runCallGpsCapture(fallbackPlace);
  };

  const handleSaveDoctorCall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!callDoctor) return;
    setErr('');
    setMsg('');

    const finalProducts = [...selectedProducts];
    if (customProduct.trim() && !finalProducts.includes(customProduct.trim())) {
      finalProducts.push(customProduct.trim());
    }

    if (finalProducts.length === 0) {
      setErr('Select or enter at least one Glacetor product shown to the doctor.');
      return;
    }
    if (!doctorRemark.trim()) {
      setErr('Please enter remarks describing what the doctor said.');
      return;
    }

    setSaving(true);
    const callId = generateId('dcall');
    const cleanProducts = finalProducts.slice(0, 20).map((p) => p.slice(0, 120));
    const cleanRemark = doctorRemark.trim().slice(0, 600);
    const summaryProducts = cleanProducts.join(', ').slice(0, 300);

    // Ensure GPS is captured on submit if not already captured
    let finalGps = callGps;
    let finalLocationName = callLocationName.trim();
    if (!finalGps) {
      try {
        finalGps = await captureCurrentGps(5000);
        if (finalGps && !finalLocationName) {
          finalLocationName = await reverseGeocodeCoords(finalGps.lat, finalGps.lng);
        }
      } catch {
        // Proceed with manual/clinic place if GPS unavailable
      }
    } else if (!finalLocationName) {
      finalLocationName = await reverseGeocodeCoords(finalGps.lat, finalGps.lng);
    }

    if (!finalLocationName) {
      finalLocationName = [callDoctor.areaBeat, callDoctor.city]
        .filter(Boolean)
        .join(', ');
    }
    const cleanLocationName = finalLocationName.slice(0, 200);

    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'doctorCalls', callId), {
        id: callId,
        doctorId: callDoctor.id,
        doctorName: callDoctor.name.slice(0, 120),
        clinicName: callDoctor.clinicName.slice(0, 160),
        specialty: callDoctor.specialty.slice(0, 80),
        ...(callDoctor.areaBeat ? { areaBeat: callDoctor.areaBeat.slice(0, 120) } : {}),
        employeeUid: currentUser.uid,
        employeeName: currentUser.displayName.slice(0, 120),
        callDate,
        productsShown: cleanProducts,
        ...(samplesGiven.trim() ? { samplesGiven: samplesGiven.trim().slice(0, 240) } : {}),
        callOutcome,
        doctorRemark: cleanRemark,
        ...(nextFollowUpDate ? { nextFollowUpDate } : {}),
        ...(finalGps
          ? {
              lat: finalGps.lat,
              lng: finalGps.lng,
              accuracy: finalGps.accuracy,
            }
          : {}),
        ...(cleanLocationName ? { locationName: cleanLocationName } : {}),
        isDemo: false,
        createdAt: serverTimestamp(),
      });

      batch.update(doc(db, 'doctors', callDoctor.id), {
        totalCalls: (callDoctor.totalCalls || 0) + 1,
        lastVisitedDate: callDate,
        lastCallOutcome: callOutcome,
        lastDoctorRemark: cleanRemark,
        lastProductsShown: summaryProducts,
        ...(finalGps
          ? { lastCallLat: finalGps.lat, lastCallLng: finalGps.lng }
          : {}),
        ...(cleanLocationName ? { lastCallLocation: cleanLocationName } : {}),
        updatedAt: serverTimestamp(),
      });

      // Also record an employee GPS visit ping so Live Field Force Map displays the call spot
      if (finalGps) {
        const locId = generateId('loc');
        const geofenceLat = myEmployee?.geofenceLat ?? settings?.officeLat ?? 19.076;
        const geofenceLng = myEmployee?.geofenceLng ?? settings?.officeLng ?? 72.8777;
        const geofenceRadius =
          myEmployee?.geofenceRadiusM ?? settings?.officeRadiusM ?? 500;
        const dist = calculateHaversineMeters(
          finalGps.lat,
          finalGps.lng,
          geofenceLat,
          geofenceLng
        );
        batch.set(doc(db, 'locations', locId), {
          id: locId,
          userId: currentUser.uid,
          employeeName: currentUser.displayName.slice(0, 120),
          territory: (
            cleanLocationName ||
            currentUser.territory ||
            myEmployee?.territory ||
            callDoctor.city
          ).slice(0, 120),
          lat: finalGps.lat,
          lng: finalGps.lng,
          accuracy: finalGps.accuracy,
          trackingActive: false,
          status: 'Customer Visit',
          customerId: callDoctor.id,
          customerName: `${callDoctor.name} (${callDoctor.clinicName})`.slice(0, 140),
          withinGeofence: dist <= geofenceRadius,
          note: `Doctor Call at ${cleanLocationName || callDoctor.clinicName}`.slice(0, 240),
          recordedAt: serverTimestamp(),
        });
      }

      await batch.commit();

      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: 'Doctor Call',
        entityType: 'doctorCalls',
        entityId: callId,
        details: `Met ${callDoctor.name}${
          cleanLocationName ? ` @ ${cleanLocationName}` : ''
        } · Shown: ${summaryProducts} · Remark: ${cleanRemark.slice(0, 100)}`,
        lat: finalGps?.lat,
        lng: finalGps?.lng,
      });

      setCallDoctor(null);
      setMsg(
        `Call & location saved for ${callDoctor.name}${
          cleanLocationName ? ` (${cleanLocationName})` : ''
        }.`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `doctorCalls/${callId}`);
    } finally {
      setSaving(false);
    }
  };

  const runPinGpsCapture = async (fallback = '') => {
    setPinCapturing(true);
    setPinStatus('Requesting current GPS coordinates...');
    try {
      const pt = await captureCurrentGps(10000);
      setPinGps(pt);
      const place = await reverseGeocodeCoords(pt.lat, pt.lng);
      if (place) {
        setPinLocName((prev) => (!prev.trim() || prev.trim() === fallback ? place : prev));
        setPinStatus(
          `Captured ${place} (${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)} ±${pt.accuracy}m)`
        );
      } else {
        setPinStatus(
          `Captured GPS (${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)} ±${pt.accuracy}m)`
        );
      }
    } catch (geoErr: any) {
      setPinStatus(geoErr?.message || 'Unable to acquire GPS.');
    } finally {
      setPinCapturing(false);
    }
  };

  const openPinCallModal = (call: DoctorCallRecord) => {
    const fallback = (call.locationName || [call.areaBeat, call.clinicName].filter(Boolean).join(', ')).trim();
    setPinCall(call);
    setPinGps(
      typeof call.lat === 'number' && typeof call.lng === 'number'
        ? { lat: call.lat, lng: call.lng, accuracy: call.accuracy || 0 }
        : null
    );
    setPinLocName(fallback);
    setPinStatus('');
    setErr('');
    if (
      (typeof call.lat !== 'number' || typeof call.lng !== 'number') &&
      call.employeeUid === currentUser.uid
    ) {
      void runPinGpsCapture(fallback);
    }
  };

  const handleSavePinnedCallLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pinCall) return;
    const cleanName = pinLocName.trim().slice(0, 200);
    if (!pinGps && !cleanName) {
      setPinStatus('Capture GPS coordinates or enter a call place/area name.');
      return;
    }

    setSavingPin(true);
    try {
      const batch = writeBatch(db);
      const callUpdates: Record<string, any> = {};
      if (cleanName) callUpdates.locationName = cleanName;
      if (pinGps) {
        callUpdates.lat = pinGps.lat;
        callUpdates.lng = pinGps.lng;
        callUpdates.accuracy = pinGps.accuracy;
      }
      batch.update(doc(db, 'doctorCalls', pinCall.id), callUpdates);

      const parentDoc = doctors.find((d) => d.id === pinCall.doctorId);
      if (parentDoc && (!parentDoc.lastVisitedDate || parentDoc.lastVisitedDate <= pinCall.callDate)) {
        const docUpdates: Record<string, any> = { updatedAt: serverTimestamp() };
        if (cleanName) docUpdates.lastCallLocation = cleanName;
        if (pinGps) {
          docUpdates.lastCallLat = pinGps.lat;
          docUpdates.lastCallLng = pinGps.lng;
        }
        batch.update(doc(db, 'doctors', parentDoc.id), docUpdates);
      }

      const canCreatePingForOwner =
        pinCall.employeeUid === currentUser.uid ||
        ['Super Admin', 'Admin'].includes(currentUser.role);
      if (pinGps && canCreatePingForOwner) {
        const locId = generateId('loc');
        const geofenceLat = myEmployee?.geofenceLat ?? settings?.officeLat ?? 19.076;
        const geofenceLng = myEmployee?.geofenceLng ?? settings?.officeLng ?? 72.8777;
        const geofenceRadius =
          myEmployee?.geofenceRadiusM ?? settings?.officeRadiusM ?? 500;
        const dist = calculateHaversineMeters(
          pinGps.lat,
          pinGps.lng,
          geofenceLat,
          geofenceLng
        );
        batch.set(doc(db, 'locations', locId), {
          id: locId,
          userId: pinCall.employeeUid,
          employeeName: pinCall.employeeName.slice(0, 120),
          territory: (cleanName || pinCall.areaBeat || pinCall.clinicName || 'Field Zone').slice(0, 120),
          lat: pinGps.lat,
          lng: pinGps.lng,
          accuracy: pinGps.accuracy,
          trackingActive: false,
          status: 'Customer Visit',
          customerId: pinCall.doctorId,
          customerName: `${pinCall.doctorName}${
            pinCall.clinicName ? ` (${pinCall.clinicName})` : ''
          }`.slice(0, 140),
          withinGeofence: dist <= geofenceRadius,
          note: `Doctor Call: ${cleanName || pinCall.doctorName}`.slice(0, 240),
          recordedAt: serverTimestamp(),
        });
      }

      await batch.commit();

      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: 'Call Location Tagged',
        entityType: 'doctorCalls',
        entityId: pinCall.id,
        details: `Tagged location for ${pinCall.doctorName} (${pinCall.employeeName}): ${
          cleanName || 'GPS Coordinates'
        }`,
        lat: pinGps?.lat,
        lng: pinGps?.lng,
      });

      setMsg(`Location updated for ${pinCall.doctorName}'s call.`);
      setPinCall(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `doctorCalls/${pinCall.id}`);
    } finally {
      setSavingPin(false);
    }
  };

  const handleDeleteDoctor = async (docItem: Doctor) => {
    if (!isAdminView) return;
    try {
      await deleteDoc(doc(db, 'doctors', docItem.id));
      setMsg(`Removed ${docItem.name} from directory.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `doctors/${docItem.id}`);
    }
  };

  const handleExportCallsCsv = () => {
    exportToCsv(
      `glacetor-doctor-calls-${today}.csv`,
      [
        'Call Date',
        'Doctor Name',
        'Specialty',
        'Clinic / Hospital',
        'Area / Beat',
        'Representative',
        'Call Location',
        'Latitude',
        'Longitude',
        'Products Shown',
        'Samples Given',
        'Outcome',
        'Doctor Remarks',
        'Next Follow-Up',
      ],
      filteredCalls.map((c) => {
        const loc = formatCallLocationSummary(c);
        return [
          c.callDate,
          c.doctorName,
          c.specialty || '',
          c.clinicName || '',
          c.areaBeat || '',
          c.employeeName,
          loc.label,
          typeof c.lat === 'number' ? c.lat.toFixed(6) : '',
          typeof c.lng === 'number' ? c.lng.toFixed(6) : '',
          c.productsShown.join('; '),
          c.samplesGiven || '',
          c.callOutcome,
          c.doctorRemark,
          c.nextFollowUpDate || '',
        ];
      })
    );
  };

  const outcomeBadge = (outcome?: DoctorCallOutcome) => {
    switch (outcome) {
      case 'Prescribing':
        return 'bg-emerald-100 text-emerald-800';
      case 'Interested':
        return 'bg-blue-100 text-[#0F2744]';
      case 'Sample Requested':
        return 'bg-indigo-100 text-indigo-800';
      case 'Follow-up Required':
        return 'bg-amber-100 text-amber-800';
      case 'Not Available':
        return 'bg-slate-100 text-slate-700';
      case 'Declined':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-slate-100 text-slate-600';
    }
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-[#0F2744] flex items-center gap-2">
            <Stethoscope className="w-5 h-5 text-[#15803D]" />
            Doctors &amp; Product Detailing Calls
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Add all doctors in one go, show Glacetor products on clinic visits, and log exact doctor feedback remarks.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setErr('');
              setShowBulkModal(true);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[42px]"
          >
            <ListPlus className="w-4 h-4" />
            Bulk Add Doctors (All at Once)
          </button>

          <button
            type="button"
            onClick={() => {
              setErr('');
              setShowSingleModal(true);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg min-h-[42px]"
          >
            <Plus className="w-4 h-4" />
            Add Single Doctor
          </button>

          {subTab === 'calls' && (
            <button
              type="button"
              onClick={handleExportCallsCsv}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg min-h-[42px]"
            >
              <Download className="w-3.5 h-3.5" />
              Export Calls CSV
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs flex items-center justify-between gap-2">
          <span>{msg}</span>
          <button type="button" onClick={() => setMsg('')}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Total Doctors</div>
          <div className="text-xl font-bold font-mono tabular-nums text-[#0F2744] mt-1">
            {doctors.length}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Visited Today</div>
          <div className="text-xl font-bold font-mono tabular-nums text-[#15803D] mt-1">
            {visitedTodaySet.size}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Pending Visit Today</div>
          <div className="text-xl font-bold font-mono tabular-nums text-amber-700 mt-1">
            {Math.max(0, doctors.length - visitedTodaySet.size)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Total Call Remarks Logged</div>
          <div className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-1">
            {doctorCalls.length}
          </div>
        </div>
      </div>

      {/* Sub-navigation + Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSubTab('directory')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg min-h-[38px] ${
              subTab === 'directory'
                ? 'bg-[#0F2744] text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <Stethoscope className="w-3.5 h-3.5" />
            Doctors Call Queue ({doctors.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('calls')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg min-h-[38px] ${
              subTab === 'calls'
                ? 'bg-[#0F2744] text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <ClipboardList className="w-3.5 h-3.5" />
            Call Remarks History ({doctorCalls.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 flex-1 md:justify-end">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search doctor, clinic, city, or remark..."
              className="w-full pl-9 pr-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>

          {subTab === 'directory' && (
            <>
              <select
                value={visitFilter}
                onChange={(e) => setVisitFilter(e.target.value as any)}
                className="px-2.5 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">All Doctors</option>
                <option value="PENDING_TODAY">Pending Visit Today</option>
                <option value="VISITED_TODAY">Visited Today</option>
              </select>

              <select
                value={specialtyFilter}
                onChange={(e) => setSpecialtyFilter(e.target.value)}
                className="px-2.5 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">All Specialties</option>
                {SPECIALTIES.map((sp) => (
                  <option key={sp} value={sp}>
                    {sp}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      </div>

      {/* SUBTAB 1: DOCTORS DIRECTORY & 1-TAP PRODUCT DETAILING CALL */}
      {subTab === 'directory' && (
        <div className="space-y-3">
          {filteredDoctors.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
              <Stethoscope className="w-10 h-10 text-slate-300 mx-auto" />
              <div className="text-sm font-semibold text-slate-800">
                No doctors added yet
              </div>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                Click <strong>&ldquo;Bulk Add Doctors (All at Once)&rdquo;</strong> to add your entire doctor list in one go, then visit each doctor to show products and save their remarks.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredDoctors.map((docItem) => {
                const visitedToday = visitedTodaySet.has(docItem.id);
                return (
                  <div
                    key={docItem.id}
                    className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-3"
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-sm font-bold text-[#0F2744]">
                              {docItem.name}
                            </h3>
                            {docItem.tier && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                                {docItem.tier}
                              </span>
                            )}
                            {visitedToday && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 inline-flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> Visited Today
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-600 mt-0.5">
                            {docItem.specialty}
                            {docItem.qualification ? ` · ${docItem.qualification}` : ''} ·{' '}
                            <span className="font-medium text-slate-800">{docItem.clinicName}</span>
                          </div>
                        </div>

                        {isAdminView && (
                          <button
                            type="button"
                            onClick={() => handleDeleteDoctor(docItem)}
                            className="p-1.5 text-slate-400 hover:text-red-600"
                            title="Delete doctor"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="w-3.5 h-3.5" />
                          {docItem.city}
                          {docItem.areaBeat ? ` (${docItem.areaBeat})` : ''}
                        </span>
                        {docItem.phone && (
                          <span className="inline-flex items-center gap-1 font-mono">
                            <Phone className="w-3.5 h-3.5" />
                            {docItem.phone}
                          </span>
                        )}
                        <span>Rep: {docItem.assignedEmployeeName}</span>
                      </div>

                      {docItem.lastDoctorRemark ? (
                        <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-slate-700">
                              Last Call ({docItem.lastVisitedDate || '—'})
                            </span>
                            <span
                              className={`text-[10px] font-semibold px-2 py-0.5 rounded ${outcomeBadge(
                                docItem.lastCallOutcome
                              )}`}
                            >
                              {docItem.lastCallOutcome}
                            </span>
                          </div>
                          {docItem.lastProductsShown && (
                            <div className="text-[11px] text-[#0F2744] font-medium">
                              Products shown: {docItem.lastProductsShown}
                            </div>
                          )}
                          <div className="text-slate-700 italic">
                            &ldquo;{docItem.lastDoctorRemark}&rdquo;
                          </div>
                          <div className="pt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500 border-t border-slate-200/70">
                            <span className="inline-flex items-center gap-1 min-w-0 truncate">
                              <MapPin className="w-3 h-3 text-[#15803D] shrink-0" />
                              <span className="truncate">
                                {docItem.lastCallLocation ||
                                  [docItem.areaBeat, docItem.city].filter(Boolean).join(', ')}
                              </span>
                            </span>
                            {typeof docItem.lastCallLat === 'number' &&
                            typeof docItem.lastCallLng === 'number' ? (
                              <a
                                href={buildGoogleMapsUrl(
                                  docItem.lastCallLat,
                                  docItem.lastCallLng
                                )}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[#0F2744] font-semibold hover:underline shrink-0"
                              >
                                Map <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : (
                              <span className="text-amber-700 shrink-0">GPS not tagged</span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="p-2 rounded-lg bg-amber-50/70 border border-amber-200/70 text-[11px] text-amber-900">
                          No product call recorded yet — tap below after showing products to log doctor&apos;s feedback.
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={() => setHistoryDoctor(docItem)}
                        className="text-xs font-medium text-slate-600 hover:text-[#0F2744]"
                      >
                        History ({docItem.totalCalls || 0} calls)
                      </button>
                      <button
                        type="button"
                        onClick={() => openCallModal(docItem)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[38px]"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                        Call &amp; Enter Remarks
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* SUBTAB 2: CALL REMARKS HISTORY TABLE */}
      {subTab === 'calls' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {filteredCalls.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              No doctor detailing calls or remarks logged yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Date</th>
                    <th className="px-4 py-3 font-semibold">Doctor &amp; Clinic</th>
                    <th className="px-4 py-3 font-semibold">Call Location (Place &amp; GPS)</th>
                    <th className="px-4 py-3 font-semibold">Products Shown</th>
                    <th className="px-4 py-3 font-semibold">Outcome</th>
                    <th className="px-4 py-3 font-semibold min-w-[220px]">Doctor&apos;s Remarks (Dr ne kya bola)</th>
                    <th className="px-4 py-3 font-semibold">Rep / Follow-up</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredCalls.map((c) => {
                    const locSummary = formatCallLocationSummary(c);
                    const canPinLocation =
                      isAdminView || c.employeeUid === currentUser.uid;
                    return (
                      <tr key={c.id} className="hover:bg-slate-50/70 align-top">
                        <td className="px-4 py-3 font-mono whitespace-nowrap">{c.callDate}</td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-[#0F2744]">{c.doctorName}</div>
                          <div className="text-slate-500">
                            {c.specialty} · {c.clinicName}
                          </div>
                        </td>
                        <td className="px-4 py-3 min-w-[190px]">
                          <div className="flex items-start gap-1.5 text-slate-800 font-medium">
                            <MapPin
                              className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                                locSummary.hasGps ? 'text-[#15803D]' : 'text-amber-600'
                              }`}
                            />
                            <span>{locSummary.label}</span>
                          </div>
                          {locSummary.hasGps ? (
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                              <span className="font-mono text-slate-500 tabular-nums">
                                {locSummary.coordsText}
                              </span>
                              {locSummary.mapsUrl && (
                                <a
                                  href={locSummary.mapsUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-0.5 text-[#0F2744] font-semibold hover:underline"
                                >
                                  View Map <ExternalLink className="w-3 h-3" />
                                </a>
                              )}
                            </div>
                          ) : (
                            <div className="mt-1 flex items-center gap-2">
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-medium">
                                GPS Not Tagged
                              </span>
                              {canPinLocation && (
                                <button
                                  type="button"
                                  onClick={() => openPinCallModal(c)}
                                  className="text-[11px] font-semibold text-[#0F2744] hover:underline inline-flex items-center gap-1"
                                >
                                  <Navigation className="w-3 h-3" />
                                  Set Location
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {c.productsShown.map((p) => (
                              <span
                                key={p}
                                className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-800 text-[11px]"
                              >
                                {p}
                              </span>
                            ))}
                          </div>
                          {c.samplesGiven && (
                            <div className="text-[11px] text-slate-500 mt-1">
                              Samples: {c.samplesGiven}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-semibold ${outcomeBadge(
                              c.callOutcome
                            )}`}
                          >
                            {c.callOutcome}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-800">{c.doctorRemark}</td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="font-medium text-slate-700">{c.employeeName}</div>
                          {c.nextFollowUpDate && (
                            <div className="text-[11px] font-mono text-[#15803D]">
                              Next: {c.nextFollowUpDate}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* MODAL 1: BULK ADD ALL DOCTORS IN ONE GO */}
      {showBulkModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-base font-bold text-[#0F2744]">
                  Bulk Add Doctors (Ek Baar Me Saare Doctors Add Karein)
                </h3>
                <p className="text-xs text-slate-500">
                  Add multiple doctors at once using the quick table or by pasting a list.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowBulkModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {err && (
              <div className="mb-3 p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs">
                {err}
              </div>
            )}

            <form onSubmit={handleBulkSaveDoctors} className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setBulkMode('grid')}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${
                      bulkMode === 'grid'
                        ? 'bg-[#0F2744] text-white'
                        : 'bg-white border border-slate-300 text-slate-700'
                    }`}
                  >
                    Multi-Row Table
                  </button>
                  <button
                    type="button"
                    onClick={() => setBulkMode('paste')}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${
                      bulkMode === 'paste'
                        ? 'bg-[#0F2744] text-white'
                        : 'bg-white border border-slate-300 text-slate-700'
                    }`}
                  >
                    Quick Paste List
                  </button>
                </div>

                {isAdminView && (
                  <select
                    value={bulkEmpUid}
                    onChange={(e) => setBulkEmpUid(e.target.value)}
                    className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    <option value={currentUser.uid}>
                      Assign All to: {currentUser.displayName}
                    </option>
                    {employees.map((em) => (
                      <option key={em.id} value={em.uid || em.id}>
                        Assign All to: {em.fullName}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {bulkMode === 'grid' ? (
                <div className="space-y-2">
                  <div className="overflow-x-auto border border-slate-200 rounded-xl">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                        <tr>
                          <th className="px-2.5 py-2">#</th>
                          <th className="px-2.5 py-2 min-w-[160px]">Doctor Name *</th>
                          <th className="px-2.5 py-2 min-w-[140px]">Specialty</th>
                          <th className="px-2.5 py-2 min-w-[160px]">Clinic / Hospital *</th>
                          <th className="px-2.5 py-2 min-w-[120px]">City / Area *</th>
                          <th className="px-2.5 py-2 min-w-[110px]">Phone</th>
                          <th className="px-2.5 py-2">Tier</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {bulkRows.map((row, idx) => (
                          <tr key={idx}>
                            <td className="px-2.5 py-1.5 font-mono text-slate-400">
                              {idx + 1}
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                value={row.name}
                                onChange={(e) =>
                                  setBulkRows((prev) =>
                                    prev.map((r, i) =>
                                      i === idx ? { ...r, name: e.target.value } : r
                                    )
                                  )
                                }
                                placeholder="Dr. Amit Verma"
                                className="w-full px-2 py-1.5 border border-slate-300 rounded text-xs"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <select
                                value={row.specialty}
                                onChange={(e) =>
                                  setBulkRows((prev) =>
                                    prev.map((r, i) =>
                                      i === idx ? { ...r, specialty: e.target.value } : r
                                    )
                                  )
                                }
                                className="w-full px-2 py-1.5 border border-slate-300 rounded text-xs bg-white"
                              >
                                {SPECIALTIES.map((sp) => (
                                  <option key={sp} value={sp}>
                                    {sp}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                value={row.clinicName}
                                onChange={(e) =>
                                  setBulkRows((prev) =>
                                    prev.map((r, i) =>
                                      i === idx ? { ...r, clinicName: e.target.value } : r
                                    )
                                  )
                                }
                                placeholder="City Care Clinic"
                                className="w-full px-2 py-1.5 border border-slate-300 rounded text-xs"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                value={row.city}
                                onChange={(e) =>
                                  setBulkRows((prev) =>
                                    prev.map((r, i) =>
                                      i === idx ? { ...r, city: e.target.value } : r
                                    )
                                  )
                                }
                                placeholder="Dadar / Mumbai"
                                className="w-full px-2 py-1.5 border border-slate-300 rounded text-xs"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                value={row.phone}
                                onChange={(e) =>
                                  setBulkRows((prev) =>
                                    prev.map((r, i) =>
                                      i === idx ? { ...r, phone: e.target.value } : r
                                    )
                                  )
                                }
                                placeholder="98201..."
                                className="w-full px-2 py-1.5 border border-slate-300 rounded text-xs font-mono"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <select
                                value={row.tier}
                                onChange={(e) =>
                                  setBulkRows((prev) =>
                                    prev.map((r, i) =>
                                      i === idx
                                        ? {
                                            ...r,
                                            tier: e.target.value as BulkDoctorRow['tier'],
                                          }
                                        : r
                                    )
                                  )
                                }
                                className="px-2 py-1.5 border border-slate-300 rounded text-xs bg-white"
                              >
                                <option value="Core A+">Core A+</option>
                                <option value="Class A">Class A</option>
                                <option value="Class B">Class B</option>
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setBulkRows((prev) => [
                        ...prev,
                        ...Array.from({ length: 5 }, emptyBulkRow),
                      ])
                    }
                    className="text-xs font-semibold text-[#0F2744] hover:underline"
                  >
                    + Add 5 More Rows
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-xs text-slate-600">
                    Paste one doctor per line using <code className="bg-slate-100 px-1 rounded">|</code> or comma separator:{' '}
                    <span className="font-mono text-[11px]">
                      Dr. Name | Specialty | Clinic Name | City/Area | Phone
                    </span>
                  </div>
                  <textarea
                    rows={8}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder={`Dr. Rajesh Gupta | General Physician | Gupta Medicare | Dadar West | 9820112233\nDr. Sneha Joshi | Pediatrician | Little Care Hospital | Bandra | 9819223344\nDr. Manoj Kulkarni | Orthopedic | Spine & Joint Clinic | Andheri East | 9765112200`}
                    className="w-full p-3 text-xs font-mono border border-slate-300 rounded-xl"
                  />
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowBulkModal(false)}
                  className="px-4 py-2 text-xs text-slate-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[40px] disabled:opacity-60"
                >
                  {saving ? 'Saving All Doctors...' : 'Save All Doctors Together'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: ADD SINGLE DOCTOR */}
      {showSingleModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-[#0F2744]">Add Doctor</h3>
              <button type="button" onClick={() => setShowSingleModal(false)} className="p-1 text-slate-500">
                <X className="w-4 h-4" />
              </button>
            </div>
            {err && (
              <div className="mb-3 p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs">
                {err}
              </div>
            )}
            <form onSubmit={handleSaveSingleDoctor} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  required
                  value={dName}
                  onChange={(e) => setDName(e.target.value)}
                  placeholder="Doctor Full Name (e.g. Dr. R. K. Sharma) *"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
                <input
                  type="text"
                  value={dQual}
                  onChange={(e) => setDQual(e.target.value)}
                  placeholder="Qualification (e.g. MBBS, MD)"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <select
                  value={dSpecialty}
                  onChange={(e) => setDSpecialty(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  {SPECIALTIES.map((sp) => (
                    <option key={sp} value={sp}>
                      {sp}
                    </option>
                  ))}
                </select>
                <select
                  value={dTier}
                  onChange={(e) => setDTier(e.target.value as any)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="Core A+">Core A+ Doctor</option>
                  <option value="Class A">Class A Doctor</option>
                  <option value="Class B">Class B Doctor</option>
                </select>
              </div>
              <input
                type="text"
                required
                value={dClinic}
                onChange={(e) => setDClinic(e.target.value)}
                placeholder="Clinic / Hospital Name *"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  required
                  value={dCity}
                  onChange={(e) => setDCity(e.target.value)}
                  placeholder="City *"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
                <input
                  type="text"
                  value={dBeat}
                  onChange={(e) => setDBeat(e.target.value)}
                  placeholder="Area / Market Beat"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  value={dPhone}
                  onChange={(e) => setDPhone(e.target.value)}
                  placeholder="Mobile / Reception Phone"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
                <input
                  type="text"
                  value={dAddress}
                  onChange={(e) => setDAddress(e.target.value)}
                  placeholder="Clinic Address"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              {isAdminView && (
                <select
                  value={dEmpUid}
                  onChange={(e) => setDEmpUid(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value={currentUser.uid}>
                    Assigned Rep: {currentUser.displayName}
                  </option>
                  {employees.map((em) => (
                    <option key={em.id} value={em.uid || em.id}>
                      Assigned Rep: {em.fullName}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowSingleModal(false)} className="px-4 py-2 text-xs text-slate-600">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
                >
                  {saving ? 'Saving...' : 'Save Doctor'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: LOG DOCTOR CALL, PRODUCT DETAILING & REMARKS */}
      {callDoctor && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-base font-bold text-[#0F2744]">
                  Doctor Call &amp; Product Detailing
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  <strong>{callDoctor.name}</strong> · {callDoctor.specialty} · {callDoctor.clinicName}
                </p>
              </div>
              <button type="button" onClick={() => setCallDoctor(null)} className="p-1 text-slate-500">
                <X className="w-5 h-5" />
              </button>
            </div>

            {err && (
              <div className="mb-3 p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs">
                {err}
              </div>
            )}

            <form onSubmit={handleSaveDoctorCall} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Call Date
                  </label>
                  <input
                    type="date"
                    required
                    value={callDate}
                    onChange={(e) => setCallDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Call Outcome
                  </label>
                  <select
                    value={callOutcome}
                    onChange={(e) => setCallOutcome(e.target.value as DoctorCallOutcome)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {OUTCOMES.map((out) => (
                      <option key={out} value={out}>
                        {out}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Products Shown / Detailed * ({selectedProducts.length} selected)
                </label>
                {products.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2 max-h-36 overflow-y-auto p-2.5 rounded-xl bg-slate-50 border border-slate-200">
                    {products.map((prod) => {
                      const active = selectedProducts.includes(prod.name);
                      return (
                        <button
                          key={prod.id}
                          type="button"
                          onClick={() => toggleProductShown(prod.name)}
                          className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            active
                              ? 'bg-[#0F2744] text-white border-[#0F2744]'
                              : 'bg-white text-slate-700 border-slate-300 hover:border-[#0F2744]'
                          }`}
                        >
                          {active && <Check className="w-3 h-3" />}
                          {prod.name}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customProduct}
                    onChange={(e) => setCustomProduct(e.target.value)}
                    placeholder="Or type product name shown (e.g. Glaceclav 625)"
                    className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                  <button
                    type="button"
                    onClick={addCustomProductToCall}
                    className="px-3 py-2 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg border border-slate-300"
                  >
                    Add
                  </button>
                </div>

                {selectedProducts.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {selectedProducts.map((sp) => (
                      <span
                        key={sp}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-900 text-[11px] font-medium"
                      >
                        {sp}
                        <button type="button" onClick={() => toggleProductShown(sp)}>
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Doctor&apos;s Remarks (Dr ne kya bola) *
                </label>
                <textarea
                  rows={3}
                  required
                  value={doctorRemark}
                  onChange={(e) => setDoctorRemark(e.target.value)}
                  placeholder="Write exact doctor feedback: prescription commitment, price feedback, sample request, competitor mention, or next visit timing..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Samples / Visual Aid Given
                  </label>
                  <input
                    type="text"
                    value={samplesGiven}
                    onChange={(e) => setSamplesGiven(e.target.value)}
                    placeholder="e.g. 2 strips sample + folder"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Next Follow-Up Date
                  </label>
                  <input
                    type="date"
                    value={nextFollowUpDate}
                    onChange={(e) => setNextFollowUpDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                    {gpsCapturing ? (
                      <Loader2 className="w-3.5 h-3.5 text-[#15803D] animate-spin" />
                    ) : (
                      <MapPin
                        className={`w-3.5 h-3.5 ${
                          callGps ? 'text-[#15803D]' : 'text-amber-600'
                        }`}
                      />
                    )}
                    <span>Employee Call Location</span>
                  </div>
                  <button
                    type="button"
                    disabled={gpsCapturing}
                    onClick={captureCallGps}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-60"
                  >
                    <RefreshCw className={`w-3 h-3 ${gpsCapturing ? 'animate-spin' : ''}`} />
                    {callGps ? 'Refresh GPS' : 'Capture GPS'}
                  </button>
                </div>

                <input
                  type="text"
                  value={callLocationName}
                  onChange={(e) => setCallLocationName(e.target.value)}
                  placeholder="Call area / landmark / city (auto-filled from GPS)"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                />

                <div className="text-[11px] text-slate-500">
                  {gpsStatus ||
                    'GPS location is auto-captured so managers can see where this call happened.'}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCallDoctor(null)}
                  className="px-4 py-2 text-xs text-slate-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[40px] disabled:opacity-60"
                >
                  {saving ? 'Saving Call...' : 'Save Call & Remarks'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 4: INDIVIDUAL DOCTOR CALL HISTORY */}
      {historyDoctor && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-xl w-full max-h-[85vh] overflow-y-auto p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-bold text-[#0F2744]">
                  {historyDoctor.name} · Call History
                </h3>
                <p className="text-xs text-slate-500">
                  {historyDoctor.specialty} · {historyDoctor.clinicName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryDoctor(null)}
                className="p-1 text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {doctorCalls.filter((c) => c.doctorId === historyDoctor.id).length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                No detailing calls logged for this doctor yet.
              </div>
            ) : (
              <div className="space-y-3">
                {doctorCalls
                  .filter((c) => c.doctorId === historyDoctor.id)
                  .map((c) => {
                    const locSummary = formatCallLocationSummary(c);
                    const canPinLocation =
                      isAdminView || c.employeeUid === currentUser.uid;
                    return (
                      <div
                        key={c.id}
                        className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 space-y-1.5 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-semibold text-[#0F2744]">
                            {c.callDate} · {c.employeeName}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${outcomeBadge(
                              c.callOutcome
                            )}`}
                          >
                            {c.callOutcome}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] bg-white px-2.5 py-1.5 rounded border border-slate-200">
                          <span className="inline-flex items-center gap-1.5 text-slate-700 font-medium">
                            <MapPin
                              className={`w-3.5 h-3.5 shrink-0 ${
                                locSummary.hasGps ? 'text-[#15803D]' : 'text-amber-600'
                              }`}
                            />
                            {locSummary.label}
                          </span>
                          {locSummary.hasGps && locSummary.mapsUrl ? (
                            <a
                              href={locSummary.mapsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-mono text-[#0F2744] font-semibold hover:underline"
                            >
                              {locSummary.coordsText}
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          ) : (
                            canPinLocation && (
                              <button
                                type="button"
                                onClick={() => openPinCallModal(c)}
                                className="inline-flex items-center gap-1 font-semibold text-[#0F2744] hover:underline"
                              >
                                <Navigation className="w-3 h-3" />
                                Set Location
                              </button>
                            )
                          )}
                        </div>
                        <div className="text-slate-700 font-medium">
                          Products: {c.productsShown.join(', ')}
                        </div>
                        <div className="text-slate-800 bg-white p-2 rounded border border-slate-200">
                          {c.doctorRemark}
                        </div>
                        {c.nextFollowUpDate && (
                          <div className="text-[11px] text-[#15803D] font-mono">
                            Follow-up planned: {c.nextFollowUpDate}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL 5: PIN / SET LOCATION ON EXISTING CALL */}
      {pinCall && (
        <div className="fixed inset-0 z-[60] bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-5 sm:p-6 shadow-xl space-y-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-[#0F2744]">
                  Set Call Location
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {pinCall.doctorName} · Rep: {pinCall.employeeName} ({pinCall.callDate})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPinCall(null)}
                className="p-1 text-slate-500 hover:text-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSavePinnedCallLocation} className="space-y-3">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-700">GPS Coordinates</span>
                  <button
                    type="button"
                    disabled={pinCapturing}
                    onClick={() =>
                      void runPinGpsCapture(
                        [pinCall.areaBeat, pinCall.clinicName].filter(Boolean).join(', ')
                      )
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-60"
                  >
                    {pinCapturing ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Navigation className="w-3 h-3 text-[#15803D]" />
                    )}
                    {pinGps ? 'Re-Capture Current GPS' : 'Capture Current GPS'}
                  </button>
                </div>
                {pinGps ? (
                  <div className="font-mono text-[11px] text-[#15803D]">
                    {pinGps.lat.toFixed(5)}, {pinGps.lng.toFixed(5)} (±{pinGps.accuracy}m)
                  </div>
                ) : (
                  <div className="text-[11px] text-slate-500">
                    {pinStatus || 'No GPS coordinates yet.'}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Place / Area Name
                </label>
                <input
                  type="text"
                  required
                  value={pinLocName}
                  onChange={(e) => setPinLocName(e.target.value)}
                  placeholder="e.g. Civil Lines, Jaipur or Clinic Area"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              {pinStatus && pinGps && (
                <div className="text-[11px] text-slate-500">{pinStatus}</div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setPinCall(null)}
                  className="px-4 py-2 text-xs text-slate-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingPin}
                  className="px-4 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg disabled:opacity-60"
                >
                  {savingPin ? 'Saving...' : 'Save Call Location'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
