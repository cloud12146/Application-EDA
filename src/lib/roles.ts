import { UserRole } from '../types/erp';

export type AssignableRole = Exclude<UserRole, 'Pending'>;

export const MANAGEMENT_ROLES: readonly string[] = [
  'Super Admin',
  'Admin',
  'Zonal Sales Manager (ZSM)',
  'Regional Sales Manager (RSM)',
  'Area Sales Manager (ASM)',
  'Zonal Sales Manager',
  'Area Sales Manager',
  'RSM (Zonal Sales Manager)',
  'Manager',
];

export const STOCK_AUTHORIZED_ROLES: readonly string[] = [
  ...MANAGEMENT_ROLES,
  'Stock Manager',
];

export const ASSIGNABLE_ROLES: AssignableRole[] = [
  'Marketing Executive (ME)',
  'Area Sales Manager (ASM)',
  'Regional Sales Manager (RSM)',
  'Zonal Sales Manager (ZSM)',
  'Stock Manager',
  'Distributor',
  'Admin',
  'Super Admin',
];

export const FIELD_EMPLOYEE_POST_OPTIONS: string[] = [
  'Marketing Executive (ME)',
  'Marketing Sales Manager (MSM)',
  'Medical Representative (MR)',
  'Senior Medical Representative (Sr. MR)',
  'Territory Business Executive (TBE)',
];

export const EMPLOYEE_POST_OPTIONS: string[] = [
  'Marketing Executive (ME)',
  'Marketing Sales Manager (MSM)',
  'Medical Representative (MR)',
  'Senior Medical Representative (Sr. MR)',
  'Territory Business Executive (TBE)',
  'Area Sales Manager (ASM)',
  'Regional Sales Manager (RSM)',
  'Zonal Sales Manager (ZSM)',
  'Warehouse & Batch Lead',
  'Authorized Distributor',
  'Administrator',
  'Super Administrator',
];

export function isManagementRole(role?: string | null): boolean {
  return Boolean(role && MANAGEMENT_ROLES.includes(role));
}

export function isStockAuthorizedRole(role?: string | null): boolean {
  return Boolean(role && STOCK_AUTHORIZED_ROLES.includes(role));
}

export function getRoleDisplayLabel(role?: string | null): string {
  if (!role) return '';
  if (role === 'Field Sales Employee') return 'Marketing Executive (ME)';
  if (role === 'Manager' || role === 'Area Sales Manager') {
    return 'Area Sales Manager (ASM)';
  }
  if (role === 'Zonal Sales Manager') return 'Zonal Sales Manager (ZSM)';
  if (role === 'RSM (Zonal Sales Manager)') return 'Regional Sales Manager (RSM)';
  return role;
}

export function normalizeRoleForEdit(role: AssignableRole): AssignableRole {
  if (role === 'Field Sales Employee') return 'Marketing Executive (ME)';
  if (role === 'Manager' || role === 'Area Sales Manager') {
    return 'Area Sales Manager (ASM)';
  }
  if (role === 'Zonal Sales Manager') return 'Zonal Sales Manager (ZSM)';
  if (role === 'RSM (Zonal Sales Manager)') return 'Regional Sales Manager (RSM)';
  return role;
}

export function normalizePostForEdit(post: string): string {
  const trimmed = post.trim();
  const legacyMap: Record<string, string> = {
    'Marketing Executive': 'Marketing Executive (ME)',
    'Marketing Sales Manager': 'Marketing Sales Manager (MSM)',
    'Medical Representative': 'Medical Representative (MR)',
    'Senior Medical Representative': 'Senior Medical Representative (Sr. MR)',
    'Territory Business Executive': 'Territory Business Executive (TBE)',
    'Area Sales Manager': 'Area Sales Manager (ASM)',
    'Zonal Sales Manager': 'Zonal Sales Manager (ZSM)',
    'RSM (Zonal Sales Manager)': 'Regional Sales Manager (RSM)',
  };
  return legacyMap[trimmed] || trimmed;
}

export function getDefaultPostForRole(role: AssignableRole): string {
  switch (role) {
    case 'Zonal Sales Manager (ZSM)':
    case 'Zonal Sales Manager':
      return 'Zonal Sales Manager (ZSM)';
    case 'Regional Sales Manager (RSM)':
    case 'RSM (Zonal Sales Manager)':
      return 'Regional Sales Manager (RSM)';
    case 'Area Sales Manager (ASM)':
    case 'Area Sales Manager':
    case 'Manager':
      return 'Area Sales Manager (ASM)';
    case 'Stock Manager':
      return 'Warehouse & Batch Lead';
    case 'Distributor':
      return 'Authorized Distributor';
    case 'Admin':
      return 'Administrator';
    case 'Super Admin':
      return 'Super Administrator';
    case 'Marketing Executive (ME)':
    case 'Field Sales Employee':
    default:
      return 'Marketing Executive (ME)';
  }
}

export function getDefaultDepartmentForRole(role: AssignableRole): string {
  switch (role) {
    case 'Zonal Sales Manager (ZSM)':
    case 'Zonal Sales Manager':
      return 'Zonal Sales';
    case 'Regional Sales Manager (RSM)':
    case 'RSM (Zonal Sales Manager)':
      return 'Regional Sales';
    case 'Area Sales Manager (ASM)':
    case 'Area Sales Manager':
    case 'Manager':
      return 'Area Sales';
    case 'Stock Manager':
      return 'Central Warehouse';
    case 'Distributor':
      return 'Distribution';
    case 'Admin':
    case 'Super Admin':
      return 'Executive Administration';
    case 'Marketing Executive (ME)':
    case 'Field Sales Employee':
    default:
      return 'Field Sales';
  }
}
