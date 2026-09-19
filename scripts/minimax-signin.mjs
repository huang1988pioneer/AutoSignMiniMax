// The MiniMax Agent web app (agent.minimax.io) runs its daily check-in through
// three endpoints. Everything below mirrors the contract the shipped app uses,
// so a check-in only counts when MiniMax itself confirms it.
export const SIGNIN_STATUS_PATH = '/minimax-cloud/api/v1/signin/status';
export const SIGNIN_CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim';
export const MEMBERSHIP_PATH = '/matrix/api/v1/commerce/get_membership_info';

// Per-day state inside the 7-day check-in cycle.
export const DayStatus = { Upcoming: 1, Claimable: 2, Claimed: 3, Disabled: 4 };
// Result of a claim call: the site reports a repeat claim instead of failing.
export const ClaimResult = { Claimed: 1, AlreadyClaimed: 2 };

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function endsWith(url, path) {
  return pathOf(url).replace(/\/+$/, '') === path;
}

export function isSigninStatusRequest(request) {
  return endsWith(request?.url?.() ?? request?.url ?? '', SIGNIN_STATUS_PATH);
}

export function isSigninClaimRequest(request) {
  return endsWith(request?.url?.() ?? request?.url ?? '', SIGNIN_CLAIM_PATH);
}

export function isMembershipRequest(request) {
  return endsWith(request?.url?.() ?? request?.url ?? '', MEMBERSHIP_PATH);
}

/**
 * Unwrap a MiniMax envelope: `{ base_resp: { status_code, status_msg }, data }`.
 * A non-zero status_code is the site refusing, not a transport error.
 */
export function unwrapPayload(payload) {
  const code = payload?.base_resp?.status_code;
  if (typeof code === 'number' && code !== 0) {
    throw new Error(payload?.base_resp?.status_msg || `MiniMax returned status_code ${code}`);
  }
  const data = payload?.data;
  if (data === null || data === undefined) throw new Error('MiniMax response carried no data.');
  return data;
}

function normalizeDay(day) {
  const dayNo = Number(day?.day_no);
  const status = Number(day?.status);
  if (!Number.isInteger(dayNo) || !Number.isInteger(status)) return null;
  const points = Number(day?.points);
  const bonusPoints = Number(day?.bonus_points);
  return {
    dayNo,
    status,
    points: Number.isFinite(points) ? points : null,
    bonusPoints: Number.isFinite(bonusPoints) ? bonusPoints : 0,
    isToday: day?.is_today === true,
  };
}

/**
 * Read the check-in panel: which day is claimable, whether today is already
 * done, and the streak the site itself is showing.
 */
export function parseSigninPanel(data) {
  const days = (Array.isArray(data?.days) ? data.days : []).map(normalizeDay).filter(Boolean);
  if (!days.length) throw new Error('MiniMax returned an unrecognised check-in panel.');

  const claimable = days.find((day) => day.status === DayStatus.Claimable) ?? null;
  const today = days.find((day) => day.isToday) ?? null;
  // The site marks a claimed day only after a successful claim, so "claimed
  // today" is the one signal that makes a re-run a no-op instead of a failure.
  const claimedToday = today?.status === DayStatus.Claimed;

  return { days, claimable, today, claimedToday, streak: panelStreak(days) };
}

/**
 * Consecutive claimed days ending at today, counted the way the site counts it:
 * from today when it is already claimed, otherwise from the day before.
 */
export function panelStreak(days) {
  const anchor = days.findIndex((day) => day.isToday);
  if (anchor < 0) return 0;
  const status = days[anchor]?.status;
  let index = status === DayStatus.Claimed ? anchor : status === DayStatus.Claimable ? anchor - 1 : -1;
  let streak = 0;
  for (; index >= 0 && days[index]?.status === DayStatus.Claimed; index -= 1) streak += 1;
  return streak;
}

/**
 * Read a claim response. `AlreadyClaimed` is a success: the day is banked.
 */
export function parseClaimResult(data) {
  const result = Number(data?.claim_result);
  if (result !== ClaimResult.Claimed && result !== ClaimResult.AlreadyClaimed) {
    throw new Error('MiniMax returned an unrecognised check-in claim response.');
  }
  const points = Number(data?.points);
  const dayNo = Number(data?.day_no);
  let panel = null;
  try {
    panel = parseSigninPanel(data?.panel);
  } catch {
    // The claim itself is authoritative; a panel we cannot read is not a failure.
  }
  return {
    alreadyClaimed: result === ClaimResult.AlreadyClaimed,
    dayNo: Number.isInteger(dayNo) ? dayNo : null,
    points: Number.isFinite(points) ? points : null,
    claimId: typeof data?.claim_id === 'string' ? data.claim_id : null,
    panel,
  };
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.replaceAll(',', '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Credit balance from the membership payload the app loads for its usage panel.
 * `op_credit_summary.total_remaining_amount` is what the UI prints; the flat
 * `opcredit_balance` is the older field and only used as a fallback.
 */
export function parseCreditBalance(payload) {
  const data = payload?.data ?? payload;
  const summary = toNumber(data?.op_credit_summary?.total_remaining_amount);
  return summary ?? toNumber(data?.opcredit_balance);
}
