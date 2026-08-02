/**
 * Detached HMAC signatures for self-issued proxy URLs.
 *
 * The subtitle proxy must fetch arbitrary provider CDNs, so an origin allowlist
 * is not workable. Instead we only honour URLs this deployment itself minted.
 */
import crypto from 'node:crypto';

/**
 * Stable server-only signing key.
 * Prefers an explicit secret; otherwise derives one from the service-role key so
 * a deployment works without new configuration. The service key itself is never
 * exposed -- only an irreversible HMAC of a fixed label.
 */
function signingKey() {
  const explicit = process.env.SUB_PROXY_SECRET;
  if (explicit) return explicit;
  const derived = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (derived) {
    return crypto.createHmac('sha256', derived).update('sub-proxy-v1').digest('hex');
  }
  return null;
}

export function canSign() {
  return signingKey() !== null;
}

/** URL-safe base64 of HMAC-SHA256(key, value), truncated to 128 bits. */
export function signValue(value) {
  const key = signingKey();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(String(value)).digest('base64url').slice(0, 22);
}

/** Constant-time comparison so a signature cannot be recovered by timing. */
export function verifyValue(value, signature) {
  const expected = signValue(value);
  if (!expected || !signature) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
