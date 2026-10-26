/**
 * test-tax-dates.ts — worked examples for the compliance date helpers in
 * src/lib/taxYear.ts (register §G retention, §H SA deadline + MTD quarters).
 * Every date below is hand-derived from the verbatim register entries; the §G
 * retention case cross-checks HMRC's own published example.
 *
 * Run:  npx tsx scripts/test-tax-dates.ts   (or: npm run test:tax)
 */

import {
  currentMtdQuarter,
  daysUntil,
  getTaxYear,
  monthsUntil,
  mtdQuarters,
  nextMtdUpdate,
  recordsRetentionUntil,
  saDeadline,
  poaJulyDeadline,
  nextSelfAssessmentDeadline,
  nextPoaJulyDeadline,
  taxYearDates,
  taxYearStartYear,
} from '../src/lib/taxYear';

let failures = 0;
let checks = 0;

function check(name: string, actual: number | string | boolean | null, expected: number | string | boolean | null) {
  checks++;
  if (actual !== expected) {
    failures++;
    console.error(`  ✗ ${name}: expected ${expected}, got ${actual}`);
  }
}

/** Compare a Date to an expected local Y-M-D. */
function checkDate(name: string, actual: Date, y: number, m: number, d: number) {
  check(`${name}`, `${actual.getFullYear()}-${actual.getMonth() + 1}-${actual.getDate()}`, `${y}-${m}-${d}`);
}

console.log('Compliance date worked examples — register §G/§H\n');

{ // D1. Tax-year string parsing + boundaries (6 April → 5 April).
  check('D1 parse · 2026-27', taxYearStartYear('2026-27'), 2026);
  const { start, end } = taxYearDates('2026-27');
  checkDate('D1 start 6 Apr 2026', start, 2026, 4, 6);
  checkDate('D1 end 5 Apr 2027', end, 2027, 4, 5);
  check('D1 getTaxYear boundary · 5 Apr', getTaxYear(new Date(2026, 3, 5)), '2025-26');
  check('D1 getTaxYear boundary · 6 Apr', getTaxYear(new Date(2026, 3, 6)), '2026-27');
  let threw = false;
  try { taxYearStartYear('2026-28'); } catch { threw = true; }
  check('D1 malformed year throws', threw, true);
}

{ // D2. SA deadline (§H): 31 January following the end of the tax year.
  checkDate('D2 SA deadline · 2026-27 → 31 Jan 2028', saDeadline('2026-27'), 2028, 1, 31);
  checkDate('D2 SA deadline · 2025-26 → 31 Jan 2027', saDeadline('2025-26'), 2027, 1, 31);
  // Second POA (§N/SALF303): 31 July following the 31 Jan balancing/first-POA date.
  checkDate('D2 POA July · 2026-27 → 31 Jul 2028', poaJulyDeadline('2026-27'), 2028, 7, 31);
  checkDate('D2 POA July · 2025-26 → 31 Jul 2027', poaJulyDeadline('2025-26'), 2027, 7, 31);

  // The IMMINENT next 31 Jan / 31 Jul a deadline REMINDER must track (owning year
  // = calendar year − 2), distinct from the in-progress year's far deadline.
  const saDec = nextSelfAssessmentDeadline(new Date(2027, 11, 1)); // 1 Dec 2027
  checkDate('D2 next SA · 1 Dec 2027 → 31 Jan 2028', saDec.date, 2028, 1, 31);
  check('D2 next SA · owning year 2026-27', saDec.taxYear, '2026-27');
  const saOnDay = nextSelfAssessmentDeadline(new Date(2028, 0, 31)); // the 31st still counts
  checkDate('D2 next SA · on 31 Jan 2028 → same day', saOnDay.date, 2028, 1, 31);
  const saFeb = nextSelfAssessmentDeadline(new Date(2028, 1, 1)); // 1 Feb 2028 → next year
  checkDate('D2 next SA · 1 Feb 2028 → 31 Jan 2029', saFeb.date, 2029, 1, 31);
  check('D2 next SA · owning year 2027-28', saFeb.taxYear, '2027-28');
  const poaJun = nextPoaJulyDeadline(new Date(2028, 5, 1)); // 1 Jun 2028
  checkDate('D2 next POA · 1 Jun 2028 → 31 Jul 2028', poaJun.date, 2028, 7, 31);
  check('D2 next POA · owning year 2026-27', poaJun.taxYear, '2026-27');
}

{ // D3. Records retention (§G): 5 years after the 31 Jan deadline. HMRC's own
  // example: a 2022-23 return (deadline 31 Jan 2024) → keep until at least the
  // end of January 2029.
  checkDate('D3 retention · HMRC example 2022-23 → Jan 2029', recordsRetentionUntil('2022-23'), 2029, 1, 31);
  checkDate('D3 retention · 2026-27 → Jan 2033', recordsRetentionUntil('2026-27'), 2033, 1, 31);
}

