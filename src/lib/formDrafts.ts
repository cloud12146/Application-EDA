export interface StoredFormDraft<T> {
  version: 1;
  savedAt: number;
  data: T;
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function getExpenseDraftKey(userId: string, claimId?: string): string {
  return `glacetor_draft:expense:${userId}:${claimId || 'new'}`;
}

export function getTaskAssignDraftKey(userId: string, taskId?: string): string {
  return `glacetor_draft:task_assign:${userId}:${taskId || 'new'}`;
}

export function getTaskDetailDraftKey(userId: string, taskId: string): string {
  return `glacetor_draft:task_detail:${userId}:${taskId}`;
}

export function saveFormDraft<T>(key: string, data: T): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    const payload: StoredFormDraft<T> = {
      version: 1,
      savedAt: Date.now(),
      data,
    };
    window.localStorage.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function loadFormDraft<T>(
  key: string,
  maxAgeMs = DEFAULT_MAX_AGE_MS
): { data: T; savedAt: number } | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredFormDraft<T>>;
    if (!parsed || typeof parsed.savedAt !== 'number' || !parsed.data) {
      window.localStorage.removeItem(key);
      return null;
    }
    if (Date.now() - parsed.savedAt > maxAgeMs) {
      window.localStorage.removeItem(key);
      return null;
    }
    return { data: parsed.data, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

export function clearFormDraft(key: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore storage access errors
  }
}

export function formatDraftAge(savedAt: number): string {
  const diffSec = Math.max(0, Math.round((Date.now() - savedAt) / 1000));
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return new Date(savedAt).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
  });
}

export async function blobToDataUrl(
  blob: Blob,
  maxBytes = 650 * 1024
): Promise<string | undefined> {
  if (blob.size > maxBytes) return undefined;
  return await new Promise<string | undefined>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      resolve(typeof reader.result === 'string' ? reader.result : undefined);
    };
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataUrl: string): Blob | null {
  try {
    const parts = dataUrl.split(',');
    if (parts.length !== 2) return null;
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch?.[1] || 'image/jpeg';
    const binary = atob(parts[1]);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}
