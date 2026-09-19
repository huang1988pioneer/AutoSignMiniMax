import { chromium, firefox } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canRotate, inspectSession, updateRepositorySecret } from './session-store.mjs';
import {
  isMembershipRequest,
  isSigninClaimRequest,
  isSigninStatusRequest,
  parseClaimResult,
  parseCreditBalance,
  parseSigninPanel,
  unwrapPayload,
} from './minimax-signin.mjs';

const ORIGIN = (process.env.MINIMAX_ORIGIN || 'https://agent.minimax.io').replace(/\/+$/, '');
const HOME_URL = `${ORIGIN}/`;
const ACCOUNT_NAME = process.env.MINIMAX_ACCOUNT_NAME || 'default';
const ACCOUNT_NUMBER = Number(process.env.MINIMAX_ACCOUNT_NUMBER) || null;
const STATE_B64 = process.env.MINIMAX_STORAGE_STATE_B64;
const COOKIE_HEADER = process.env.MINIMAX_COOKIE;
const MAX_RETRIES = Number(process.env.MINIMAX_MAX_RETRIES) || 3;
const SCREENSHOT_DIR = process.env.MINIMAX_SCREENSHOT_DIR || './screenshots';
const RESULT_DIR = process.env.MINIMAX_RESULT_DIR || './artifacts';
const SESSION_WARN_DAYS = Number(process.env.MINIMAX_SESSION_WARN_DAYS) || 7;
const BROWSER_NAME = (process.env.MINIMAX_BROWSER || 'chromium').trim().toLowerCase();
const SECRET_WRITE_TOKEN = process.env.MINIMAX_SECRET_WRITE_TOKEN;
const SECRET_NAME =
  process.env.MINIMAX_SECRET_NAME ||
  (ACCOUNT_NUMBER ? `MINIMAX_STORAGE_STATE_B64_${ACCOUNT_NUMBER}` : null);
const REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';

// The check-in card the app opens by itself on startup whenever today is
// claimable, and the button inside it. Both come from the shipped app, so they
// do not depend on the interface language.
const CARD = '[data-testid="signin-card"]';
const CLAIM_BUTTON = `${CARD} button.signin-claim-button`;
const CARD_ERROR = '[data-testid="signin-card-error"]';
// Sidebar user menu: the entry that renders the same card on hover.
const MENU_ENTRY = '[data-menu-id$="daily-signin"]';

const STATUS_TIMEOUT_MS = Number(process.env.MINIMAX_STATUS_TIMEOUT_MS) || 30_000;
const CARD_TIMEOUT_MS = Number(process.env.MINIMAX_CARD_TIMEOUT_MS) || 15_000;
const CLAIM_TIMEOUT_MS = Number(process.env.MINIMAX_CLAIM_TIMEOUT_MS) || 30_000;

const sessionReport = { session: null, rotation: null };
let currentPoints = null;
let siteStreak = null;
let refreshedState = null;

function log(message) {
  console.log(`[account ${ACCOUNT_NAME}] ${message}`);
}

function warn(message) {
  console.warn(`::warning::[account ${ACCOUNT_NAME}] ${message}`);
}

function cleanError(error) {
  return String(error?.message ?? error).replace(/\s+/g, ' ').trim().slice(0, 600);
}

// A dead login cannot be fixed by retrying, so it ends the run immediately.
function sessionError(message) {
  const error = new Error(message);
  error.kind = 'session';
  return error;
}

async function writeClaimResult(status, message) {
  await mkdir(RESULT_DIR, { recursive: true });
  const result = {
    account: ACCOUNT_NUMBER,
    name: ACCOUNT_NAME,
    status,
    message,
    currentPoints,
    siteStreak,
    finishedAt: new Date().toISOString(),
    ...sessionReport,
  };
  await writeFile(join(RESULT_DIR, 'claim-result.json'), `${JSON.stringify(result, null, 2)}\n`);
}

/**
 * chromium (default) | firefox | edge — user-selectable fallbacks for when one
 * engine is blocked or unstable on a runner.
 */
