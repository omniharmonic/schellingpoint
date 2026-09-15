'use client';

/**
 * Browser side of image uploads: `POST /api/uploads` on the app origin with the session
 * cookie (plan §3.3, §7.2). No tokens, no storage SDK. The server checks the bytes; the
 * checks here only save a round trip for obvious mistakes.
 *
 * Stored files are content-addressed and may be shared by several events, so nothing on
 * the client deletes one: removing an image just clears the event's URL.
 */

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB, same as the server
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export interface UploadResult {
  success: boolean;
  url?: string;
  error?: string;
}

export interface UploadOptions {
  /** Slug of the gathering the image belongs to. Omit only while creating a gathering. */
  event?: string;
  /** `avatar`: the signed-in account's own profile photo (≤ 2 MB). Never combined with `event`. */
  purpose?: 'avatar';
  /** Override the client-side size check (the server cap still applies). */
  maxSize?: number;
}

function validateFile(file: File, maxSize: number): string | null {
  if (file.type && !ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return 'Upload a PNG, JPEG, GIF or WebP image.';
  }
  if (file.size > maxSize) {
    return `File too large. Maximum size: ${Math.round(maxSize / (1024 * 1024))}MB`;
  }
  return null;
}

/** Upload an image and return its public URL (`/uploads/…`). */
export async function uploadImage(file: File, options: UploadOptions = {}): Promise<UploadResult> {
  const serverCap = options.purpose === 'avatar' ? 2 * 1024 * 1024 : MAX_FILE_SIZE;
  const validationError = validateFile(file, Math.min(options.maxSize ?? serverCap, serverCap));
  if (validationError) return { success: false, error: validationError };

  const body = new FormData();
  body.append('file', file);
  if (options.event) body.append('event', options.event);
  if (options.purpose) body.append('purpose', options.purpose);

  try {
    const response = await fetch('/api/uploads', { method: 'POST', body, credentials: 'same-origin' });
    const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!response.ok || !data.url) {
      if (response.status === 401) return { success: false, error: 'Sign in again to upload images.' };
      return { success: false, error: data.error || `Upload failed (${response.status}). Please try again.` };
    }
    return { success: true, url: data.url };
  } catch (error) {
    console.error('Unexpected upload error:', error);
    return { success: false, error: 'Failed to upload image. Please try again.' };
  }
}

/** Upload an event logo (pass the slug once the gathering exists). */
export function uploadEventLogo(file: File, event?: string): Promise<UploadResult> {
  return uploadImage(file, { event });
}

/** Upload an event banner (pass the slug once the gathering exists). */
export function uploadEventBanner(file: File, event?: string): Promise<UploadResult> {
  return uploadImage(file, { event });
}
