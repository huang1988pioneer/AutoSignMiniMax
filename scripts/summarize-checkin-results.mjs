import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateStreak } from './streaks.mjs';

const inputDir = process.argv[2] || 'collected';
const outputDir = process.env.MINIMAX_SUMMARY_DIR || 'artifacts';
const expectedAccounts = Number(process.env.MINIMAX_EXPECTED_ACCOUNTS || 33);
const sessionWarnDays = Number(process.env.MINIMAX_SESSION_WARN_DAYS) || 7;

function walkJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walkJsonFiles(path) : entry.name.endsWith('.json') ? [path] : [];
  });
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function compact(value, length = 140) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text || '—';
}

const byAccount = new Map();
for (const file of walkJsonFiles(inputDir)) {
  try {
    const row = JSON.parse(readFileSync(file, 'utf8'));
    if (row && typeof row === 'object' && row.account != null) byAccount.set(Number(row.account), row);
  } catch (error) {
    console.warn(`Skipping invalid result ${file}: ${error.message}`);
  }
}

const rows = Array.from({ length: expectedAccounts }, (_, index) => {
  const account = index + 1;
  return byAccount.get(account) || {
    account,
    name: `account-${account}`,
    status: 'skipped',
    message: 'No login state or cookie secret configured.',
  };
});

const generatedAt = new Date().toISOString();
const historyPath = process.env.MINIMAX_STREAKS_FILE || join(outputDir, 'streaks.json');
const history = existsSync(historyPath)
  ? JSON.parse(readFileSync(historyPath, 'utf8'))
  : { accounts: [] };
if (!Array.isArray(history.accounts)) throw new Error('Invalid streak history: accounts must be an array');
const previousAccounts = new Map(history.accounts.map((row) => [Number(row.account), row]));
for (const row of rows) Object.assign(row, updateStreak(row, previousAccounts.get(row.account), generatedAt));

const counts = {
  checked_in: rows.filter((row) => row.status === 'checked_in').length,
  failed: rows.filter((row) => row.status === 'failed').length,
  skipped: rows.filter((row) => row.status === 'skipped').length,
};
const configured = counts.checked_in + counts.failed;
const expiring = rows
  .filter((row) => typeof row.session?.daysLeft === 'number' && row.session.daysLeft <= sessionWarnDays)
  .sort((a, b) => a.session.daysLeft - b.session.daysLeft);
const rotated = rows.filter((row) => row.rotation?.rotated === true).length;
const headline = counts.failed
  ? `⚠️ ${counts.failed} account(s) need attention`
  : expiring.length
    ? `⏳ ${expiring.length} login(s) expiring within ${sessionWarnDays} day(s)`
    : configured
      ? '✅ All configured accounts OK'
      : '⚠️ No configured accounts';
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;

const lines = [
  '## MiniMax Code daily check-in',
  '',
  `**${headline}**`,
  '',
  '| Metric | Count |',
  '| --- | ---: |',
  `| Configured (ran) | ${configured} |`,
  `| Check-in successful | ${counts.checked_in} |`,
  `| Failed | ${counts.failed} |`,
  `| Skipped (no secret) | ${counts.skipped} |`,
  `| Session secrets rotated | ${rotated} |`,
  `| Logins expiring ≤ ${sessionWarnDays}d | ${expiring.length} |`,
  ...(runUrl ? ['', `- Workflow run: ${runUrl}`] : []),
  '',
];

const failures = rows.filter((row) => row.status === 'failed');
if (failures.length) {
  lines.push('### ⚠️ Needs attention', '', '| # | Account | Error |', '| ---: | --- | --- |');
  for (const row of failures) {
    lines.push(`| ${row.account} | ${escapeCell(row.name)} | ${escapeCell(compact(row.message, 180))} |`);
  }
  lines.push('');
}

const activeRows = rows.filter((row) => row.status !== 'skipped');
if (activeRows.length) {
  lines.push(
    '### Account results',
    '',
    '| # | Account | Status | MiniMax credits | Streak | Site streak | Note |',
    '| ---: | --- | --- | ---: | ---: | ---: | --- |',
  );
  for (const row of activeRows) {
    const badge = row.status === 'checked_in' ? '✅ checked_in' : '❌ failed';
    const credits = typeof row.currentPoints === 'number' && Number.isFinite(row.currentPoints) && row.currentPoints >= 0
      ? row.currentPoints.toLocaleString('en-US') : 'unknown';
    // The site publishes its own cycle streak; ours counts recorded successes.
    const site = Number.isInteger(row.siteStreak) ? row.siteStreak : '—';
    lines.push(`| ${row.account} | ${escapeCell(row.name)} | ${badge} | ${credits} | ${row.streak} | ${site} | ${escapeCell(compact(row.message))} |`);
  }
  lines.push('');
}

lines.push('---', '', '<sub>Status: `checked_in` means claimed or already completed today; `failed` means the session or UI flow needs attention; `skipped` means no secret was configured.</sub>', '');
const markdown = lines.join('\n');
const accounts = rows.map((row) => ({
  account: row.account,
  name: row.name,
  label: row.name,
  status: row.status,
  streak: row.streak,
  lastCheckInDate: row.lastCheckInDate,
  checkInDates: row.checkInDates,
  currentPoints: typeof row.currentPoints === 'number' && Number.isFinite(row.currentPoints) && row.currentPoints >= 0
    ? row.currentPoints : null,
  remainingCredits: typeof row.currentPoints === 'number' && Number.isFinite(row.currentPoints) && row.currentPoints >= 0
    ? row.currentPoints : null,
  siteStreak: Number.isInteger(row.siteStreak) ? row.siteStreak : null,
  finishedAt: row.finishedAt ?? null,
}));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'streaks.json'), `${JSON.stringify({
  generatedAt,
  runUrl,
  title: 'MiniMax Code daily check-in results',
  accounts,
  timeZone: 'Asia/Taipei',
  streakSource: 'recorded_check_ins',
  summary: {
    recorded: accounts.length,
    max: accounts.length ? Math.max(...accounts.map((row) => row.streak)) : 0,
    min: accounts.length ? Math.min(...accounts.map((row) => row.streak)) : 0,
    average: accounts.length ? Number((accounts.reduce((sum, row) => sum + row.streak, 0) / accounts.length).toFixed(1)) : 0,
  },
}, null, 2)}\n`);
writeFileSync(join(outputDir, 'minimax-daily-summary.md'), markdown);
writeFileSync(join(outputDir, 'minimax-daily-summary.json'), `${JSON.stringify({ generatedAt, counts, sessions: { warnDays: sessionWarnDays, rotated, expiringSoon: expiring.map((row) => ({ account: row.account, name: row.name, ...row.session })) }, rows }, null, 2)}\n`);
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: 'a' });
