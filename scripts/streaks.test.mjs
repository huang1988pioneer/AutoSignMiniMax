import test from 'node:test';
import assert from 'node:assert/strict';
import { updateStreak, taipeiDate } from './streaks.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const now = '2026-09-06T09:00:00Z';
const success = (finishedAt = now) => ({ account: 1, status: 'checked_in', finishedAt });

test('first success and repeated same-day runs count once', () => {
  const first = updateStreak(success(), null, now);
  assert.equal(first.streak, 1);
  assert.equal(first.lastCheckInDate, '2026-09-06');
  assert.deepEqual(updateStreak(success(), first, now), first);
});

test('consecutive days increment; a missed day resets to one', () => {
  const history = { checkInDates: ['2026-09-04', '2026-09-05'] };
  assert.equal(updateStreak(success(), history, now).streak, 3);
  assert.equal(updateStreak(success(), { checkInDates: ['2026-09-04'] }, now).streak, 1);
});

test('failed/skipped retries retain success and yesterday streak; expire after a missed day', () => {
  for (const status of ['failed', 'skipped']) {
    const row = { account: 1, status };
    assert.equal(updateStreak(row, { checkInDates: ['2026-09-05', '2026-09-06'] }, now).streak, 2);
    assert.equal(updateStreak(row, { checkInDates: ['2026-09-04', '2026-09-05'] }, now).streak, 2);
    const expired = updateStreak(row, { checkInDates: ['2026-09-04'] }, now);
    assert.equal(expired.streak, 0);
    assert.equal(expired.lastCheckInDate, '2026-09-04');
    assert.equal(updateStreak(row, null, now).streak, 0);
  }
});

test('Taipei midnight and delayed summary use actual completion date', () => {
  assert.equal(taipeiDate('2026-09-05T15:59:59Z'), '2026-09-05');
  assert.equal(taipeiDate('2026-09-05T16:00:00Z'), '2026-09-06');
  const result = updateStreak(success('2026-09-05T15:59:59Z'), null, now);
  assert.equal(result.lastCheckInDate, '2026-09-05');
  assert.equal(result.streak, 1);
});

test('out-of-order results merge dates without rolling history back', () => {
  const history = { checkInDates: ['2026-09-04', '2026-09-06'] };
  const result = updateStreak(success('2026-09-05T09:00:00Z'), history, now);
  assert.equal(result.streak, 3);
  assert.equal(result.lastCheckInDate, '2026-09-06');
});

test('old null streaks start from observed success; missing timestamps do not fabricate dates', () => {
  assert.equal(updateStreak(success(), { streak: null }, now).streak, 1);
  assert.equal(updateStreak({ status: 'checked_in' }, null, now).streak, 0);
});

test('malformed history fails instead of silently discarding records', () => {
  assert.throws(() => updateStreak(success(), { checkInDates: ['2026-02-30'] }, now));
  assert.throws(() => updateStreak(success(), { checkInDates: 'invalid' }, now));
  assert.throws(() => taipeiDate('invalid'));
});

test('summary reads history, publishes computed statistics and preserves same-day counts on rerun', () => {
  const root = mkdtempSync(join(tmpdir(), 'minimax-streak-test-'));
  try {
    const input = join(root, 'input');
    const output = join(root, 'output');
    const history = join(root, 'history.json');
    mkdirSync(input);
    const timestamp = new Date().toISOString();
    const today = taipeiDate(timestamp);
    const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);
    writeFileSync(history, JSON.stringify({ accounts: [{ account: 1, checkInDates: [yesterday] }] }));
    writeFileSync(join(input, 'one.json'), JSON.stringify({ account: 1, name: 'one', status: 'checked_in', finishedAt: timestamp, currentPoints: 0, session: { secret: 'PRIVATE_MARKER' } }));
    const env = { ...process.env, MINIMAX_SUMMARY_DIR: output, MINIMAX_EXPECTED_ACCOUNTS: '2', MINIMAX_STREAKS_FILE: history, GITHUB_STEP_SUMMARY: '' };
    const script = fileURLToPath(new URL('./summarize-checkin-results.mjs', import.meta.url));
    for (let run = 0; run < 2; run++) {
      execFileSync(process.execPath, [script, input], { env, stdio: 'pipe' });
      const raw = readFileSync(join(output, 'streaks.json'), 'utf8');
      const result = JSON.parse(raw);
      assert.equal(result.accounts[0].streak, 2);
      assert.equal(result.accounts[0].currentPoints, 0);
      assert.equal(result.accounts[1].streak, 0);
      assert.deepEqual(result.summary, { recorded: 2, max: 2, min: 0, average: 1 });
      assert(!raw.includes('PRIVATE_MARKER'));
      assert(readFileSync(join(output, 'minimax-daily-summary.md'), 'utf8').includes('MiniMax credits'));
      writeFileSync(history, raw);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
