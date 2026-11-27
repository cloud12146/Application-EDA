# Security Specification & Red-Team TDD Matrix — Glacetor Remedies BMS

## 1. Data Invariants
1. **No Self-Assigned Admin Privileges**: A user creating their own `/users/{uid}` document cannot set `role` to `Super Admin` or `Admin` unless `/settings/company` does not yet exist (atomic first-admin setup) or they are the verified bootstrap owner or an admin-invited email in `/employees`.
2. **PII Isolation**: `/users/{uid}` and `/employees/{id}` contain email, phone, and address PII. Blanket `allow read: if isSignedIn()` is strictly forbidden; non-admins can only read their own record (`userId == request.auth.uid` or email match on pending invite).
3. **Immutable Audit & Ownership**: `createdAt`, `userId`, `createdByUid`, `performedByUid` cannot be forged on create or reassigned on update by non-admins.
4. **Authorized Stock Modification**: Only `Super Admin`, `Admin`, `Zonal Sales Manager (ZSM)`, `Regional Sales Manager (RSM)`, `Area Sales Manager (ASM)` (`Manager`), or `Stock Manager` can modify `/products` directly; `Marketing Executive (ME)` (and `Marketing Sales Manager (MSM)` posts) and Distributors cannot mutate warehouse stock directly and can only submit authorized order/allocation flows or stock movement requests (`Pending Approval`).
5. **Strict List Query Enforcement**: Every `allow list` rule evaluates `resource.data` against `request.auth.uid` or role lookup so non-admins cannot scrape other employees' attendance, locations, tasks, or private orders.
6. **Temporal Integrity & String Size Bounds**: Every string field enforces `.size() <= MAX` and server timestamps (`request.time`) are validated on creates/updates.

## 2. "Dirty Dozen" Attack Payloads (Must Return PERMISSION_DENIED)
1. **Privilege Escalation on Signup**: Non-admin user writes `/users/{uid}` with `role: "Super Admin"` after `/settings/company` already exists.
2. **Shadow Field Injection**: Employee updates `/tasks/{taskId}` with `{ status: "In Progress", adminRemarks: "Approved", isVerified: true }` (extra unallowed key).
3. **Spoofed Unverified Email**: Request with `request.auth.token.email == "dp7037506@gmail.com"` and `email_verified == false`.
4. **Cross-Employee PII Scrape**: Field employee runs `getDocs(collection(db, "users"))` or `getDoc(doc(db, "employees", otherId))`.
5. **Stock Tampering by Field Rep**: Field employee directly updates `/products/{productId}` `availableStock: 99999`.
6. **Forged Attendance Check-In**: Employee creates `/attendance/{id}` with `userId: "someone_else_uid"`.
7. **Unauthorized Attendance Correction**: Employee updates their own `/attendance/{id}` `status: "Present"` and `correctedBy: "Admin"` after check-in.
8. **Task Approval Self-Stamp**: Employee updates `/tasks/{taskId}` directly to `status: "Approved"`.
9. **Path Variable Poisoning**: Request attempts write to `/tasks/${"a".repeat(200)}` (`>128` chars or invalid characters).
10. **Cross-Employee Location Snooping**: Field employee queries `/locations` without filtering to `userId == request.auth.uid`.
11. **Forged Payment Receipt**: Distributor creates `/payments/{id}` with `collectedByUid: "other_uid"`.
12. **Terminal Order Mutation**: Employee attempts to modify a `Delivered` or `Cancelled` order in `/salesOrders/{id}`.