{ // D4. Standard MTD quarters for 2026-27 (§H): slices 6 Apr–5 Jul / 6 Jul–5 Oct /
  // 6 Oct–5 Jan / 6 Jan–5 Apr; deadlines 7 Aug / 7 Nov / 7 Feb / 7 May.
  const q = mtdQuarters('2026-27', 'standard');
  checkDate('D4 Q1 start', q[0].start, 2026, 4, 6);
  checkDate('D4 Q1 end', q[0].end, 2026, 7, 5);
  checkDate('D4 Q1 deadline 7 Aug', q[0].deadline, 2026, 8, 7);
  checkDate('D4 Q2 end', q[1].end, 2026, 10, 5);
  checkDate('D4 Q2 deadline 7 Nov', q[1].deadline, 2026, 11, 7);
  checkDate('D4 Q3 start', q[2].start, 2026, 10, 6);
  checkDate('D4 Q3 end (spills to 2027)', q[2].end, 2027, 1, 5);
  checkDate('D4 Q3 deadline 7 Feb', q[2].deadline, 2027, 2, 7);
  checkDate('D4 Q4 start', q[3].start, 2027, 1, 6);
  checkDate('D4 Q4 end', q[3].end, 2027, 4, 5);
  checkDate('D4 Q4 deadline 7 May', q[3].deadline, 2027, 5, 7);
}

{ // D5. Calendar-election quarters (§H): 1 Apr starts, month-end slices, SAME
  // deadlines as standard.
  const q = mtdQuarters('2026-27', 'calendar');
  checkDate('D5 Q1 1 Apr – 30 Jun (start)', q[0].start, 2026, 4, 1);
  checkDate('D5 Q1 end', q[0].end, 2026, 6, 30);
  checkDate('D5 Q3 end 31 Dec', q[2].end, 2026, 12, 31);
  checkDate('D5 Q4 31 Mar', q[3].end, 2027, 3, 31);
  checkDate('D5 deadlines unchanged · Q1', q[0].deadline, 2026, 8, 7);
  checkDate('D5 deadlines unchanged · Q4', q[3].deadline, 2027, 5, 7);
}

{ // D6. currentMtdQuarter: mid-June 2026 sits in Q1 (standard) — and in
  // calendar mode too (Q1 runs to 30 Jun); July 6 opens standard Q2; after
  // 5 Apr 2027 the year is over (null); before the year opens, clamp to Q1.
  check('D6 11 Jun → Q1', currentMtdQuarter('2026-27', new Date(2026, 5, 11))?.index ?? null, 1);
  check('D6 11 Jun calendar → Q1', currentMtdQuarter('2026-27', new Date(2026, 5, 11), 'calendar')?.index ?? null, 1);
  check('D6 6 Jul → Q2', currentMtdQuarter('2026-27', new Date(2026, 6, 6))?.index ?? null, 2);
  check('D6 5 Apr 27 → Q4', currentMtdQuarter('2026-27', new Date(2027, 3, 5))?.index ?? null, 4);
  check('D6 6 Apr 27 → year over', currentMtdQuarter('2026-27', new Date(2027, 3, 6))?.index ?? null, null);
  check('D6 pre-year clamp → Q1', currentMtdQuarter('2026-27', new Date(2026, 2, 1))?.index ?? null, 1);
}

{ // D7. Countdown helpers. 11 Jun → 5 Jul inclusive-of-deadline-day = 25 days;
  // monthsUntil drives the set-aside divisor (Jun 2026 → Jan 2028 = 19 months;
  // never below 1 even past the date).
  check('D7 daysUntil · 11 Jun → 5 Jul = 25', daysUntil(new Date(2026, 6, 5), new Date(2026, 5, 11)), 25);
  check('D7 daysUntil past date → 0', daysUntil(new Date(2026, 5, 1), new Date(2026, 5, 11)), 0);
  check('D7 monthsUntil · Jun 26 → Jan 28 = 19', monthsUntil(new Date(2028, 0, 31), new Date(2026, 5, 11)), 19);
  check('D7 monthsUntil floor 1', monthsUntil(new Date(2028, 0, 31), new Date(2028, 0, 15)), 1);
}

{ // D8. nextMtdUpdate (§H): the imminent submission deadline at/after `now`,
  // spanning the previous + current tax years so the prior year's trailing Q4
  // (due 7 May) isn't skipped in the 6 Apr–7 May window after the year rolls.
  const jun = nextMtdUpdate(new Date(2026, 5, 11)); // 11 Jun 2026 → Q1 due 7 Aug 2026
  check('D8 11 Jun 26 → tax year 2026-27', jun?.taxYear ?? null, '2026-27');
  check('D8 11 Jun 26 → Q1', jun?.quarter.index ?? null, 1);
  checkDate('D8 11 Jun 26 → due 7 Aug 2026', jun!.quarter.deadline, 2026, 8, 7);
  // Just past the Q1 deadline → Q2 (7 Nov 2026).
  checkDate('D8 8 Aug 26 → due 7 Nov 2026', nextMtdUpdate(new Date(2026, 7, 8))!.quarter.deadline, 2026, 11, 7);
  // The key edge: 20 Apr 2027 is in tax year 2027-28, but the prior year's Q4
  // update (covering to 5 Apr 2027) is still due 7 May 2027 — not skipped.
  const aprEdge = nextMtdUpdate(new Date(2027, 3, 20));
  check('D8 20 Apr 27 edge → prior year 2026-27', aprEdge?.taxYear ?? null, '2026-27');
  check('D8 20 Apr 27 edge → Q4', aprEdge?.quarter.index ?? null, 4);
  checkDate('D8 20 Apr 27 edge → due 7 May 2027', aprEdge!.quarter.deadline, 2027, 5, 7);
  // After 7 May 2027 the new year's Q1 (due 7 Aug 2027) is next.
  checkDate('D8 8 May 27 → due 7 Aug 2027', nextMtdUpdate(new Date(2027, 4, 8))!.quarter.deadline, 2027, 8, 7);
}

// ─────────────────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n❌ ${failures}/${checks} checks FAILED`);
  process.exit(1);
}
console.log(`✅ All ${checks} checks passed (8 date worked examples, §G/§H)`);
