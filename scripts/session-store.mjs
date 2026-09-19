import sodium from 'libsodium-wrappers';

// ─── Session inspection ─────────────────────────────────────────────────────────

// Storage-state entries that actually carry the login. Everything else in a
// storage state (analytics, consent banners, feature flags) expires on its own
// schedule and must not drive expiry warnings.
const AUTH_NAME_RE = /(token|auth|session|sess|sid|jwt|login|access|refresh|credential|passport)/i;
const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/**
 * Decode a JWT payload without verifying it — we only want `exp`.
 * Returns the expiry in seconds since epoch, or null.
 */
function jwtExpiry(value) {
  if (typeof value !== 'string' || !JWT_RE.test(value)) return null;
  try {
    const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Collect credential expiries from a localStorage value: the value itself may be
 * a bare JWT, or a JSON envelope whose fields hold one (a common auth-SDK shape).
 */
function localStorageExpiries(name, value) {
  const found = [];
  const direct = jwtExpiry(value);
  if (direct) found.push({ source: `localStorage:${name}`, expires: direct });

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      for (const [key, nested] of Object.entries(parsed)) {
        const exp = jwtExpiry(nested);
        if (exp) found.push({ source: `localStorage:${name}.${key}`, expires: exp });
      }
    }
  } catch {
    // Not JSON — the direct check above was the only chance.
  }
  return found;
}

/**
 * Summarise how much life is left in a Playwright storage state.
 * Returns { cookieCount, authEntries, expiresAt, daysLeft, source } where
 * expiresAt/daysLeft/source are null when nothing dated could be identified
 * (pure session cookies, or an opaque token format).
 */
export function inspectSession(state, now = Date.now()) {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  const candidates = [];

  for (const cookie of cookies) {
    if (!AUTH_NAME_RE.test(cookie?.name ?? '')) continue;
    // Playwright uses -1 for session cookies; they die with the browser, not on a date.
    if (typeof cookie.expires !== 'number' || cookie.expires <= 0) continue;
    candidates.push({ source: `cookie:${cookie.name}`, expires: cookie.expires });
  }

  for (const origin of Array.isArray(state?.origins) ? state.origins : []) {
    for (const item of Array.isArray(origin?.localStorage) ? origin.localStorage : []) {
      candidates.push(...localStorageExpiries(item?.name ?? '', item?.value ?? ''));
    }
  }

  const nowSeconds = now / 1000;
  // The login dies with whichever credential expires first, so report the
  // earliest expiry that is still in the future.
  const upcoming = candidates
    .filter((entry) => entry.expires > nowSeconds)
    .sort((a, b) => a.expires - b.expires)[0];

  if (!upcoming) {
    return {
      cookieCount: cookies.length,
      authEntries: candidates.length,
      expiresAt: null,
      daysLeft: null,
      source: null,
    };
  }

  return {
    cookieCount: cookies.length,
    authEntries: candidates.length,
    expiresAt: new Date(upcoming.expires * 1000).toISOString(),
    daysLeft: Math.round(((upcoming.expires - nowSeconds) / 86_400) * 10) / 10,
    source: upcoming.source,
  };
}

// ─── Storage-state comparison ───────────────────────────────────────────────────

/**
 * Canonical form used to decide whether a state is worth writing back.
 * Cookie/localStorage ordering is not stable across runs, so sort before comparing.
 */
function canonicalize(state) {
  const cookies = (Array.isArray(state?.cookies) ? state.cookies : [])
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
    }))
    .sort((a, b) => `${a.domain}${a.path}${a.name}`.localeCompare(`${b.domain}${b.path}${b.name}`));

  const origins = (Array.isArray(state?.origins) ? state.origins : [])
    .map((o) => ({
      origin: o.origin,
      localStorage: (Array.isArray(o.localStorage) ? o.localStorage : [])
        .map(({ name, value }) => ({ name, value }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    }))
    .sort((a, b) => String(a.origin).localeCompare(String(b.origin)));

  return JSON.stringify({ cookies, origins });
}

function authCookieNames(state) {
  return new Set(
    (Array.isArray(state?.cookies) ? state.cookies : [])
      .map((c) => c?.name)
      .filter((name) => typeof name === 'string' && AUTH_NAME_RE.test(name)),
  );
}

/**
 * Decide whether `next` may replace `previous` in the stored secret.
 * Returns { ok: true } or { ok: false, reason } — never throws, because a
 * refused rotation must not fail an otherwise successful claim.
 */
export function canRotate(previous, next) {
  const nextCookies = Array.isArray(next?.cookies) ? next.cookies : [];
  if (nextCookies.length === 0) {
    return { ok: false, reason: 'the refreshed state has no cookies' };
  }

  const before = authCookieNames(previous);
  const after = authCookieNames(next);
  const dropped = [...before].filter((name) => !after.has(name));
  if (dropped.length) {
    return { ok: false, reason: `credential cookie(s) disappeared: ${dropped.join(', ')}` };
  }

  if (canonicalize(previous) === canonicalize(next)) {
    return { ok: false, reason: 'unchanged' };
  }

  return { ok: true };
}

// ─── GitHub Actions secret writes ───────────────────────────────────────────────

// GitHub rejects secrets larger than 48 KB.
const MAX_SECRET_BYTES = 48 * 1024;

async function githubRequest(url, { token, method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'minimax-daily-check-in',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`GitHub API ${method} ${response.status}: ${detail || response.statusText}`);
  }

  return response.status === 204 ? null : response.json();
}

/**
 * Encrypt a value for a repository secret (libsodium sealed box, as GitHub requires).
 */
export async function sealSecret(publicKeyB64, plaintext) {
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(plaintext),
    sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL),
  );
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

/**
 * Create or update an Actions repository secret.
 * Requires a PAT with the "Secrets: read and write" repository permission —
 * the built-in GITHUB_TOKEN cannot write secrets.
 */
export async function updateRepositorySecret({
  repository,
  secretName,
  value,
  token,
  apiUrl = 'https://api.github.com',
}) {
  const size = Buffer.byteLength(value, 'utf8');
  if (size > MAX_SECRET_BYTES) {
    throw new Error(`value is ${size} bytes, over GitHub's 48 KB secret limit`);
  }

  const base = `${apiUrl.replace(/\/+$/, '')}/repos/${repository}/actions/secrets`;
  const publicKey = await githubRequest(`${base}/public-key`, { token });
  const encryptedValue = await sealSecret(publicKey.key, value);

  await githubRequest(`${base}/${encodeURIComponent(secretName)}`, {
    token,
    method: 'PUT',
    body: { encrypted_value: encryptedValue, key_id: publicKey.key_id },
  });
}