function resolveBrowserEngine() {
  if (BROWSER_NAME === 'firefox') {
    return { name: 'firefox', engine: firefox, launchOptions: { headless: true }, contextOptions: {} };
  }

  if (BROWSER_NAME === 'edge' || BROWSER_NAME === 'msedge') {
    return {
      name: 'edge',
      engine: chromium,
      launchOptions: {
        headless: true,
        channel: 'msedge',
        args: ['--disable-blink-features=AutomationControlled'],
      },
      contextOptions: {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
      },
    };
  }

  if (BROWSER_NAME === 'chromium' || BROWSER_NAME === 'chrome') {
    return {
      name: 'chromium',
      engine: chromium,
      launchOptions: { headless: true, args: ['--disable-blink-features=AutomationControlled'] },
      contextOptions: {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      },
    };
  }

  throw new Error(`Unsupported MINIMAX_BROWSER="${BROWSER_NAME}". Use chromium (default), firefox, or edge.`);
}

function parseCookieHeader(header) {
  return header
    .split(';')
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator < 1) throw new Error('MINIMAX_COOKIE contains an invalid cookie segment.');
      return {
        name: part.slice(0, separator).trim(),
        value: part.slice(separator + 1).trim(),
        url: HOME_URL,
        sameSite: 'Lax',
      };
    })
    .filter(({ name, value }) => name && value);
}

async function storageStateFile() {
  if (!STATE_B64) return undefined;
  const directory = await mkdtemp(join(tmpdir(), 'minimax-state-'));
  const file = join(directory, 'storage-state.json');
  try {
    const decoded = Buffer.from(STATE_B64, 'base64');
    const parsed = JSON.parse(decoded.toString('utf8'));
    await writeFile(file, decoded);
    return { directory, file, parsed };
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error('MINIMAX_STORAGE_STATE_B64 is not valid base64-encoded Playwright storage state JSON.');
  }
}

function reportSessionLifetime(state, label) {
  const info = inspectSession(state);
  sessionReport.session = { ...info, checkedAt: new Date().toISOString() };

  if (info.daysLeft === null) {
    log(`Session (${label}): ${info.cookieCount} cookie(s); expiry cannot be predicted.`);
    return;
  }

  const detail = `expires ${info.expiresAt} (${info.daysLeft}d left, from ${info.source})`;
  if (info.daysLeft <= SESSION_WARN_DAYS) {
    warn(
      `Login credential ${detail}. Re-run the MiniMaxFlow login and update ` +
        `${SECRET_NAME ?? 'the storage-state Secret'} before it lapses.`,
    );
  } else {
    log(`Session (${label}): ${detail}.`);
  }
}

async function rotateStoredSession(previous, next) {
  if (!next) return;
  if (!SECRET_WRITE_TOKEN) {
    sessionReport.rotation = { rotated: false, reason: 'MINIMAX_SECRET_WRITE_TOKEN not configured' };
    return;
  }
  if (!REPOSITORY || !SECRET_NAME) {
    sessionReport.rotation = {
      rotated: false,
      reason: 'GITHUB_REPOSITORY or the target secret name is unknown',
    };
    return;
  }

  const verdict = canRotate(previous ?? { cookies: [], origins: [] }, next);
  if (!verdict.ok) {
    sessionReport.rotation = { rotated: false, reason: verdict.reason, secret: SECRET_NAME };
    if (verdict.reason !== 'unchanged') warn(`Not rotating ${SECRET_NAME}: ${verdict.reason}.`);
    return;
  }

  try {
    await updateRepositorySecret({
      repository: REPOSITORY,
      secretName: SECRET_NAME,
      value: Buffer.from(JSON.stringify(next), 'utf8').toString('base64'),
      token: SECRET_WRITE_TOKEN,
      apiUrl: GITHUB_API_URL,
    });
    sessionReport.rotation = { rotated: true, secret: SECRET_NAME };
    log(`Rotated ${SECRET_NAME} with the refreshed login state.`);
  } catch (error) {
    sessionReport.rotation = { rotated: false, reason: cleanError(error), secret: SECRET_NAME };
    warn(`Could not rotate ${SECRET_NAME}: ${cleanError(error)}`);
  }
}

async function saveScreenshot(page, label) {
  try {
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    const safeAccount = ACCOUNT_NAME.replaceAll(/[^a-z0-9._-]+/gi, '-');
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const path = join(SCREENSHOT_DIR, `account-${safeAccount}-${label}-${timestamp}.png`);
    await page.screenshot({ path, fullPage: true });
    log(`Screenshot saved: ${path}`);
  } catch (error) {
    warn(`Could not save screenshot: ${cleanError(error)}`);
  }
}

async function waitForStable(page, ms = 1_200) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(ms);
}

/**
 * Watch the official endpoints for the whole visit. The app signs its own
 * requests, so reading its traffic is the only trustworthy confirmation —
 * this flow never forges a check-in call of its own.
 */
