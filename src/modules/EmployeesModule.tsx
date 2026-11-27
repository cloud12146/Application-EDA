import React, { useMemo, useState } from 'react';
import {
  doc,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  Edit2,
  MapPin,
  Plus,
  Search,
  Shield,
  UserCheck,
  UserX,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { emailToKey, generateId, todayIsoDate } from '../lib/utils';
import { logActivity } from '../lib/erpActions';
import {
  ASSIGNABLE_ROLES,
  AssignableRole,
  EMPLOYEE_POST_OPTIONS,
  FIELD_EMPLOYEE_POST_OPTIONS,
  getDefaultDepartmentForRole,
  getDefaultPostForRole,
  getRoleDisplayLabel,
  normalizePostForEdit,
  normalizeRoleForEdit,
} from '../lib/roles';
import { Employee, UserAccount } from '../types/erp';

interface EmployeesModuleProps {
  currentUser: UserAccount;
  employees: Employee[];
  users: UserAccount[];
  onCheckLiveLocation?: (employeeUid: string) => void;
}

export const EmployeesModule: React.FC<EmployeesModuleProps> = ({
  currentUser,
  employees,
  users,
  onCheckLiveLocation,
}) => {
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('ALL');
  const [postFilter, setPostFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const [showModal, setShowModal] = useState(false);
  const [editingEmp, setEditingEmp] = useState<Employee | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [pendingPosts, setPendingPosts] = useState<Record<string, string>>({});

  // Form fields
  const [employeeCode, setEmployeeCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<AssignableRole>('Marketing Executive (ME)');
  const [department, setDepartment] = useState('Field Sales');
  const [designation, setDesignation] = useState('Marketing Executive (ME)');
  const [useCustomPost, setUseCustomPost] = useState(false);
  const [territory, setTerritory] = useState('');
  const [assignedWarehouse, setAssignedWarehouse] = useState('Central Warehouse');
  const [geofenceLat, setGeofenceLat] = useState('19.0760');
  const [geofenceLng, setGeofenceLng] = useState('72.8777');
  const [geofenceRadiusM, setGeofenceRadiusM] = useState('2500');
  const [status, setStatus] = useState<Employee['status']>('Active');

  const canManageAdminRoles = currentUser.role === 'Super Admin' || currentUser.role === 'Admin';

  const openCreate = () => {
    setEditingEmp(null);
    setEmployeeCode(`GLC-${Math.floor(100 + Math.random() * 899)}`);
    setFullName('');
    setEmail('');
    setPhone('');
    setRole('Marketing Executive (ME)');
    setDepartment('Field Sales');
    setDesignation('Marketing Executive (ME)');
    setUseCustomPost(false);
    setTerritory('');
    setAssignedWarehouse('Central Warehouse');
    setGeofenceLat('19.0760');
    setGeofenceLng('72.8777');
    setGeofenceRadiusM('2500');
    setStatus('Active');
    setError('');
    setShowModal(true);
  };

  const openEdit = (emp: Employee) => {
    const normalizedRole = normalizeRoleForEdit(emp.role);
    const existingPost = normalizePostForEdit(
      emp.designation || getDefaultPostForRole(normalizedRole)
    );
    const isPreset = EMPLOYEE_POST_OPTIONS.includes(existingPost);

    setEditingEmp(emp);
    setEmployeeCode(emp.employeeCode);
    setFullName(emp.fullName);
    setEmail(emp.email);
    setPhone(emp.phone || '');
    setRole(normalizedRole);
    setDepartment(emp.department);
    setDesignation(existingPost);
    setUseCustomPost(Boolean(existingPost && !isPreset));
    setTerritory(emp.territory || '');
    setAssignedWarehouse(emp.assignedWarehouse || 'Central Warehouse');
    setGeofenceLat(String(emp.geofenceLat ?? 19.076));
    setGeofenceLng(String(emp.geofenceLng ?? 72.8777));
    setGeofenceRadiusM(String(emp.geofenceRadiusM ?? 2500));
    setStatus(emp.status);
    setError('');
    setShowModal(true);
  };

  const handleRoleChange = (nextRole: AssignableRole) => {
    setRole(nextRole);
    if (!editingEmp) {
      setDesignation(getDefaultPostForRole(nextRole));
      setUseCustomPost(false);
      setDepartment(getDefaultDepartmentForRole(nextRole));
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!fullName.trim() || !email.trim() || !employeeCode.trim()) {
      setError('Employee code, full name, and corporate email are required.');
      return;
    }
    setSaving(true);
    const cleanEmail = email.trim().toLowerCase();
    const empId = editingEmp?.id || generateId('emp');
    const inviteKey = emailToKey(cleanEmail);
    const cleanDesignation = (designation.trim() || getDefaultPostForRole(role)).slice(0, 80);

    try {
      const batch = writeBatch(db);

      if (editingEmp) {
        batch.update(doc(db, 'employees', empId), {
          employeeCode: employeeCode.trim(),
          fullName: fullName.trim(),
          email: cleanEmail,
          phone: phone.trim(),
          role,
          department: department.trim(),
          designation: cleanDesignation,
          territory: territory.trim(),
          assignedWarehouse: assignedWarehouse.trim(),
          geofenceLat: Number(geofenceLat) || 19.076,
          geofenceLng: Number(geofenceLng) || 72.8777,
          geofenceRadiusM: Math.max(50, Number(geofenceRadiusM) || 2500),
          status,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(doc(db, 'employees', empId), {
          id: empId,
          employeeCode: employeeCode.trim(),
          fullName: fullName.trim(),
          email: cleanEmail,
          phone: phone.trim(),
          role,
          department: department.trim(),
          designation: cleanDesignation,
          territory: territory.trim(),
          assignedWarehouse: assignedWarehouse.trim(),
          geofenceLat: Number(geofenceLat) || 19.076,
          geofenceLng: Number(geofenceLng) || 72.8777,
          geofenceRadiusM: Math.max(50, Number(geofenceRadiusM) || 2500),
          status,
          joiningDate: todayIsoDate(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      // Pre-provision invite mapping so first Google/Email login automatically gets authorized role & post
      batch.set(doc(db, 'invites', inviteKey), {
        email: cleanEmail,
        role,
        employeeId: empId,
        fullName: fullName.trim(),
        department: department.trim(),
        designation: cleanDesignation,
        territory: territory.trim(),
        phone: phone.trim(),
        createdAt: serverTimestamp(),
      });

      // Sync existing linked user account if already signed in
      const linkedUser = users.find(
        (u) => u.uid === editingEmp?.uid || u.email.toLowerCase() === cleanEmail
      );
      if (linkedUser) {
        batch.update(doc(db, 'users', linkedUser.uid), {
          role,
          displayName: fullName.trim(),
          department: department.trim(),
          designation: cleanDesignation,
          territory: territory.trim(),
          phone: phone.trim(),
          isActive: status === 'Active',
          employeeId: empId,
          updatedAt: serverTimestamp(),
        });
        if (role === 'Super Admin' || role === 'Admin') {
          batch.set(doc(db, 'admins', linkedUser.uid), {
            uid: linkedUser.uid,
            email: cleanEmail,
            role,
            grantedAt: serverTimestamp(),
            grantedBy: currentUser.uid,
          });
        }
      }

      await batch.commit();

      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: editingEmp ? 'Employee Updated' : 'Employee Created',
        entityType: 'employee',
        entityId: empId,
        details: `${fullName.trim()} (${role} · ${cleanDesignation}) · ${cleanEmail}`,
      });

      setSuccess(
        editingEmp
          ? `Updated ${fullName.trim()} (${role} · ${cleanDesignation}) successfully.`
          : `Added ${fullName.trim()} (${role} · ${cleanDesignation}). They will automatically receive this role upon login with ${cleanEmail}.`
      );
      setShowModal(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `employees/${empId}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (emp: Employee) => {
    const nextStatus = emp.status === 'Active' ? 'Inactive' : 'Active';
    try {
      await updateDoc(doc(db, 'employees', emp.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      const linked = users.find(
        (u) => u.uid === emp.uid || u.email.toLowerCase() === emp.email.toLowerCase()
      );
      if (linked) {
        await updateDoc(doc(db, 'users', linked.uid), {
          isActive: nextStatus === 'Active',
          updatedAt: serverTimestamp(),
        });
      }
      setSuccess(`${emp.fullName} marked as ${nextStatus}.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `employees/${emp.id}`);
    }
  };

  const assignPendingUser = async (
    pendingUser: UserAccount,
    assignedRole: AssignableRole,
    chosenPost?: string
  ) => {
    const empId = `emp_${pendingUser.uid}`;
    const inviteKey = emailToKey(pendingUser.email);
    const finalPost = (chosenPost || getDefaultPostForRole(assignedRole)).trim().slice(0, 80);
    const finalDept = getDefaultDepartmentForRole(assignedRole);
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'users', pendingUser.uid), {
        role: assignedRole,
        department: finalDept,
        designation: finalPost,
        isActive: true,
        employeeId: empId,
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'employees', empId), {
        id: empId,
        uid: pendingUser.uid,
        employeeCode: `GLC-${Math.floor(200 + Math.random() * 799)}`,
        fullName: pendingUser.displayName,
        email: pendingUser.email.toLowerCase(),
        role: assignedRole,
        department: finalDept,
        designation: finalPost,
        status: 'Active',
        joiningDate: todayIsoDate(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'invites', inviteKey), {
        email: pendingUser.email.toLowerCase(),
        role: assignedRole,
        employeeId: empId,
        fullName: pendingUser.displayName,
        department: finalDept,
        designation: finalPost,
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      setSuccess(
        `Assigned ${pendingUser.displayName} as ${assignedRole} (${finalPost}).`
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${pendingUser.uid}`);
    }
  };

  const pendingUsers = users.filter((u) => u.role === 'Pending');

  const availablePosts = useMemo(() => {
    const set = new Set<string>(EMPLOYEE_POST_OPTIONS);
    employees.forEach((e) => {
      if (e.designation?.trim()) set.add(normalizePostForEdit(e.designation));
    });
    return Array.from(set);
  }, [employees]);

  const filtered = useMemo(() => {
    return employees.filter((e) => {
      if (roleFilter !== 'ALL') {
        if (roleFilter === 'Marketing Executive (ME)') {
          if (
            e.role !== 'Marketing Executive (ME)' &&
            e.role !== 'Field Sales Employee'
          ) {
            return false;
          }
        } else if (roleFilter === 'Area Sales Manager (ASM)') {
          if (
            e.role !== 'Area Sales Manager (ASM)' &&
            e.role !== 'Area Sales Manager' &&
            e.role !== 'Manager'
          ) {
            return false;
          }
        } else if (roleFilter === 'Regional Sales Manager (RSM)') {
          if (
            e.role !== 'Regional Sales Manager (RSM)' &&
            e.role !== 'RSM (Zonal Sales Manager)'
          ) {
            return false;
          }
        } else if (roleFilter === 'Zonal Sales Manager (ZSM)') {
          if (
            e.role !== 'Zonal Sales Manager (ZSM)' &&
            e.role !== 'Zonal Sales Manager'
          ) {
            return false;
          }
        } else if (e.role !== roleFilter) {
          return false;
        }
      }
      if (
        postFilter !== 'ALL' &&
        normalizePostForEdit(e.designation || '').toLowerCase() !==
          postFilter.toLowerCase()
      ) {
        return false;
      }
      if (statusFilter !== 'ALL' && e.status !== statusFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          e.fullName.toLowerCase().includes(q) ||
          e.email.toLowerCase().includes(q) ||
          e.employeeCode.toLowerCase().includes(q) ||
          getRoleDisplayLabel(e.role).toLowerCase().includes(q) ||
          normalizePostForEdit(e.designation || '').toLowerCase().includes(q) ||
          (e.territory || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [employees, roleFilter, postFilter, statusFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            Employee & Role Management
          </h2>
          <p className="text-xs text-slate-500">
            Provision accounts, assign RBAC roles, configure territory geofences, and manage active status.
          </p>
        </div>

        {canManageAdminRoles && (
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg transition-colors self-start min-h-[44px]"
          >
            <Plus className="w-4 h-4" />
            Add Employee
          </button>
        )}
      </div>

      {success && (
        <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs">
          {success}
        </div>
      )}

      {/* Pending Self-Registered Users awaiting Role Assignment */}
      {canManageAdminRoles && pendingUsers.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-900 mb-2">
            <Shield className="w-4 h-4" />
            Pending Access Requests ({pendingUsers.length})
          </div>
          <div className="space-y-2">
            {pendingUsers.map((pu) => {
              const selectedPost =
                pendingPosts[pu.uid] || 'Marketing Executive (ME)';
              return (
                <div
                  key={pu.uid}
                  className="bg-white border border-amber-200 rounded-lg p-3 flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 text-xs"
                >
                  <div>
                    <span className="font-semibold text-slate-900">{pu.displayName}</span>
                    <span className="text-slate-500 ml-2">{pu.email}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <select
                      value={selectedPost}
                      onChange={(e) =>
                        setPendingPosts((prev) => ({
                          ...prev,
                          [pu.uid]: e.target.value,
                        }))
                      }
                      aria-label="Employee Post"
                      className="px-2 py-1.5 text-xs border border-slate-300 rounded-md bg-slate-50 text-slate-800"
                    >
                      {FIELD_EMPLOYEE_POST_OPTIONS.map((p) => (
                        <option key={p} value={p}>
                          Post: {p}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() =>
                        assignPendingUser(pu, 'Marketing Executive (ME)', selectedPost)
                      }
                      className="px-2.5 py-1.5 bg-[#15803D] text-white rounded-md hover:bg-[#166534] font-medium"
                    >
                      Approve as ME
                    </button>
                    {(
                      [
                        'Area Sales Manager (ASM)',
                        'Regional Sales Manager (RSM)',
                        'Zonal Sales Manager (ZSM)',
                        'Stock Manager',
                        'Distributor',
                      ] as const
                    ).map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => assignPendingUser(pu, r)}
                        className="px-2.5 py-1.5 bg-[#0F2744] text-white rounded-md hover:bg-[#16355C] font-medium"
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Search & Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by name, code, email, post, or territory..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2744]"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => {
            setRoleFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
        >
          <option value="ALL">All Roles</option>
          {ASSIGNABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          value={postFilter}
          onChange={(e) => {
            setPostFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
        >
          <option value="ALL">All Posts / Designations</option>
          {availablePosts.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
        >
          <option value="ALL">All Statuses</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
          <option value="On Leave">On Leave</option>
        </select>
      </div>

      {/* Directory Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {paginated.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            No employees match the selected filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-semibold">Code</th>
                  <th className="px-4 py-3 font-semibold">Employee</th>
                  <th className="px-4 py-3 font-semibold">Role &amp; Post</th>
                  <th className="px-4 py-3 font-semibold">Territory / Geofence</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  {(canManageAdminRoles || onCheckLiveLocation) && (
                    <th className="px-4 py-3 font-semibold text-right">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginated.map((emp) => (
                  <tr key={emp.id} className="hover:bg-slate-50/70">
                    <td className="px-4 py-3 font-mono font-semibold text-[#0F2744]">
                      {emp.employeeCode}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">
                        {emp.fullName}
                        {emp.isDemo && (
                          <span className="ml-1.5 text-[10px] font-mono text-slate-400">
                            (Demo)
                          </span>
                        )}
                      </div>
                      <div className="text-slate-500">{emp.email}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">
                        {getRoleDisplayLabel(emp.role)}
                      </div>
                      <div className="text-slate-600">
                        {emp.designation
                          ? `${normalizePostForEdit(emp.designation)} · `
                          : ''}
                        <span className="text-slate-500">{emp.department}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-slate-800">{emp.territory || 'General'}</div>
                      <div className="text-[11px] font-mono text-slate-400">
                        Radius: {emp.geofenceRadiusM || 2500}m
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`font-semibold ${
                          emp.status === 'Active'
                            ? 'text-[#15803D]'
                            : emp.status === 'Inactive'
                            ? 'text-red-700'
                            : 'text-amber-700'
                        }`}
                      >
                        {emp.status}
                      </span>
                    </td>
                    {(canManageAdminRoles || onCheckLiveLocation) && (
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {onCheckLiveLocation && (
                          <button
                            type="button"
                            onClick={() => onCheckLiveLocation(emp.uid || emp.id)}
                            className="px-2 py-1 text-[11px] font-semibold text-[#15803D] bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md inline-flex items-center gap-1 mr-1"
                            title="Check Live GPS Location"
                          >
                            <MapPin className="w-3 h-3" />
                            Live
                          </button>
                        )}
                        {canManageAdminRoles && (
                          <>
                            <button
                              type="button"
                              onClick={() => openEdit(emp)}
                              className="p-2 text-slate-600 hover:text-[#0F2744] rounded-lg inline-flex items-center"
                              title="Edit employee"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleStatus(emp)}
                              className="p-2 text-slate-600 hover:text-red-700 rounded-lg inline-flex items-center ml-1"
                              title={emp.status === 'Active' ? 'Deactivate' : 'Activate'}
                            >
                              {emp.status === 'Active' ? (
                                <UserX className="w-3.5 h-3.5" />
                              ) : (
                                <UserCheck className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
            <span>
              Page {page} of {totalPages} ({filtered.length} records)
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1 border border-slate-200 rounded disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 border border-slate-200 rounded disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Add / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">
                {editingEmp ? 'Edit Employee Record' : 'Add Employee & Assign Role'}
              </h3>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {error && (
              <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs">
                {error}
              </div>
            )}

            <form onSubmit={handleSave} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Employee Code
                  </label>
                  <input
                    type="text"
                    required
                    value={employeeCode}
                    onChange={(e) => setEmployeeCode(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Corporate Email (Used for Login Matching)
                  </label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Phone Number
                  </label>
                  <input
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Authorized Role
                  </label>
                  <select
                    value={role}
                    onChange={(e) => handleRoleChange(e.target.value as AssignableRole)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Department
                  </label>
                  <input
                    type="text"
                    required
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Account Status
                  </label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as Employee['status'])}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                    <option value="On Leave">On Leave</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Assigned Territory
                  </label>
                  <input
                    type="text"
                    value={territory}
                    onChange={(e) => setTerritory(e.target.value)}
                    placeholder="e.g. Mumbai South & Dadar"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Employee Post / Designation
                  </label>
                  <select
                    value={useCustomPost ? '__CUSTOM__' : designation}
                    onChange={(e) => {
                      if (e.target.value === '__CUSTOM__') {
                        setUseCustomPost(true);
                      } else {
                        setUseCustomPost(false);
                        setDesignation(e.target.value);
                      }
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {EMPLOYEE_POST_OPTIONS.map((post) => (
                      <option key={post} value={post}>
                        {post}
                      </option>
                    ))}
                    <option value="__CUSTOM__">Custom Post...</option>
                  </select>
                  {useCustomPost && (
                    <input
                      type="text"
                      value={designation}
                      onChange={(e) => setDesignation(e.target.value)}
                      placeholder="Enter custom post / designation"
                      className="mt-2 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  )}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Geofence Lat
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={geofenceLat}
                    onChange={(e) => setGeofenceLat(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Geofence Lng
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={geofenceLng}
                    onChange={(e) => setGeofenceLng(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Radius (m)
                  </label>
                  <input
                    type="number"
                    min={50}
                    value={geofenceRadiusM}
                    onChange={(e) => setGeofenceRadiusM(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg disabled:opacity-60"
                >
                  {saving ? 'Saving...' : editingEmp ? 'Save Changes' : 'Create Employee'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
