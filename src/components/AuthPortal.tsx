import React, { useEffect, useState } from 'react';
import {
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Fingerprint,
  KeyRound,
  Lock,
  LogOut,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import { auth, db, handleFirestoreError, isFirebaseConfigured, OperationType } from '../lib/firebase';
import {
  checkBiometricSupport,
  clearDeviceBiometricBinding,
  getDeviceBiometricBinding,
  LocalBiometricBinding,
  setSessionLockFlag,
  touchBiometricLastUsed,
  verifyDeviceBiometrics,
} from '../lib/biometrics';
import { logActivity } from '../lib/erpActions';
import { getRoleDisplayLabel } from '../lib/roles';
import { UserAccount } from '../types/erp';
import { BrandLoader, BrandMark } from './BrandMark';
import { PWAInstallButton } from './PWAInstallButton';

interface AuthPortalProps {
  firebaseUser: User | null;
  currentUser?: UserAccount | null;
  needsFirstAdminSetup: boolean;
  pendingApproval: boolean;
  accountDeactivated: boolean;
  biometricLocked?: boolean;
  onBootstrapComplete: () => void;
  onBiometricUnlock?: () => void;
}

export const AuthPortal: React.FC<AuthPortalProps> = ({
  firebaseUser,
  currentUser,
  needsFirstAdminSetup,
  pendingApproval,
  accountDeactivated,
  biometricLocked = false,
  onBootstrapComplete,
  onBiometricUnlock,
}) => {
  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');

  // Biometric WebAuthn state
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricPlatformLabel, setBiometricPlatformLabel] = useState('');
  const [localBinding, setLocalBinding] = useState<LocalBiometricBinding | null>(() =>
    getDeviceBiometricBinding()
  );
  const [verifiedBiometricEmail, setVerifiedBiometricEmail] = useState('');

  useEffect(() => {
    checkBiometricSupport().then((res) => {
      setBiometricAvailable(res.available);
      setBiometricPlatformLabel(res.platformLabel);
    });
    setLocalBinding(getDeviceBiometricBinding());
  }, [firebaseUser, biometricLocked]);

  // First-admin setup form state
  const [adminName, setAdminName] = useState(firebaseUser?.displayName || '');
  const [officeLat, setOfficeLat] = useState('19.0760');
  const [officeLng, setOfficeLng] = useState('72.8777');
  const [officeRadius, setOfficeRadius] = useState('500');

  if (!isFirebaseConfigured) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-xl w-full bg-white border border-slate-200 rounded-2xl p-8 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <BrandMark size={40} />
            <div>
              <h1 className="text-xl font-bold text-[#0F2744]">
                Glacetor Remedies Pvt. Ltd.
              </h1>
              <p className="text-xs text-slate-500">
                Firebase Backend Setup Required
              </p>
            </div>
          </div>
          <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-sm mb-4">
            Firebase credentials are not yet configured in{' '}
            <code className="font-mono text-xs bg-amber-100 px-1.5 py-0.5 rounded">
              firebase-applet-config.json
            </code>
            . Configure your Firebase project before signing in or saving company records.
          </div>
          <ol className="text-sm text-slate-600 space-y-2 list-decimal list-inside">
            <li>Provision Firebase Authentication, Cloud Firestore, and Storage.</li>
            <li>Enable Google Sign-In (and optionally Email/Password) in Firebase Auth.</li>
            <li>Deploy <code className="font-mono text-xs">firestore.rules</code> to protect company data.</li>
          </ol>
        </div>
      </div>
    );
  }

  const handleGoogleLogin = async (loginHint?: string) => {
    setErrorMsg('');
    setInfoMsg('');
    setLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters(
        loginHint
          ? { login_hint: loginHint, prompt: 'select_account' }
          : { prompt: 'select_account' }
      );
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Google sign-in failed. Please allow popups and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleUnlockSessionWithBiometrics = async () => {
    if (!currentUser || !localBinding) return;
    setErrorMsg('');
    setInfoMsg('');
    setLoading(true);
    try {
      const result = await verifyDeviceBiometrics(localBinding.credentialId);
      // Confirm credential has not been revoked remotely in Firestore
      const credSnap = await getDoc(doc(db, 'biometricCredentials', result.credentialId));
      if (!credSnap.exists() || credSnap.data()?.isActive !== true) {
        clearDeviceBiometricBinding();
        setLocalBinding(null);
        throw new Error(
          'This device biometric passkey was revoked. Please sign in again with your corporate credentials.'
        );
      }
      await touchBiometricLastUsed(result.credentialId);
      setSessionLockFlag(false);
      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action: 'Biometric Unlock',
        entityType: 'biometricCredentials',
        entityId: result.credentialId,
        details: `Unlocked PWA session with ${localBinding.deviceLabel}`,
      });
      onBiometricUnlock?.();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Biometric verification failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignedOutBiometricVerify = async () => {
    if (!localBinding) return;
    setErrorMsg('');
    setInfoMsg('');
    setLoading(true);
    try {
      const result = await verifyDeviceBiometrics(localBinding.credentialId);
      if (result.userVerified) {
        setVerifiedBiometricEmail(localBinding.email);
        setEmail(localBinding.email);
        setInfoMsg(
          `Fingerprint / Face ID verified for ${localBinding.displayName} (${localBinding.email}). Complete 1-tap Google Sign-In or enter your password to refresh your secure session.`
        );
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Biometric verification failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');
    if (!email.trim() || !password) {
      setErrorMsg('Please enter your corporate email and password.');
      return;
    }
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err: any) {
      const code = err?.code || '';
      if (code === 'auth/operation-not-allowed' || code === 'auth/configuration-not-found') {
        setErrorMsg(
          'Email/Password sign-in is not yet enabled in the Firebase Console. Please sign in with Google below or enable Email/Password under Firebase Console > Authentication > Sign-in method.'
        );
      } else if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
        setErrorMsg('Invalid email or password. Use Password Reset or sign in with Google.');
      } else {
        setErrorMsg(err?.message || 'Sign-in failed.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');
    if (!email.trim()) {
      setErrorMsg('Enter your registered corporate email address.');
      return;
    }
    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setInfoMsg('Password reset link sent to your email inbox.');
    } catch (err: any) {
      setErrorMsg(
        err?.message || 'Unable to send reset email. Ensure Email/Password provider is enabled.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleFirstAdminSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    setErrorMsg('');
    setLoading(true);

    const displayName = adminName.trim() || firebaseUser.displayName || 'Company Super Admin';
    const lat = Number(officeLat) || 19.076;
    const lng = Number(officeLng) || 72.8777;
    const radius = Math.max(50, Number(officeRadius) || 500);

    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'settings', 'company'), {
        companyName: 'Glacetor Remedies Pvt. Ltd.',
        ownerUid: firebaseUser.uid,
        ownerEmail: firebaseUser.email || '',
        officeLat: lat,
        officeLng: lng,
        officeRadiusM: radius,
        workStartTime: '09:30',
        workEndTime: '18:30',
        lowStockDefault: 100,
        expiryAlertDays: 90,
        currencySymbol: '₹',
        demoDataSeeded: false,
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'admins', firebaseUser.uid), {
        uid: firebaseUser.uid,
        email: firebaseUser.email || '',
        role: 'Super Admin',
        grantedAt: serverTimestamp(),
        grantedBy: 'first-admin-setup',
      });
      batch.set(doc(db, 'users', firebaseUser.uid), {
        uid: firebaseUser.uid,
        email: firebaseUser.email || '',
        displayName,
        role: 'Super Admin',
        isActive: true,
        department: 'Executive Administration',
        designation: 'Super Administrator',
        territory: 'Corporate HQ',
        fcmEnabled: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'employees', `emp_${firebaseUser.uid}`), {
        id: `emp_${firebaseUser.uid}`,
        uid: firebaseUser.uid,
        employeeCode: 'GLC-001',
        fullName: displayName,
        email: firebaseUser.email || '',
        role: 'Super Admin',
        department: 'Executive Administration',
        designation: 'Super Administrator',
        territory: 'Corporate HQ',
        geofenceLat: lat,
        geofenceLng: lng,
        geofenceRadiusM: radius,
        status: 'Active',
        joiningDate: new Date().toISOString().slice(0, 10),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      onBootstrapComplete();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/company');
    } finally {
      setLoading(false);
    }
  };

  if (firebaseUser && needsFirstAdminSetup) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-lg w-full bg-white border border-slate-200 rounded-2xl p-6 md:p-8 shadow-sm">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <BrandMark size={40} />
              <div>
                <h1 className="text-lg font-bold text-[#0F2744]">
                  First-Admin Company Setup
                </h1>
                <p className="text-xs text-slate-500">
                  Glacetor Remedies Pvt. Ltd. · Secure Bootstrap
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => signOut(auth)}
              className="text-xs font-medium text-slate-500 hover:text-slate-900 flex items-center gap-1"
            >
              <LogOut className="w-3.5 h-3.5" /> Sign Out
            </button>
          </div>

          <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs leading-relaxed mb-5">
            No Super Admin has been configured yet. Completing this setup binds{' '}
            <strong className="font-semibold">{firebaseUser.email}</strong> as the authorized{' '}
            <strong className="font-semibold">Super Admin</strong> and permanently locks self-registration of admin roles.
          </div>

          {errorMsg && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          <form onSubmit={handleFirstAdminSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Super Admin Full Name
              </label>
              <input
                type="text"
                required
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                placeholder="e.g. Rajesh Sharma"
                className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2744]"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  HQ Latitude
                </label>
                <input
                  type="number"
                  step="any"
                  required
                  value={officeLat}
                  onChange={(e) => setOfficeLat(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2744]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  HQ Longitude
                </label>
                <input
                  type="number"
                  step="any"
                  required
                  value={officeLng}
                  onChange={(e) => setOfficeLng(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2744]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Geofence (m)
                </label>
                <input
                  type="number"
                  min={50}
                  required
                  value={officeRadius}
                  onChange={(e) => setOfficeRadius(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2744]"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 text-sm font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {loading ? (
                <BrandLoader inline size={18} />
              ) : (
                <ShieldCheck className="w-4 h-4" />
              )}
              {loading ? 'Provisioning Super Admin...' : 'Initialize Company & Claim Super Admin'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (firebaseUser && currentUser && biometricLocked && localBinding && localBinding.userId === currentUser.uid) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-2xl p-6 md:p-8 shadow-sm text-center space-y-5">
          <div className="flex flex-col items-center gap-2">
            <BrandMark size={44} />
            <div className="text-xs font-semibold uppercase tracking-wider text-[#15803D]">
              Glacetor Remedies Pvt. Ltd.
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
            <div className="text-base font-bold text-[#0F2744]">
              {currentUser.displayName}
            </div>
            <div className="text-xs text-slate-600 mt-0.5">
              {currentUser.designation &&
              currentUser.designation !== getRoleDisplayLabel(currentUser.role)
                ? `${currentUser.designation} · ${getRoleDisplayLabel(currentUser.role)}`
                : getRoleDisplayLabel(currentUser.role)}{' '}
              · {currentUser.email}
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              Protected by {localBinding.deviceLabel}
            </div>
          </div>

          {errorMsg && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs flex items-start gap-2 text-left">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          <button
            type="button"
            disabled={loading}
            onClick={handleUnlockSessionWithBiometrics}
            className="w-full py-3.5 px-4 text-sm font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-xl transition-colors flex items-center justify-center gap-2.5 min-h-[48px] disabled:opacity-60"
          >
            {loading ? (
              <BrandLoader inline size={20} />
            ) : (
              <Fingerprint className="w-5 h-5" />
            )}
            {loading ? 'Verifying Biometrics...' : 'Unlock with Fingerprint / Face ID'}
          </button>

          <button
            type="button"
            onClick={async () => {
              setSessionLockFlag(false);
              await signOut(auth);
            }}
            className="w-full py-2.5 text-xs font-medium text-slate-600 hover:text-slate-900 flex items-center justify-center gap-1.5"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out &amp; Use Google / Password Instead
          </button>
        </div>
      </div>
    );
  }

  if (firebaseUser && (pendingApproval || accountDeactivated)) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-2xl p-8 shadow-sm text-center">
          <div className="flex justify-center mb-4">
            <BrandMark size={48} />
          </div>
          <h1 className="text-lg font-bold text-[#0F2744] mb-2">
            {accountDeactivated ? 'Account Deactivated' : 'Role Assignment Pending'}
          </h1>
          <p className="text-sm text-slate-600 mb-6 leading-relaxed">
            {accountDeactivated ? (
              <>
                Your account (<span className="font-medium">{firebaseUser.email}</span>) has been deactivated by an administrator. Contact Glacetor Remedies IT/HR for reactivation.
              </>
            ) : (
              <>
                You are signed in as <span className="font-medium">{firebaseUser.email}</span>. For security, employees cannot self-assign roles. Ask your Glacetor Remedies Admin to add your email in the Employees directory and assign your role.
              </>
            )}
          </p>
          <button
            type="button"
            onClick={() => signOut(auth)}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign Out & Switch Account
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col lg:flex-row">
      {/* Left Corporate Context Column */}
      <div className="lg:w-5/12 bg-[#0F2744] text-white p-8 lg:p-12 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between gap-4 mb-8">
            <div className="flex items-center gap-3">
              <BrandMark size={44} />
              <div>
                <div className="text-base font-bold tracking-tight">
                  Glacetor Remedies Pvt. Ltd.
                </div>
                <div className="text-xs text-slate-300">
                  Business Management System
                </div>
              </div>
            </div>
            <PWAInstallButton />
          </div>

          <div className="mb-7 inline-block rounded-xl bg-white px-4 py-2.5 border border-white/20 shadow-sm">
            <img
              src="/glacetor-logo-white.png"
              alt="Glacetor Remedies Pvt. Ltd. Logo"
              className="h-12 w-auto object-contain"
            />
          </div>

          <h2 className="text-2xl lg:text-3xl font-bold tracking-tight leading-snug mb-4 [text-wrap:balance]">
            Unified Pharmaceutical ERP & Field Force Operations
          </h2>
          <p className="text-sm text-slate-300 leading-relaxed max-w-md">
            Authorized role-based workspace for field medical representatives, warehouse stock managers, distributors, and corporate leadership.
          </p>
        </div>

        <div className="mt-10 pt-6 border-t border-white/15 grid grid-cols-2 gap-4 text-xs">
          <div>
            <div className="font-semibold text-white mb-1">Field Operations</div>
            <div className="text-slate-300">
              Permission-based GPS check-in, route history & geofenced attendance
            </div>
          </div>
          <div>
            <div className="font-semibold text-white mb-1">Pharma Inventory</div>
            <div className="text-slate-300">
              Batch-level expiry tracking, atomic stock ledger & distributor dispatch
            </div>
          </div>
        </div>
      </div>

      {/* Right Authentication Form Column */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl p-6 md:p-8 shadow-sm">
          <div className="mb-6">
            <div className="flex items-center gap-2 text-xs font-medium text-[#15803D] mb-1">
              <Building2 className="w-3.5 h-3.5" />
              <span>Authorized Corporate Portal</span>
            </div>
            <h1 className="text-xl font-bold text-slate-900">
              {mode === 'login' ? 'Sign in to your workspace' : 'Reset your password'}
            </h1>
            <p className="text-xs text-slate-500 mt-1">
              Role permissions are enforced automatically by Firebase Security Rules.
            </p>
          </div>

          {errorMsg && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {infoMsg && (
            <div className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{infoMsg}</span>
            </div>
          )}

          {localBinding && (
            <div className="mb-5 p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-bold text-[#0F2744] truncate">
                    {localBinding.displayName}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {localBinding.email} · {localBinding.deviceLabel}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    clearDeviceBiometricBinding();
                    setLocalBinding(null);
                    setVerifiedBiometricEmail('');
                  }}
                  className="text-[11px] text-slate-400 hover:text-slate-700 shrink-0"
                >
                  Forget
                </button>
              </div>

              {verifiedBiometricEmail ? (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => handleGoogleLogin(verifiedBiometricEmail)}
                  className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg transition-colors flex items-center justify-center gap-2 min-h-[44px]"
                >
                  <ShieldCheck className="w-4 h-4" />
                  Continue 1-Tap as {verifiedBiometricEmail}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={loading || !biometricAvailable}
                  onClick={handleSignedOutBiometricVerify}
                  className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg transition-colors flex items-center justify-center gap-2 min-h-[44px] disabled:opacity-50"
                >
                  <Fingerprint className="w-4 h-4" />
                  {biometricAvailable
                    ? 'Sign in with Fingerprint / Face ID'
                    : `Biometrics Unavailable (${biometricPlatformLabel || 'Browser Restricted'})`}
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => handleGoogleLogin(verifiedBiometricEmail || undefined)}
            disabled={loading}
            className="w-full py-2.5 px-4 border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 font-medium text-sm rounded-lg transition-colors flex items-center justify-center gap-2.5 mb-5 min-h-[44px]"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
              />
              <path
                fill="#FBBC05"
                d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
              />
            </svg>
            <span>Continue with Google Workspace</span>
          </button>

          <div className="relative flex items-center justify-center mb-5">
            <div className="border-t border-slate-200 w-full" />
            <span className="bg-white px-3 text-xs text-slate-400 whitespace-nowrap">
              or corporate credentials
            </span>
            <div className="border-t border-slate-200 w-full" />
          </div>

          {mode === 'login' ? (
            <form onSubmit={handleEmailLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Corporate Email
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@glacetorremedies.com"
                    className="w-full pl-9 pr-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2744]"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-700">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('reset');
                      setErrorMsg('');
                      setInfoMsg('');
                    }}
                    className="text-xs text-[#0F2744] hover:underline font-medium"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full pl-9 pr-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2744]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg transition-colors min-h-[44px] flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {loading && <BrandLoader inline size={18} />}
                <span>{loading ? 'Signing in...' : 'Sign In'}</span>
              </button>
            </form>
          ) : (
            <form onSubmit={handlePasswordReset} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Registered Email
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@glacetorremedies.com"
                    className="w-full pl-9 pr-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2744]"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg transition-colors min-h-[44px] flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {loading && <BrandLoader inline size={18} />}
                <span>{loading ? 'Sending...' : 'Send Password Reset Email'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setErrorMsg('');
                  setInfoMsg('');
                }}
                className="w-full py-2 text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                Back to Sign In
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