function observeSignin(page) {
  const state = { panel: null, panelError: null, claim: null, claimError: null, claimSeen: false };
  const waiters = [];

  const settle = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };

  page.on('response', async (response) => {
    const request = response.request();
    try {
      if (isMembershipRequest(request)) {
        const credits = parseCreditBalance(await response.json());
        if (credits !== null) currentPoints = credits;
        return;
      }
      if (isSigninStatusRequest(request)) {
        state.panel = parseSigninPanel(unwrapPayload(await response.json()));
        state.panelError = null;
        siteStreak = state.panel.streak;
        settle();
        return;
      }
      if (isSigninClaimRequest(request)) {
        state.claimSeen = true;
        state.claim = parseClaimResult(unwrapPayload(await response.json()));
        state.claimError = null;
        if (state.claim.panel) siteStreak = state.claim.panel.streak;
        settle();
      }
    } catch (error) {
      if (isSigninClaimRequest(request)) {
        state.claimSeen = true;
        state.claimError = cleanError(error);
      } else if (isSigninStatusRequest(request)) {
        state.panelError = cleanError(error);
      }
      settle();
    }
  });

  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 500));
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return true;
  };

  return {
    state,
    waitForPanel: (timeoutMs) => waitFor(() => state.panel !== null || state.panelError !== null, timeoutMs),
    waitForClaim: (timeoutMs) => waitFor(() => state.claimSeen, timeoutMs),
  };
}

async function isLoggedOut(page) {
  if (/\/(?:login|sign-?in|oauth|authorize)(?:\/|$)/i.test(new URL(page.url()).pathname)) return true;

  const loginControl = page.getByRole('button', { name: /^(?:log\s*in|sign\s*in|登录|登入)$/i });
  return await loginControl.first().isVisible().catch(() => false);
}

/**
 * The app opens the check-in card by itself when today is claimable. When it
 * does not, fall back to the sidebar user menu, whose "Daily check-in" entry
 * renders the same card on hover.
 */
async function revealCheckInCard(page) {
  const card = page.locator(CARD).first();
  if (await card.waitFor({ state: 'visible', timeout: CARD_TIMEOUT_MS }).then(() => true).catch(() => false)) {
    return true;
  }

  log('The check-in card did not open on its own; trying the sidebar user menu…');
  const entry = page.locator(MENU_ENTRY).first();
  const triggers = [
    page.locator('aside img.rounded-full').last(),
    page.locator('img.rounded-full').last(),
    page.locator('aside [class*="cursor-pointer"]').last(),
  ];

  for (const trigger of triggers) {
    if (!await entry.isVisible().catch(() => false)) {
      if (!await trigger.isVisible().catch(() => false)) continue;
      await trigger.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(600);
    }
    if (!await entry.isVisible().catch(() => false)) continue;

    await entry.hover({ timeout: 5_000 }).catch(() => {});
    if (await card.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) return true;
  }

  return false;
}

async function refreshStateAndCredits(context, page) {
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForStable(page, 2_500);
    if (currentPoints !== null) log(`Current credits: ${currentPoints}`);
  } catch (error) {
    warn(`Could not refresh the post-check-in dashboard: ${cleanError(error)}`);
  }

  refreshedState = await context.storageState().catch((error) => {
    warn(`Could not read refreshed storage state: ${cleanError(error)}`);
    return refreshedState;
  });
}

