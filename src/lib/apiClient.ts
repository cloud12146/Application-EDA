import { Capacitor } from '@capacitor/core';

const API_BASE_OVERRIDE_KEY = 'glacetor_api_base_url';

function normalizeBaseUrl(raw?: string | null): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

export function getApiBaseUrl(): string {
  const envUrl = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL);
  if (envUrl) return envUrl;
  try {
    const stored = normalizeBaseUrl(localStorage.getItem(API_BASE_OVERRIDE_KEY));
    if (stored) return stored;
  } catch {
    // ignore storage errors
  }
  return '';
}

export function setCustomApiBaseUrl(url: string): void {
  try {
    const normalized = normalizeBaseUrl(url);
    if (normalized) {
      localStorage.setItem(API_BASE_OVERRIDE_KEY, normalized);
    } else {
      localStorage.removeItem(API_BASE_OVERRIDE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export function isNativeAndroidApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function buildApiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const base = getApiBaseUrl();
  if (base) {
    return `${base}${cleanPath}`;
  }
  if (isNativeAndroidApp()) {
    throw new Error(
      'Backend server URL is not configured for this Android APK. Rebuild the APK with VITE_API_BASE_URL set to your hosted server URL.'
    );
  }
  return cleanPath;
}
