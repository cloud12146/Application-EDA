import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import { todayIsoDate } from './utils';

const DEMO_COLLECTIONS = [
  'employees',
  'attendance',
  'leaveRequests',
  'locations',
  'tasks',
  'activityLogs',
  'products',
  'stockMovements',
  'stockAllocations',
  'customers',
  'salesOrders',
  'payments',
  'distributors',
  'tourPlans',
  'doctors',
  'doctorCalls',
] as const;

export async function seedSampleDemoData(adminUid: string, adminName: string) {
  const batch = writeBatch(db);
  const today = todayIsoDate();

  // Sample Employees (tagged isDemo: true)
  const demoEmployees = [
    {
      id: 'demo_emp_1',
      uid: 'demo_uid_arjun',
      employeeCode: 'GLC-102',
      fullName: 'Arjun Deshmukh',
      email: 'arjun.deshmukh@glacetor.example.com',
      phone: '+91 98201 44120',
      role: 'Marketing Executive (ME)',
      department: 'Field Sales — West',
      designation: 'Senior Medical Representative (Sr. MR)',
      territory: 'Mumbai South & Dadar',
      geofenceLat: 19.0176,
      geofenceLng: 72.8562,
      geofenceRadiusM: 3500,
      status: 'Active',
      joiningDate: '2024-04-12',
    },
    {
      id: 'demo_emp_2',
      uid: 'demo_uid_priya',
      employeeCode: 'GLC-108',
      fullName: 'Priya Nair',
      email: 'priya.nair@glacetor.example.com',
      phone: '+91 98112 77390',
      role: 'Marketing Executive (ME)',
      department: 'Field Sales — Central',
      designation: 'Marketing Sales Manager (MSM)',
      territory: 'Andheri & Bandra West',
      geofenceLat: 19.1136,
      geofenceLng: 72.8697,
      geofenceRadiusM: 4000,
      status: 'Active',
      joiningDate: '2024-08-01',
    },
    {
      id: 'demo_emp_3',
      uid: 'demo_uid_rohan',
      employeeCode: 'GLC-115',
      fullName: 'Rohan Kulkarni',
      email: 'rohan.kulkarni@glacetor.example.com',
      phone: '+91 97654 22108',
      role: 'Stock Manager',
      department: 'Central Warehouse',
      designation: 'Warehouse & Batch Lead',
      territory: 'Bhiwandi Pharma Hub',
      assignedWarehouse: 'Bhiwandi Central Depot',
      geofenceLat: 19.2967,
      geofenceLng: 73.0631,
      geofenceRadiusM: 1200,
      status: 'Active',
      joiningDate: '2023-11-15',
    },
  ];

  for (const emp of demoEmployees) {
    batch.set(doc(db, 'employees', emp.id), {
      ...emp,
      isDemo: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // Sample Products using generated studio pharma images
  const demoProducts = [
    {
      id: 'demo_prod_1',
      name: 'Glaceclav 625 Tablets (Amoxycillin & Clavulanate)',
      sku: 'GLC-TAB-625',
      category: 'Antibiotics',
      brand: 'Glacetor Core',
      unit: 'Box (10x10)',
      batchNumber: 'GLB2604A',
      mfgDate: '2026-03-01',
      expiryDate: '2028-02-28',
      purchasePrice: 142.0,
      sellingPrice: 215.0,
      openingStock: 850,
      availableStock: 640,
      minStockLevel: 150,
      damagedStock: 4,
      warehouse: 'Bhiwandi Central Depot',
      imageUrl: '/src/assets/images/pharma_tablet_box_1795369268832.jpg',
    },
    {
      id: 'demo_prod_2',
      name: 'Glacetuss Pediatric Expectorant 100ml',
      sku: 'GLC-SYR-100',
      category: 'Pediatric Care',
      brand: 'Glacetor Pedia',
      unit: 'Bottle',
      batchNumber: 'GLS2601C',
      mfgDate: '2026-01-15',
      expiryDate: '2027-01-10',
      purchasePrice: 48.5,
      sellingPrice: 86.0,
      openingStock: 420,
      availableStock: 68,
      minStockLevel: 100,
      damagedStock: 0,
      warehouse: 'Bhiwandi Central Depot',
      imageUrl: '/src/assets/images/pharma_syrup_bottle_1795369269067.jpg',
    },
    {
      id: 'demo_prod_3',
      name: 'Glacetraxone 1g Sterile Injection Vial',
      sku: 'GLC-INJ-1000',
      category: 'Critical Care',
      brand: 'Glacetor Hospicare',
      unit: 'Vial',
      batchNumber: 'GLI2509K',
      mfgDate: '2025-09-10',
      expiryDate: '2026-12-20',
      purchasePrice: 34.0,
      sellingPrice: 62.5,
      openingStock: 1200,
      availableStock: 520,
      minStockLevel: 200,
      damagedStock: 2,
      warehouse: 'Pune Cold Chain',
      imageUrl: '/src/assets/images/pharma_vial_pack_1795369269026.jpg',
    },
    {
      id: 'demo_prod_4',
      name: 'Glaceprazole DSR Gastro Capsules',
      sku: 'GLC-CAP-040',
      category: 'Gastroenterology',
      brand: 'Glacetor Gastro',
      unit: 'Bottle (30s)',
      batchNumber: 'GLC2605M',
      mfgDate: '2026-05-05',
      expiryDate: '2028-04-30',
      purchasePrice: 64.0,
      sellingPrice: 118.0,
      openingStock: 600,
      availableStock: 495,
      minStockLevel: 120,
      damagedStock: 0,
      warehouse: 'Bhiwandi Central Depot',
      imageUrl: '/src/assets/images/pharma_capsule_pack_1795369268802.jpg',
    },
  ];

  for (const prod of demoProducts) {
    batch.set(doc(db, 'products', prod.id), {
      ...prod,
      isDemo: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // Sample Customers
  const demoCustomers = [
    {
      id: 'demo_cust_1',
      name: 'Dr. Vikram Mehta',
      businessName: 'CityMed Super Specialty Pharmacy',
      phone: '+91 22 2414 8890',
      address: '14 Gokhale Road South, Dadar West',
      city: 'Mumbai',
      category: 'Retail Pharmacy',
      assignedEmployeeUid: adminUid,
      assignedEmployeeName: adminName,
      lat: 19.0195,
      lng: 72.8428,
      outstandingBalance: 14500,
    },
    {
      id: 'demo_cust_2',
      name: 'Suresh Agarwal',
      businessName: 'Sahyadri Hospital Formulary Store',
      phone: '+91 22 2640 1122',
      address: 'Hill Road, Bandra West',
      city: 'Mumbai',
      category: 'Hospital',
      assignedEmployeeUid: 'demo_uid_priya',
      assignedEmployeeName: 'Priya Nair',
      lat: 19.0544,
      lng: 72.8302,
      outstandingBalance: 42800,
    },
    {
      id: 'demo_cust_3',
      name: 'Kiran Shah',
      businessName: 'Metro Pharma Stockists',
      phone: '+91 22 2834 5541',
      address: 'MIDC Cross Road B, Andheri East',
      city: 'Mumbai',
      category: 'Stockist',
      assignedEmployeeUid: 'demo_uid_arjun',
      assignedEmployeeName: 'Arjun Deshmukh',
      lat: 19.1197,
      lng: 72.8686,
      outstandingBalance: 0,
    },
  ];

  for (const cust of demoCustomers) {
    batch.set(doc(db, 'customers', cust.id), {
      ...cust,
      isDemo: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // Sample Distributors
  batch.set(doc(db, 'distributors', 'demo_dist_1'), {
    id: 'demo_dist_1',
    uid: 'demo_uid_dist1',
    companyName: 'Western Lifeline Pharma Distributors',
    contactPerson: 'Mahesh Kothari',
    email: 'orders@westernlifeline.example.com',
    phone: '+91 98204 51099',
    city: 'Mumbai',
    region: 'Maharashtra West',
    gstNumber: '27AAACW1234F1Z5',
    creditLimit: 500000,
    outstandingAmount: 84200,
    status: 'Active',
    isDemo: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Sample Attendance
  batch.set(doc(db, 'attendance', 'demo_att_1'), {
    id: 'demo_att_1',
    userId: 'demo_uid_arjun',
    employeeId: 'demo_emp_1',
    employeeName: 'Arjun Deshmukh',
    department: 'Field Sales — West',
    date: today,
    workMode: 'Field',
    status: 'Present',
    checkInTime: '09:12 AM',
    checkInLat: 19.0195,
    checkInLng: 72.8428,
    checkInAccuracy: 18,
    locationLabel: 'Dadar West Territory',
    isDemo: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'attendance', 'demo_att_2'), {
    id: 'demo_att_2',
    userId: 'demo_uid_priya',
    employeeId: 'demo_emp_2',
    employeeName: 'Priya Nair',
    department: 'Field Sales — Central',
    date: today,
    workMode: 'Field',
    status: 'Late',
    checkInTime: '09:48 AM',
    checkInLat: 19.0544,
    checkInLng: 72.8302,
    checkInAccuracy: 22,
    locationLabel: 'Bandra West Clinic Belt',
    isDemo: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Sample GPS Location records (explicitly flagged isDemo: true)
  batch.set(doc(db, 'locations', 'demo_loc_1'), {
    id: 'demo_loc_1',
    userId: 'demo_uid_arjun',
    employeeName: 'Arjun Deshmukh',
    territory: 'Mumbai South & Dadar',
    lat: 19.0195,
    lng: 72.8428,
    accuracy: 18,
    trackingActive: false,
    status: 'Customer Visit',
    customerId: 'demo_cust_1',
    customerName: 'CityMed Super Specialty Pharmacy',
    withinGeofence: true,
    note: 'Sample demo GPS visit marker',
    recordedAt: serverTimestamp(),
    isDemo: true,
  });

  batch.set(doc(db, 'locations', 'demo_loc_2'), {
    id: 'demo_loc_2',
    userId: 'demo_uid_priya',
    employeeName: 'Priya Nair',
    territory: 'Andheri & Bandra West',
    lat: 19.0544,
    lng: 72.8302,
    accuracy: 22,
    trackingActive: false,
    status: 'On Duty',
    customerId: 'demo_cust_2',
    customerName: 'Sahyadri Hospital Formulary Store',
    withinGeofence: true,
    note: 'Sample demo GPS visit marker',
    recordedAt: serverTimestamp(),
    isDemo: true,
  });

  // Sample Tasks
  batch.set(doc(db, 'tasks', 'demo_task_1'), {
    id: 'demo_task_1',
    title: 'Hospital Formulary Renewal — Sahyadri Hospital',
    description: 'Submit Q4 antibiotic rate card and sample pack of Glacetraxone 1g.',
    instructions: 'Collect signed acknowledgement from Chief Pharmacist.',
    assignedToUid: adminUid,
    assignedToName: adminName,
    teamName: 'Key Accounts',
    category: 'Customer Visit',
    priority: 'High',
    startDate: today,
    deadline: today,
    status: 'In Progress',
    progressPct: 45,
    createdByUid: adminUid,
    isDemo: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'tasks', 'demo_task_2'), {
    id: 'demo_task_2',
    title: 'Batch Expiry Audit — Pune Cold Chain',
    description: 'Inspect Glacetraxone 1g batch GLI2509K for approaching expiry window.',
    instructions: 'Tag cartons expiring within 90 days for priority institutional dispatch.',
    assignedToUid: 'demo_uid_rohan',
    assignedToName: 'Rohan Kulkarni',
    teamName: 'Warehouse QA',
    category: 'Stock Management',
    priority: 'Urgent',
    startDate: today,
    deadline: '2026-11-20',
    status: 'Overdue',
    progressPct: 20,
    createdByUid: adminUid,
    isDemo: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Sample Sales Order & Payment
  batch.set(doc(db, 'salesOrders', 'demo_ord_1'), {
    id: 'demo_ord_1',
    orderNumber: 'ORD-GLC-2601',
    customerId: 'demo_cust_1',
    customerName: 'Dr. Vikram Mehta',
    customerBusiness: 'CityMed Super Specialty Pharmacy',
    createdByUid: adminUid,
    createdByName: adminName,
    items: [
      {
        productId: 'demo_prod_1',
        productName: 'Glaceclav 625 Tablets (Amoxycillin & Clavulanate)',
        batchNumber: 'GLB2604A',
        qty: 50,
        unitPrice: 215,
        lineTotal: 10750,
      },
      {
        productId: 'demo_prod_4',
        productName: 'Glaceprazole DSR Gastro Capsules',
        batchNumber: 'GLC2605M',
        qty: 40,
        unitPrice: 118,
        lineTotal: 4720,
      },
    ],
    subtotal: 15470,
    discountPct: 5,
    discountAmount: 773.5,
    totalAmount: 14696.5,
    paidAmount: 10000,
    pendingAmount: 4696.5,
    orderStatus: 'Approved',
    paymentStatus: 'Partially Paid',
    orderType: 'Customer Sale',
    notes: 'Sample demo institutional order',
    isDemo: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'payments', 'demo_pay_1'), {
    id: 'demo_pay_1',
    orderId: 'demo_ord_1',
    orderNumber: 'ORD-GLC-2601',
    payerName: 'CityMed Super Specialty Pharmacy',
    amount: 10000,
    method: 'UPI',
    referenceNo: 'UPI-6321894012',
    collectedByUid: adminUid,
    collectedByName: adminName,
    paymentDate: today,
    notes: 'Advance settlement',
    isDemo: true,
    createdAt: serverTimestamp(),
  });

  // Sample Monthly Tour Plan entries
  const monthPrefix = today.slice(0, 7);
  batch.set(doc(db, 'tourPlans', `demo_tour_1`), {
    id: 'demo_tour_1',
    employeeUid: adminUid,
    employeeName: adminName,
    month: monthPrefix,
    date: `${monthPrefix}-05`,
    workType: 'Field Visit',
    headquarters: 'Mumbai HQ',
    placesToVisit: 'Dadar West, Sion Hospital Belt, Matunga Pharmacies',
    routeZone: 'South Mumbai Beat A',
    plannedCustomers: 'CityMed Super Specialty Pharmacy',
    objective: 'Glaceclav 625 detailing & monthly order booking',
    overnightStay: false,
    approvalStatus: 'Approved',
    createdByUid: adminUid,
    isDemo: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'tourPlans', `demo_tour_2`), {
    id: 'demo_tour_2',
    employeeUid: 'demo_uid_arjun',
    employeeName: 'Arjun Deshmukh',
    month: monthPrefix,
    date: today,
    workType: 'Field Visit',
    headquarters: 'Mumbai South & Dadar',
    placesToVisit: 'Andheri East MIDC, Chakala Retail Chemists, Marol Clinics',
    routeZone: 'Western Suburbs Beat B',
    plannedCustomers: 'Metro Pharma Stockists',
    objective: 'Stockist replenishment and pending collection follow-up',
    overnightStay: false,
    approvalStatus: 'Submitted',
    createdByUid: adminUid,
    isDemo: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Sample Doctors & Detailing Call
  batch.set(doc(db, 'doctors', 'demo_doc_1'), {
    id: 'demo_doc_1',
    name: 'Dr. Anand Kulkarni',
    specialty: 'General Physician',
    qualification: 'MBBS, MD',
    clinicName: 'Kulkarni Polyclinic & Diagnostics',
    phone: '+91 98201 55010',
    city: 'Mumbai',
    areaBeat: 'Dadar West',
    tier: 'Core A+',
    assignedEmployeeUid: adminUid,
    assignedEmployeeName: adminName,
    totalCalls: 1,
    lastVisitedDate: today,
    lastCallOutcome: 'Interested',
    lastProductsShown: 'Glaceclav 625 Tablets (Amoxycillin & Clavulanate), Glaceprazole DSR Gastro Capsules',
    lastDoctorRemark: 'Liked Glaceclav 625 margin; asked for 5 sample strips on next Tuesday visit.',
    isDemo: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'doctors', 'demo_doc_2'), {
    id: 'demo_doc_2',
    name: 'Dr. Meera Deshpande',
    specialty: 'Pediatrician',
    qualification: 'MBBS, DCH',
    clinicName: 'Sparsh Child Care Center',
    phone: '+91 98190 44129',
    city: 'Mumbai',
    areaBeat: 'Bandra West',
    tier: 'Class A',
    assignedEmployeeUid: adminUid,
    assignedEmployeeName: adminName,
    totalCalls: 0,
    isDemo: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'doctorCalls', 'demo_dcall_1'), {
    id: 'demo_dcall_1',
    doctorId: 'demo_doc_1',
    doctorName: 'Dr. Anand Kulkarni',
    clinicName: 'Kulkarni Polyclinic & Diagnostics',
    specialty: 'General Physician',
    areaBeat: 'Dadar West',
    employeeUid: adminUid,
    employeeName: adminName,
    callDate: today,
    productsShown: [
      'Glaceclav 625 Tablets (Amoxycillin & Clavulanate)',
      'Glaceprazole DSR Gastro Capsules',
    ],
    samplesGiven: '2 strips Glaceclav + visual detailing folder',
    callOutcome: 'Interested',
    doctorRemark: 'Liked Glaceclav 625 margin; asked for 5 sample strips on next Tuesday visit.',
    isDemo: true,
    createdAt: serverTimestamp(),
  });

  batch.set(
    doc(db, 'settings', 'company'),
    {
      demoDataSeeded: true,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'demoSeed');
  }
}

export async function clearSampleDemoData() {
  try {
    for (const colName of DEMO_COLLECTIONS) {
      const snap = await getDocs(
        query(collection(db, colName), where('isDemo', '==', true))
      );
      for (const docSnap of snap.docs) {
        await deleteDoc(docSnap.ref);
      }
    }
    await writeBatch(db)
      .set(
        doc(db, 'settings', 'company'),
        { demoDataSeeded: false, updatedAt: serverTimestamp() },
        { merge: true }
      )
      .commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, 'demoClear');
  }
}
