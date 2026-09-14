/** PostgREST can return an empty success when RLS hid the row being updated. */
export async function requireSavedRows<T>(response: Response): Promise<T[]> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? 'Your session expired or you no longer have permission. Sign in again and retry.'
      : response.status === 409
        ? 'That name or URL is already in use. Choose another and retry.'
        : 'The change could not be saved. Please try again.';
    throw new Error(message);
  }
  if (!Array.isArray(data) || data.length === 0) throw new Error('Nothing was changed. This item may have been removed or your access changed. Refresh and try again.');
  return data as T[];
}
