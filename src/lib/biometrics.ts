import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { logActivity } from './erpActions';
import { UserAccount } from '../types/erp';

const STORAGE_KEY = 'glacetor_biometric_device_v1';
const LOCK_SESSION_KEY = 'glacetor_biometric_locked_v1';

export interface LocalBiometricBinding {
  credentialId: string;
  userId: string;
  email: string;
  displayName: string;
  role: string;
  deviceLabel: string;
  lockOnReopen: boolean;
  protectSensitiveModules?: boolean;
  enrolledAt: string;
}

export const SENSITIVE_MODULE_TABS = new Set<string>([
  'employees',
  'payments',
  'expenses',
  'my-expenses',
  'reports',
  'settings',
  'distributors',
]);

export interface BiometricSupportStatus {
  available: boolean;
  platformLabel: string;
  isEmbeddedIframe?: boolean;
  reason?: string;
}

export function detectDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Mobile / Desktop Device';
  const ua = navigator.userAgent || '';
  if (/iphone/i.test(ua)) return 'iPhone (Face ID / Touch ID)';
  if (/ipad/i.test(ua)) return 'iPad (Face ID / Touch ID)';
  if (/android/i.test(ua)) return 'Android Device (Fingerprint / Biometrics)';
  if (/macintosh|mac os x/i.test(ua)) return 'Mac (Touch ID)';
  if (/windows/i.test(ua)) return 'Windows PC (Windows Hello)';
  return 'Platform Biometric Authenticator';
}

export function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBuffer(base64Url: string): ArrayBuffer {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const base64 = padded + '='.repeat(padLen);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function checkBiometricSupport(): Promise<BiometricSupportStatus> {
  const platformLabel = detectDeviceLabel();
  if (typeof window === 'undefined') {
    return { available: false, platformLabel, reason: 'Browser environment unavailable.' };
  }
  const isEmbeddedIframe = (() => {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  })();
  if (!window.isSecureContext) {
    return {
      available: false,
      platformLabel,
      isEmbeddedIframe,
      reason: 'Biometric authentication requires HTTPS or an installed PWA.',
    };
  }
  if (typeof window.PublicKeyCredential === 'undefined' || !navigator.credentials) {
    return {
      available: false,
      platformLabel,
      isEmbeddedIframe,
      reason: 'WebAuthn biometric API is not supported on this browser.',
    };
  }
  try {
    const uvpa = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!uvpa) {
      return {
        available: false,
        platformLabel,
        isEmbeddedIframe,
        reason:
          'No Fingerprint, Face ID, or device screen-lock authenticator was detected on this device.',
      };
    }
    return { available: true, platformLabel, isEmbeddedIframe };
  } catch {
    return {
      available: false,
      platformLabel,
      isEmbeddedIframe,
      reason:
        'Biometric authenticator check is blocked in this embedded preview. Open the standalone PWA link to use Fingerprint / Face ID.',
    };
  }
}

export function getDeviceBiometricBinding(): LocalBiometricBinding | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalBiometricBinding;
    if (!parsed?.credentialId || !parsed?.userId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveDeviceBiometricBinding(binding: LocalBiometricBinding): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(binding));
}

export function updateLockOnReopenPreference(enabled: boolean): void {
  const current = getDeviceBiometricBinding();
  if (!current) return;
  saveDeviceBiometricBinding({ ...current, lockOnReopen: enabled });
}

export function updateSensitiveModuleLockPreference(enabled: boolean): void {
  const current = getDeviceBiometricBinding();
  if (!current) return;
  saveDeviceBiometricBinding({ ...current, protectSensitiveModules: enabled });
}

export function clearDeviceBiometricBinding(): void {
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(LOCK_SESSION_KEY);
}

