const DAY_MS = 86_400_000;

export function taipeiDate(timestamp) {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) throw new Error(`Invalid check-in timestamp: ${timestamp}`);
  return new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function updateStreak(row, previous, generatedAt) {
  const dates = previous?.checkInDates ?? [];
  if (!Array.isArray(dates) || !dates.every(validDate)) {
    throw new Error(`Invalid check-in history for account ${row.account}`);
  }
  const confirmed = new Set(dates);
  if (row.status === 'checked_in') {
    // Use the account's completion date, even if summary generation crosses midnight.
    // Missing timestamps cannot establish which day was successfully checked in.
    if (row.finishedAt) confirmed.add(taipeiDate(row.finishedAt));
  }
  const checkInDates = [...confirmed].sort();
  const lastCheckInDate = checkInDates.at(-1) ?? null;
  let streak = 0;
  const today = Date.parse(taipeiDate(generatedAt));
  if (lastCheckInDate) {
    const age = (today - Date.parse(lastCheckInDate)) / DAY_MS;
    // A failed retry today must not erase yesterday's still-continuable streak.
    if (age >= 0 && age <= 1) {
      streak = 1;
      for (let i = checkInDates.length - 2; i >= 0; i--) {
        if (Date.parse(checkInDates[i + 1]) - Date.parse(checkInDates[i]) !== DAY_MS) break;
        streak++;
      }
    }
  }
  return { streak, lastCheckInDate, checkInDates };
}
