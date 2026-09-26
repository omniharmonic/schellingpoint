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
const FLOORPLAN_MAX_SIZE = 8 * 1024 * 1024; // design §1.5, same as the server
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export interface UploadResult {
  success: boolean;
  url?: string;
  error?: string;
}

export interface UploadOptions {
  /** Slug of the gathering the image belongs to. Omit only while creating a gathering. */
  event?: string;
  /**
   * `avatar`: the signed-in account's own profile photo (≤ 2 MB). Never combined with `event`.
   * `floorplan`: a gathering's indoor map (≤ 8 MB, design §1.5). Always with `event`.
   */
  purpose?: 'avatar' | 'floorplan';
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
  const serverCap =
    options.purpose === 'avatar' ? 2 * 1024 * 1024 : options.purpose === 'floorplan' ? FLOORPLAN_MAX_SIZE : MAX_FILE_SIZE;
  const validationError = validateFile(file, Math.min(options.maxSize ?? serverCap, serverCap));
  if (validationError) return { success: false, error: validationError };

  // Materialize cloud-backed files before starting the request, so a read failure
  // produces an actionable message instead of an incomplete network body.
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return { success: false, error: 'That image could not be read. If it is stored in the cloud, download it first and try again.' };
  }
  if (bytes.byteLength === 0) return { success: false, error: 'That file is empty.' };

  // Send materialized bytes directly. Filenames and multipart boundaries are not needed
  // by a content-addressed store and have proved unreliable through some browser/proxy paths.
  const query = new URLSearchParams();
  if (options.event) query.set('event', options.event);
  if (options.purpose) query.set('purpose', options.purpose);
  try {
    const response = await fetch(`/api/uploads?${query}`, {
      method: 'POST', body: bytes, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
    });
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

/**
 * Upload the signed-in account's own profile photo (≤ 2 MB) and return its URL. Throws an Error
 * with a message fit to show — the profile editors expect that shape.
 *
 * Deliberately the same path as every other image: image bytes must never travel through the
 * JSON client, which serializes bodies and sets a different Content-Type.
 */
export async function uploadAvatar(file: File): Promise<string> {
  const result = await uploadImage(file, { purpose: 'avatar' });
  if (!result.success || !result.url) throw new Error(result.error || 'Upload failed.');
  return result.url;
}

/** Upload a gathering's floor plan / indoor map (≤ 8 MB, PNG/JPEG/WebP). */
export async function uploadFloorPlan(file: File, event: string): Promise<string> {
  if (file.type && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Upload the floor plan as a PNG, JPEG or WebP image.');
  }
  const result = await uploadImage(file, { event, purpose: 'floorplan' });
  if (!result.success || !result.url) throw new Error(result.error || 'Upload failed.');
  return result.url;
}
