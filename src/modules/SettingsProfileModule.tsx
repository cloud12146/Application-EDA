import React, { useEffect, useState } from 'react';
import { sendPasswordResetEmail } from 'firebase/auth';
import { deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import {
  CheckCircle2,
  Database,
  Fingerprint,
  Globe,
  KeyRound,
  Lock,
  Save,
  Shield,
  ShieldCheck,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  BiometricSupportStatus,
  checkBiometricSupport,
  clearDeviceBiometricBinding,
  enrollDeviceBiometrics,
  getDeviceBiometricBinding,
  LocalBiometricBinding,
  touchBiometricLastUsed,
  updateLockOnReopenPreference,
  updateSensitiveModuleLockPreference,
  verifyDeviceBiometrics,
} from '../lib/biometrics';
import { clearSampleDemoData, seedSampleDemoData } from '../lib/demoSeed';
import { getRoleDisplayLabel } from '../lib/roles';
import { formatTimestamp } from '../lib/utils';
import { BiometricCredential, CompanySettings, UserAccount } from '../types/erp';

export const SettingsModule: React.FC<{
  currentUser: UserAccount;
  settings: CompanySettings | null;
  biometricCredentials?: BiometricCredential[];
  onLockWithBiometrics?: () => void;
  onBiometricBindingChange?: () => void;
  onEnrolledHere?: () => void;
}> = ({
  currentUser,
  settings,
  biometricCredentials = [],
  onLockWithBiometrics,
  onBiometricBindingChange,
  onEnrolledHere,
}) => {
  const [officeLat, setOfficeLat] = useState(String(settings?.officeLat ?? 19.076));
  const [officeLng, setOfficeLng] = useState(String(settings?.officeLng ?? 72.8777));
  const [officeRadiusM, setOfficeRadiusM] = useState(String(settings?.officeRadiusM ?? 500));
  const [workStart, setWorkStart] = useState(settings?.workStartTime || '09:30');
  const [workEnd, setWorkEnd] = useState(settings?.workEndTime || '18:30');
  const [expiryDays, setExpiryDays] = useState(String(settings?.expiryAlertDays ?? 90));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMsg('');
    setErr('');
    try {
      await setDoc(
        doc(db, 'settings', 'company'),
        {
          companyName: 'Glacetor Remedies Pvt. Ltd.',
          ownerUid: settings?.ownerUid || currentUser.uid,
          ownerEmail: settings?.ownerEmail || currentUser.email,
          officeLat: Number(officeLat) || 19.076,
          officeLng: Number(officeLng) || 72.8777,
          officeRadiusM: Math.max(50, Number(officeRadiusM) || 500),
          workStartTime: workStart,
          workEndTime: workEnd,
          lowStockDefault: 100,
          expiryAlertDays: Math.max(15, Number(expiryDays) || 90),
          currencySymbol: '₹',
          demoDataSeeded: Boolean(settings?.demoDataSeeded),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      setMsg('Company settings saved.');
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'settings/company');
    } finally {
      setSaving(false);
    }
  };

  const handleSeedDemo = async () => {
    setSaving(true);
    setMsg('');
    setErr('');
    try {
      await seedSampleDemoData(currentUser.uid, currentUser.displayName);
      setMsg('Sample demo records created (clearly marked as Demo for testing).');
    } catch (error: any) {
      setErr(error?.message || 'Could not seed sample demo data.');
    } finally {
      setSaving(false);
    }
  };

  const handleClearDemo = async () => {
    setSaving(true);
    setMsg('');
    setErr('');
    try {
      await clearSampleDemoData();
      setMsg('All sample demo records removed. Production company records remain untouched.');
    } catch (error: any) {
      setErr(error?.message || 'Could not clear demo records.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-lg font-bold text-slate-900">
          Company ERP Settings & Deployment
        </h2>
        <p className="text-xs text-slate-500">
          Configure corporate geofence, work hours, separated demo testing data, and Firebase Hosting setup.
        </p>
      </div>

      {msg && (
        <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{msg}</span>
        </div>
      )}
      {err && (
        <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs">
          {err}
        </div>
      )}

      <form
        onSubmit={handleSaveSettings}
        className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
      >
        <h3 className="text-sm font-semibold text-slate-900">
          Headquarters Geofence & Shift Policy
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              HQ Latitude
            </label>
            <input
              type="number"
              step="any"
              value={officeLat}
              onChange={(e) => setOfficeLat(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              HQ Longitude
            </label>
            <input
              type="number"
              step="any"
              value={officeLng}
              onChange={(e) => setOfficeLng(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Geofence Radius (m)
            </label>
            <input
              type="number"
              min={50}
              value={officeRadiusM}
              onChange={(e) => setOfficeRadiusM(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Shift Start Time
            </label>
            <input
              type="time"
              value={workStart}
              onChange={(e) => setWorkStart(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Shift End Time
            </label>
            <input
              type="time"
              value={workEnd}
              onChange={(e) => setWorkEnd(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Expiry Alert Window (Days)
            </label>
            <input
              type="number"
              min={15}
              value={expiryDays}
              onChange={(e) => setExpiryDays(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg"
        >
          <Save className="w-4 h-4" />
          Save Settings
        </button>
      </form>

      {/* Separated Sample Demo Data Controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Database className="w-4 h-4 text-[#0F2744]" />
          Sample Demo Data (Isolated from Real Company Records)
        </div>
        <p className="text-xs text-slate-600 leading-relaxed">
          Load sample pharmaceutical batches, territories, orders, and staff records tagged with{' '}
          <code className="font-mono bg-slate-100 px-1 rounded">isDemo: true</code> for testing workflows. You can clear all demo records anytime without affecting real company data.
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <button
            type="button"
            disabled={saving}
            onClick={handleSeedDemo}
            className="px-4 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg"
          >
            Load Sample Demo Data
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleClearDemo}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded-lg"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear Demo Data
          </button>
        </div>
      </div>

      <BiometricSecurityCard
        currentUser={currentUser}
        credentials={biometricCredentials}
        showAllCompanyDevices={true}
        onLockWithBiometrics={onLockWithBiometrics}
        onBiometricBindingChange={onBiometricBindingChange}
        onEnrolledHere={onEnrolledHere}
      />

      {/* Firebase Hosting & Independent PWA Info */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-2 text-xs text-slate-600">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Globe className="w-4 h-4 text-[#0F2744]" />
          Firebase Hosting & Standalone PWA Deployment
        </div>
        <p>
          This application runs independently from your main company website and deploys directly to a free HTTPS Firebase-provided URL (<code className="font-mono">https://&lt;project-id&gt;.web.app</code>) without purchasing a custom domain:
        </p>
        <pre className="bg-slate-900 text-slate-100 p-3 rounded-lg font-mono text-[11px] overflow-x-auto">
{`npm run build
npx firebase init hosting   # public dir: dist, single-page app rewrite: Yes
npx firebase deploy --only hosting,firestore:rules`}
        </pre>
      </div>
    </div>
  );
};

export const ProfileModule: React.FC<{
  currentUser: UserAccount;
  biometricCredentials?: BiometricCredential[];
  onLockWithBiometrics?: () => void;
  onBiometricBindingChange?: () => void;
  onEnrolledHere?: () => void;
}> = ({
  currentUser,
  biometricCredentials = [],
  onLockWithBiometrics,
  onBiometricBindingChange,
  onEnrolledHere,
}) => {
  const [displayName, setDisplayName] = useState(currentUser.displayName);
  const [phone, setPhone] = useState(currentUser.phone || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMsg('');
    setErr('');
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), {
        displayName: displayName.trim() || currentUser.displayName,
        phone: phone.trim(),
        updatedAt: serverTimestamp(),
      });
      setMsg('Profile updated.');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${currentUser.uid}`);
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordReset = async () => {
    setMsg('');
    setErr('');
    try {
      await sendPasswordResetEmail(auth, currentUser.email);
      setMsg(`Password reset link sent to ${currentUser.email}.`);
    } catch (error: any) {
      setErr(error?.message || 'Unable to send password reset email.');
    }
  };

  return (
    <div className="space-y-5 max-w-xl">
      <div>
        <h2 className="text-lg font-bold text-slate-900">My Profile & Security</h2>
        <p className="text-xs text-slate-500">
          Manage your contact details and account credentials.
        </p>
      </div>

      {msg && (
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs">
          {msg}
        </div>
      )}
      {err && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs">
          {err}
        </div>
      )}

      <form
        onSubmit={handleSaveProfile}
        className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs p-3.5 rounded-lg bg-slate-50 border border-slate-200">
          <div>
            <span className="text-slate-500 block">Assigned Role &amp; Post</span>
            <strong className="text-[#0F2744]">
              {currentUser.designation &&
              currentUser.designation !== getRoleDisplayLabel(currentUser.role)
                ? `${currentUser.designation} (${getRoleDisplayLabel(currentUser.role)})`
                : getRoleDisplayLabel(currentUser.role)}
            </strong>
          </div>
          <div>
            <span className="text-slate-500 block">Corporate Email</span>
            <strong className="text-slate-900">{currentUser.email}</strong>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            Display Name
          </label>
          <input
            type="text"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            Contact Phone
          </label>
          <input
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <button
            type="button"
            onClick={handlePasswordReset}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-lg"
          >
            <KeyRound className="w-3.5 h-3.5" />
            Send Password Reset Email
          </button>

          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg"
          >
            {saving ? 'Saving...' : 'Save Profile'}
          </button>
        </div>
      </form>

      <BiometricSecurityCard
        currentUser={currentUser}
        credentials={biometricCredentials.filter((c) => c.userId === currentUser.uid)}
        showAllCompanyDevices={false}
        onLockWithBiometrics={onLockWithBiometrics}
        onBiometricBindingChange={onBiometricBindingChange}
        onEnrolledHere={onEnrolledHere}
      />
    </div>
  );
};

const BiometricSecurityCard: React.FC<{
  currentUser: UserAccount;
  credentials: BiometricCredential[];
  showAllCompanyDevices: boolean;
  onLockWithBiometrics?: () => void;
  onBiometricBindingChange?: () => void;
  onEnrolledHere?: () => void;
}> = ({
  currentUser,
  credentials,
  showAllCompanyDevices,
  onLockWithBiometrics,
  onBiometricBindingChange,
  onEnrolledHere,
}) => {
  const [support, setSupport] = useState<BiometricSupportStatus | null>(null);
  const [localBinding, setLocalBinding] = useState<LocalBiometricBinding | null>(() =>
    getDeviceBiometricBinding()
  );
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [verifiedThisVisit, setVerifiedThisVisit] = useState(false);
  const [bioMsg, setBioMsg] = useState('');
  const [bioErr, setBioErr] = useState('');

  useEffect(() => {
    checkBiometricSupport().then(setSupport);
  }, []);

  const isEnrolledHere = Boolean(
    localBinding && localBinding.userId === currentUser.uid
  );
  const myFirestoreCreds = credentials.filter((c) => c.userId === currentUser.uid);
  const linkedToFirestore = Boolean(
    isEnrolledHere &&
      myFirestoreCreds.some((c) => c.credentialId === localBinding?.credentialId)
  );

  const handleEnroll = async () => {
    setBusy(true);
    setBioMsg('');
    setBioErr('');
    try {
      const binding = await enrollDeviceBiometrics(currentUser, true);
      setLocalBinding(binding);
      setVerifiedThisVisit(true);
      onEnrolledHere?.();
      onBiometricBindingChange?.();
      setBioMsg(
        `Linked ${binding.deviceLabel} to your Firestore account (${currentUser.email}). "Lock App" and sensitive module protection are now enabled.`
      );
    } catch (error: any) {
      setBioErr(error?.message || 'Could not enroll device biometrics.');
    } finally {
      setBusy(false);
    }
  };

  const handleTestVerification = async () => {
    if (!localBinding) return;
    setTesting(true);
    setBioMsg('');
    setBioErr('');
    try {
      const res = await verifyDeviceBiometrics(localBinding.credentialId);
      await touchBiometricLastUsed(res.credentialId);
      setVerifiedThisVisit(true);
      setBioMsg(
        `Hardware verification succeeded on ${localBinding.deviceLabel} and updated Firestore last-used timestamp.`
      );
    } catch (error: any) {
      setBioErr(error?.message || 'Biometric test verification failed.');
    } finally {
      setTesting(false);
    }
  };

  const handleRevoke = async (cred: BiometricCredential) => {
    setBusy(true);
    setBioMsg('');
    setBioErr('');
    try {
      await deleteDoc(doc(db, 'biometricCredentials', cred.id));
      if (localBinding?.credentialId === cred.id) {
        clearDeviceBiometricBinding();
        setLocalBinding(null);
        setVerifiedThisVisit(false);
        onBiometricBindingChange?.();
      }
      setBioMsg(`Revoked biometric passkey for ${cred.deviceLabel}.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `biometricCredentials/${cred.id}`);
    } finally {
      setBusy(false);
    }
  };

  const handleToggleLockOnReopen = (checked: boolean) => {
    updateLockOnReopenPreference(checked);
    setLocalBinding(getDeviceBiometricBinding());
    onBiometricBindingChange?.();
    setBioMsg(
      checked
        ? 'App will require Fingerprint / Face ID when reopened.'
        : 'Automatic biometric prompt on reopen disabled.'
    );
  };

  const handleToggleSensitiveProtection = (checked: boolean) => {
    updateSensitiveModuleLockPreference(checked);
    setLocalBinding(getDeviceBiometricBinding());
    onBiometricBindingChange?.();
    setBioMsg(
      checked
        ? 'Sensitive module lock enabled for Employees, Payments, Expenses, Reports, Distributors, and Settings.'
        : 'Sensitive module lock disabled (full "Lock App" button remains available).'
    );
  };

  const step1Done = Boolean(support?.available);
  const step2Done = isEnrolledHere;
  const step3Done = isEnrolledHere && verifiedThisVisit;
  const step4Done = isEnrolledHere && Boolean(localBinding?.lockOnReopen || localBinding?.protectSensitiveModules);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <Fingerprint className="w-4 h-4 text-[#15803D]" />
            Biometric Authentication &amp; Setup Guide (Fingerprint / Face ID)
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Link your device&apos;s native biometric sensor with your Firestore account using WebAuthn passkeys to enable &ldquo;Lock App&rdquo; and guard sensitive ERP modules.
          </p>
        </div>

        {isEnrolledHere && onLockWithBiometrics && (
          <button
            type="button"
            onClick={onLockWithBiometrics}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg shrink-0 min-h-[38px]"
          >
            <Lock className="w-3.5 h-3.5" />
            Lock App Now
          </button>
        )}
      </div>

      {bioMsg && (
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{bioMsg}</span>
        </div>
      )}
      {bioErr && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs">
          {bioErr}
        </div>
      )}

      {support && !support.available && (
        <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs space-y-1">
          <div className="font-semibold">Hardware / Context Requirement</div>
          <p>{support.reason}</p>
          {support.isEmbeddedIframe && (
            <p className="text-[11px] text-amber-800">
              Tip: Embedded preview iframes can restrict WebAuthn prompts. Open this app directly in Chrome/Safari or install the PWA to enroll your phone&apos;s Fingerprint or Face ID.
            </p>
          )}
        </div>
      )}

      {/* 4-Step Setup Guide */}
      <div className="space-y-3">
        {/* Step 1 */}
        <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                step1Done
                  ? 'bg-[#15803D] text-white'
                  : 'bg-slate-200 text-slate-700'
              }`}
            >
              1
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                <Smartphone className="w-3.5 h-3.5 text-[#0F2744]" />
                Check Device Hardware &amp; Secure Context
              </div>
              <p className="text-[11px] text-slate-600 mt-0.5">
                Detected platform: <strong>{support?.platformLabel || 'Checking...'}</strong>. Ensure your phone or laptop has Fingerprint, Face ID, or Touch ID enabled in system settings.
              </p>
            </div>
          </div>
          <span
            className={`text-[11px] font-semibold shrink-0 ${
              step1Done ? 'text-[#15803D]' : 'text-amber-700'
            }`}
          >
            {step1Done ? 'Hardware Ready' : 'Action Required'}
          </span>
        </div>

        {/* Step 2 */}
        <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                step2Done
                  ? 'bg-[#15803D] text-white'
                  : 'bg-slate-200 text-slate-700'
              }`}
            >
              2
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-[#0F2744]" />
                Link Hardware Passkey to Firestore Account
              </div>
              <p className="text-[11px] text-slate-600 mt-0.5">
                {isEnrolledHere
                  ? `Linked on ${localBinding?.deviceLabel} to ${currentUser.email}${linkedToFirestore ? ' (synced with Firestore)' : ''}. Biometrics stay inside your device hardware chip.`
                  : `Creates a WebAuthn platform passkey bound to ${currentUser.email} and registers the credential ID in Firestore. No passwords or raw fingerprints are stored.`}
              </p>
            </div>
          </div>
          {!isEnrolledHere ? (
            <button
              type="button"
              disabled={busy || !support?.available}
              onClick={handleEnroll}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg min-h-[40px] disabled:opacity-50 shrink-0"
            >
              <Fingerprint className="w-4 h-4" />
              {busy ? 'Linking...' : 'Link Fingerprint / Face ID'}
            </button>
          ) : (
            <span className="text-[11px] font-semibold text-[#15803D] shrink-0">
              Linked to Account
            </span>
          )}
        </div>

        {/* Step 3 */}
        <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                step3Done
                  ? 'bg-[#15803D] text-white'
                  : 'bg-slate-200 text-slate-700'
              }`}
            >
              3
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                <Fingerprint className="w-3.5 h-3.5 text-[#0F2744]" />
                Test Native Sensor Verification
              </div>
              <p className="text-[11px] text-slate-600 mt-0.5">
                Trigger a live Fingerprint / Face ID prompt to confirm unlocking works smoothly before locking the workspace.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!isEnrolledHere || testing || !support?.available}
            onClick={handleTestVerification}
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0F2744] bg-white border border-slate-300 hover:bg-slate-100 rounded-lg min-h-[38px] disabled:opacity-50 shrink-0"
          >
            <Fingerprint className="w-3.5 h-3.5 text-[#15803D]" />
            {testing ? 'Prompting Sensor...' : 'Test Fingerprint / Face ID'}
          </button>
        </div>

        {/* Step 4 */}
        <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-3">
          <div className="flex items-start gap-3">
            <div
              className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                step4Done
                  ? 'bg-[#15803D] text-white'
                  : 'bg-slate-200 text-slate-700'
              }`}
            >
              4
            </div>
            <div className="flex-1">
              <div className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-[#0F2744]" />
                Enable &lsquo;Lock App&rsquo; &amp; Sensitive Module Protection
              </div>
              <p className="text-[11px] text-slate-600 mt-0.5">
                Once linked, use the <strong>Lock</strong> / <strong>Lock App</strong> button in the navigation bar anytime, or require biometric verification before opening sensitive modules (Employees, Payments, Expenses, Reports, Distributors, Settings).
              </p>

              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="flex items-start gap-2.5 p-3 rounded-lg bg-white border border-slate-200 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={!isEnrolledHere}
                    checked={Boolean(isEnrolledHere && localBinding?.lockOnReopen)}
                    onChange={(e) => handleToggleLockOnReopen(e.target.checked)}
                    className="rounded border-slate-300 mt-0.5"
                  />
                  <div>
                    <span className="font-semibold text-slate-900 block">
                      Lock App on Reopen
                    </span>
                    <span className="text-[11px] text-slate-500">
                      Require Fingerprint / Face ID when reopening the PWA.
                    </span>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 p-3 rounded-lg bg-white border border-slate-200 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={!isEnrolledHere}
                    checked={Boolean(
                      isEnrolledHere && localBinding?.protectSensitiveModules !== false
                    )}
                    onChange={(e) => handleToggleSensitiveProtection(e.target.checked)}
                    className="rounded border-slate-300 mt-0.5"
                  />
                  <div>
                    <span className="font-semibold text-slate-900 block">
                      Guard Sensitive Modules
                    </span>
                    <span className="text-[11px] text-slate-500">
                      Prompt biometrics before viewing Employees, Finance, Reports, or Settings.
                    </span>
                  </div>
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>

      {credentials.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="text-xs font-semibold text-slate-700">
            {showAllCompanyDevices
              ? `Firestore-Linked Biometric Devices (${credentials.length})`
              : `My Linked Biometric Devices (${credentials.length})`}
          </div>
          <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
            {credentials.map((cred) => (
              <div
                key={cred.id}
                className="p-3 bg-white flex items-center justify-between gap-3 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-slate-900 truncate">
                    {cred.displayName} · {cred.deviceLabel}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {cred.email} · Last verified: {formatTimestamp(cred.lastUsedAt || cred.createdAt)}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleRevoke(cred)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 rounded-lg border border-red-200 shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
