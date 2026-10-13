/**
 * The video tutorials: a YouTube playlist shown on the Tutorials page to
 * everyone signed in, whatever their roles. Decorator-free so a spec can
 * import it.
 */

/** DBL GROUP IT Helpdesk's playlist for the system, as given by the owner (2026-10-13). */
export const DEFAULT_TUTORIAL_PLAYLIST = {
  playlistId: 'PLMh1t_lzQ2ZM',
  title: 'TalentHub Web Application Configuration',
  channel: 'DBL GROUP IT Helpdesk',
};

const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);

/**
 * The playlist id from whatever was pasted: a playlist link, a video link
 * that carries `list=`, a share link with its `si=` tracker, or the bare id.
 * Null when it is none of those.
 */
export function parsePlaylistId(input: string): string | null {
  const text = input.trim();
  if (PLAYLIST_ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const id = url.searchParams.get('list');
  return id && PLAYLIST_ID.test(id) ? id : null;
}

/** Where the playlist opens on YouTube, and the privacy-enhanced player for the page. */
export function playlistLinks(playlistId: string) {
  const list = encodeURIComponent(playlistId);
  return {
    url: `https://www.youtube.com/playlist?list=${list}`,
    embedUrl: `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`,
  };
}