export function getSessionLockFlag(): boolean {
  try {
    return sessionStorage.getItem(LOCK_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSessionLockFlag(locked: boolean): void {
  try {
    if (locked) {
      sessionStorage.setItem(LOCK_SESSION_KEY, '1');
    } else {
      sessionStorage.removeItem(LOCK_SESSION_KEY);
    }
  } catch {
    // non-blocking
  }
}

function translateWebAuthnError(err: any): string {
  const name = err?.name || '';
  const msg = String(err?.message || '');
  if (name === 'NotAllowedError') {
    if (msg.toLowerCase().includes('permissions policy') || msg.toLowerCase().includes('feature')) {
      return 'Biometric prompt was blocked by an embedded iframe policy. Open the standalone app URL in Chrome/Safari or install the PWA.';
    }
    return 'Biometric verification was cancelled or timed out. Please try again.';
  }
  if (name === 'SecurityError') {
    return 'Biometric authentication requires opening the app on its direct HTTPS domain or installed PWA.';
  }
  if (name === 'InvalidStateError') {
    return 'This device is already enrolled with a passkey for this account.';
  }
  if (name === 'NotSupportedError') {
    return 'This device does not support platform Fingerprint / Face ID passkeys.';
  }
  return msg || 'Biometric verification failed.';
}

export async function enrollDeviceBiometrics(
  user: UserAccount,
  lockOnReopen = true
): Promise<LocalBiometricBinding> {
  const support = await checkBiometricSupport();
  if (!support.available) {
    throw new Error(support.reason || 'Biometric authenticator unavailable.');
  }

  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  const userIdBytes = new TextEncoder().encode(user.uid);
  const deviceLabel = detectDeviceLabel();

  let credential: Credential | null = null;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: {
          name: 'Glacetor Remedies BMS',
          id: window.location.hostname,
        },
        user: {
          id: userIdBytes,
          name: user.email,
          displayName: user.displayName,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
          requireResidentKey: false,
        },
        timeout: 60000,
        attestation: 'none',
      },
    });
  } catch (err) {
    throw new Error(translateWebAuthnError(err));
  }

  if (!credential || credential.type !== 'public-key') {
    throw new Error('Device did not return a valid biometric credential.');
  }

  const pkCred = credential as PublicKeyCredential;
  const credentialId = bufferToBase64Url(pkCred.rawId);
  if (!credentialId || credentialId.length > 128) {
    throw new Error('Unexpected credential identifier length from device authenticator.');
  }

  await setDoc(doc(db, 'biometricCredentials', credentialId), {
    id: credentialId,
    credentialId,
    userId: user.uid,
    email: user.email,
    displayName: user.displayName.slice(0, 120),
    deviceLabel: deviceLabel.slice(0, 120),
    isActive: true,
    lastUsedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
  });

  const binding: LocalBiometricBinding = {
    credentialId,
    userId: user.uid,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    deviceLabel,
    lockOnReopen,
    protectSensitiveModules: true,
    enrolledAt: new Date().toISOString(),
  };
  saveDeviceBiometricBinding(binding);

  await logActivity({
    userId: user.uid,
    employeeName: user.displayName,
    action: 'Biometric Enrolled',
    entityType: 'biometricCredentials',
    entityId: credentialId,
    details: `Enabled Fingerprint / Face ID login on ${deviceLabel}`,
  });

  return binding;
}

export async function verifyDeviceBiometrics(
  expectedCredentialId?: string
): Promise<{ credentialId: string; userVerified: boolean }> {
  const support = await checkBiometricSupport();
  if (!support.available) {
    throw new Error(support.reason || 'Biometric authenticator unavailable.');
  }

  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);

  let assertion: Credential | null = null;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: window.location.hostname,
        allowCredentials: expectedCredentialId
          ? [
              {
                type: 'public-key',
                id: base64UrlToBuffer(expectedCredentialId),
                transports: ['internal'],
              },
            ]
          : undefined,
        userVerification: 'required',
        timeout: 60000,
      },
    });
  } catch (err) {
    throw new Error(translateWebAuthnError(err));
  }

  if (!assertion || assertion.type !== 'public-key') {
    throw new Error('Biometric verification failed.');
  }

  const pkAssertion = assertion as PublicKeyCredential;
  const response = pkAssertion.response as AuthenticatorAssertionResponse;
  const authData = new Uint8Array(response.authenticatorData);
  // WebAuthn spec: byte 32 contains flags; bit 2 (0x04) = User Verified (UV)
  const userVerified = authData.length > 32 && (authData[32] & 0x04) !== 0;
  if (!userVerified) {
    throw new Error('Device did not confirm biometric user verification (Fingerprint / Face ID).');
  }

  const returnedId = bufferToBase64Url(pkAssertion.rawId);
  if (expectedCredentialId && returnedId !== expectedCredentialId) {
    throw new Error('Returned biometric credential does not match this enrolled device.');
  }

  return { credentialId: returnedId, userVerified };
}

export async function touchBiometricLastUsed(credentialId: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'biometricCredentials', credentialId), {
      lastUsedAt: serverTimestamp(),
    });
  } catch {
    // non-blocking if credential record was cleaned up remotely
  }
}
