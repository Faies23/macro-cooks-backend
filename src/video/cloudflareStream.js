/*
 * Cloudflare Stream adapter: creators upload videos directly; users stream them.
 * Get CF_ACCOUNT_ID and a Stream API token (CF_STREAM_TOKEN) from the Cloudflare
 * dashboard (Stream > Settings / API tokens).
 */
const ACCOUNT = process.env.CF_ACCOUNT_ID || '';
const TOKEN = process.env.CF_STREAM_TOKEN || '';
const API = 'https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT + '/stream';

// Returns a one-time URL the admin app uploads the video file straight to.
async function createDirectUpload({ maxDurationSeconds = 3600 } = {}) {
  const res = await fetch(API + '/direct_upload', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxDurationSeconds })
  });
  const j = await res.json();
  if (!j.success) throw new Error('Cloudflare direct_upload failed: ' + JSON.stringify(j.errors || j));
  return { uploadURL: j.result.uploadURL, uid: j.result.uid };
}

// The ready-to-embed player URL for a given video UID.
function playbackUrl(uid) {
  if (!uid) return null;
  return 'https://iframe.cloudflarestream.com/' + uid;
}
module.exports = { createDirectUpload, playbackUrl };
