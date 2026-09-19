import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMembershipRequest,
  isSigninClaimRequest,
  isSigninStatusRequest,
  parseClaimResult,
  parseCreditBalance,
  parseSigninPanel,
  unwrapPayload,
} from './minimax-signin.mjs';

const day = (dayNo, status, extra = {}) => ({ day_no: dayNo, status, points: 100, is_today: false, ...extra });

test('recognises the check-in endpoints and ignores neighbours', () => {
  const request = (url) => ({ url: () => url });
  assert.equal(isSigninStatusRequest(request('https://agent.minimax.io/minimax-cloud/api/v1/signin/status?x=1')), true);
  assert.equal(isSigninClaimRequest(request('https://agent.minimax.io/minimax-cloud/api/v1/signin/claim')), true);
  assert.equal(isMembershipRequest(request('https://agent.minimax.io/matrix/api/v1/commerce/get_membership_info')), true);
  assert.equal(isSigninClaimRequest(request('https://agent.minimax.io/minimax-cloud/api/v1/signin/status')), false);
  assert.equal(isSigninStatusRequest(request('https://agent.minimax.io/minimax-cloud/api/v1/signin/config')), false);
});

test('unwrapPayload surfaces the site error message', () => {
  assert.deepEqual(unwrapPayload({ base_resp: { status_code: 0 }, data: { ok: true } }), { ok: true });
  assert.throws(
    () => unwrapPayload({ base_resp: { status_code: 1022, status_msg: 'too many requests' } }),
    /too many requests/,
  );
  assert.throws(() => unwrapPayload({ base_resp: { status_code: 0 } }), /carried no data/);
});

test('parseSigninPanel finds the claimable day and the site streak', () => {
  const panel = parseSigninPanel({
    scene: 1,
    days: [
      day(1, 3),
      day(2, 3),
      day(3, 2, { is_today: true, bonus_points: 50 }),
      day(4, 1),
      day(5, 1),
      day(6, 1),
      day(7, 1),
    ],
  });
  assert.equal(panel.claimable.dayNo, 3);
  assert.equal(panel.today.bonusPoints, 50);
  assert.equal(panel.claimedToday, false);
  assert.equal(panel.streak, 2);
});

test('parseSigninPanel reports a day already claimed today', () => {
  const panel = parseSigninPanel({
    days: [day(1, 3), day(2, 3, { is_today: true }), day(3, 1), day(4, 1), day(5, 1), day(6, 1), day(7, 1)],
  });
  assert.equal(panel.claimable, null);
  assert.equal(panel.claimedToday, true);
  assert.equal(panel.streak, 2);
});

test('parseSigninPanel rejects a panel it cannot read', () => {
  assert.throws(() => parseSigninPanel({ days: [] }), /unrecognised check-in panel/);
  assert.throws(() => parseSigninPanel(null), /unrecognised check-in panel/);
});

test('parseClaimResult accepts a fresh claim and a repeat claim', () => {
  const claimed = parseClaimResult({ claim_id: 'a1', claim_result: 1, day_no: 3, points: 400, expire_at_ms: 1 });
  assert.equal(claimed.alreadyClaimed, false);
  assert.equal(claimed.points, 400);
  assert.equal(claimed.dayNo, 3);

  const repeat = parseClaimResult({ claim_id: 'a1', claim_result: 2, day_no: 3, points: 400 });
  assert.equal(repeat.alreadyClaimed, true);

  assert.throws(() => parseClaimResult({ claim_result: 7 }), /unrecognised check-in claim response/);
});

test('parseCreditBalance prefers the credit summary the UI shows', () => {
  assert.equal(parseCreditBalance({ data: { op_credit_summary: { total_remaining_amount: '7,178' }, opcredit_balance: 6778 } }), 7178);
  assert.equal(parseCreditBalance({ opcredit_balance: 6778 }), 6778);
  assert.equal(parseCreditBalance({ data: { op_credit_summary: { total_remaining_amount: '0' } } }), 0);
  assert.equal(parseCreditBalance({ data: {} }), null);
  assert.equal(parseCreditBalance({ data: { opcredit_balance: 'n/a' } }), null);
});