async function tryCheckInOnce(browser, state, contextOptions) {
  currentPoints = null;
  const context = await browser.newContext({
    ...(state ? { storageState: state.file } : {}),
    viewport: { width: 1_440, height: 900 },
    ...contextOptions,
  });
  if (COOKIE_HEADER) await context.addCookies(parseCookieHeader(COOKIE_HEADER));

  const page = await context.newPage();
  const observer = observeSignin(page);
  let sessionValid = false;

  try {
    log('Opening MiniMax Agent and waiting for its daily check-in panel…');
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForStable(page);
    if (await isLoggedOut(page)) {
      await saveScreenshot(page, 'login-expired');
      throw sessionError(
        'The stored MiniMax login is expired. Refresh MINIMAX_STORAGE_STATE_B64 or MINIMAX_COOKIE; ' +
          'this workflow never bypasses OTP, login, or CAPTCHA.',
      );
    }
    sessionValid = true;

    await observer.waitForPanel(STATUS_TIMEOUT_MS);
    const { panel, panelError } = observer.state;
    if (!panel) {
      await saveScreenshot(page, 'panel-not-observed');
      if (await isLoggedOut(page)) {
        throw sessionError('MiniMax stopped serving the check-in panel; the stored login is no longer valid.');
      }
      throw new Error(
        panelError
          ? `MiniMax rejected the check-in status request: ${panelError}`
          : 'MiniMax never served a check-in status response for this account.',
      );
    }

    log(`Check-in panel: day ${panel.today?.dayNo ?? '?'} of the cycle, site streak ${panel.streak}.`);

    if (!panel.claimable) {
      if (panel.claimedToday) {
        await saveScreenshot(page, 'already-checked-in');
        log('MiniMax reports today as already checked in.');
        return { claimed: true, message: 'MiniMax reports today as already checked in.' };
      }
      await saveScreenshot(page, 'nothing-claimable');
      throw new Error('MiniMax offered no claimable day today (the check-in may be disabled for this account).');
    }

    if (!await revealCheckInCard(page)) {
      await saveScreenshot(page, 'check-in-card-not-found');
      throw new Error('Could not open the MiniMax check-in card; the sidebar layout may have changed.');
    }

    if (await page.locator(CARD_ERROR).first().isVisible().catch(() => false)) {
      await saveScreenshot(page, 'check-in-card-error');
      throw new Error('MiniMax rendered the check-in card in its error state.');
    }

    const button = page.locator(CLAIM_BUTTON).first();
    if (!await button.isEnabled().catch(() => false)) {
      await saveScreenshot(page, 'claim-button-disabled');
      throw new Error('The MiniMax check-in button is present but disabled.');
    }

    await button.click({ timeout: 10_000 });
    log('Clicked the check-in button; waiting for the official claim response…');
    await observer.waitForClaim(CLAIM_TIMEOUT_MS);

    const { claim, claimError } = observer.state;
    if (!claim) {
      await saveScreenshot(page, 'claim-not-confirmed');
      throw new Error(
        claimError
          ? `MiniMax did not accept the check-in: ${claimError}`
          : 'MiniMax never answered the check-in claim request.',
      );
    }

    await saveScreenshot(page, 'check-in-accepted');
    const reward = claim.points === null ? '' : ` (+${claim.points} credits)`;
    const message = claim.alreadyClaimed
      ? 'MiniMax reports today as already checked in.'
      : `MiniMax accepted the daily check-in for day ${claim.dayNo ?? '?'}${reward}.`;
    log(message);
    return { claimed: true, message };
  } finally {
    if (sessionValid) await refreshStateAndCredits(context, page);
    await context.close();
  }
}

async function main() {
  if (!STATE_B64 && !COOKIE_HEADER) {
    throw new Error('Set MINIMAX_STORAGE_STATE_B64 (recommended) or MINIMAX_COOKIE in GitHub Actions secrets.');
  }

  const state = await storageStateFile();
  let browser;
  let claimed = false;
  let resultMessage = 'Daily check-in was not completed.';

  try {
    const browserInfo = resolveBrowserEngine();
    log(`Using Playwright browser: ${browserInfo.name}`);
    browser = await browserInfo.engine.launch(browserInfo.launchOptions);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      log(`Attempt ${attempt}/${MAX_RETRIES}`);
      try {
        const outcome = await tryCheckInOnce(browser, state, browserInfo.contextOptions);
        if (outcome.claimed) {
          claimed = true;
          resultMessage = outcome.message;
          return;
        }
      } catch (error) {
        if (error?.kind === 'session') throw error;
        warn(`Attempt ${attempt} failed: ${cleanError(error)}`);
        resultMessage = cleanError(error);
      }

      if (attempt < MAX_RETRIES) {
        const delayMs = attempt * 4_000;
        log(`Waiting ${delayMs / 1_000}s before retry…`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw new Error(
      'The MiniMax daily check-in was not confirmed after all retries. Check the workflow screenshots; ' +
        'the eligibility or the site flow may have changed.',
    );
  } catch (error) {
    resultMessage = cleanError(error);
    throw error;
  } finally {
    await browser?.close();
    if (refreshedState) {
      reportSessionLifetime(refreshedState, 'after run');
      await rotateStoredSession(state?.parsed, refreshedState);
    } else if (state?.parsed) {
      reportSessionLifetime(state.parsed, 'stored secret');
    }
    await writeClaimResult(claimed ? 'checked_in' : 'failed', resultMessage);
    if (state?.directory) await rm(state.directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`::error::[account ${ACCOUNT_NAME}] ${cleanError(error)}`);
  process.exitCode = 1;
});
