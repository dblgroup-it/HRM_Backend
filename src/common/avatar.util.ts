/**
 * Relative URL of a user's avatar, served by the public avatar proxy.
 * The `?v=` cache-buster changes whenever the picture is replaced.
 */
export function buildAvatarUrl(
  userId: string,
  fileId: string | null | undefined,
): string | null {
  return fileId ? `/api/users/${userId}/avatar?v=${fileId}` : null;
}
