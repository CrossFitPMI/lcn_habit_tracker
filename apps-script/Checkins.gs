// ═══════════════════════════════════════════════════════════════════════════
// WEEKLY CHECK-INS
//
// Add as a NEW file (Checkins.gs) next to BodyComp.gs. Then add one line to
// doGet and one to doPost in Code.gs (see the instructions), and deploy a
// new version.
//
// One row per client per week. "Week" is the date of that week's Sunday.
// Saving again in the same week replaces the row — the app saves the answers
// first, then again with the AI review once it arrives.
// ═══════════════════════════════════════════════════════════════════════════

const CHECKIN_SHEET = 'Check-ins';
const CHECKIN_HEADERS = [
  'Week', 'Email', 'Name', 'Submitted At',
  'Overall (1-5)', 'Energy (1-5)', 'Hunger (1-5)', 'Sleep (1-5)', 'Stress (1-5)',
  'Last Focus', 'Focus Result', 'Biggest Win', 'Got In The Way', 'Weight (kg)',
  'Review Headline', 'New Focus', 'Tier', 'Review JSON'
];

function checkinJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getCheckinSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CHECKIN_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CHECKIN_SHEET);
    sheet.getRange(1, 1, 1, CHECKIN_HEADERS.length).setValues([CHECKIN_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('@');
  }
  return sheet;
}

function ciDate_(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}
function ciScale_(v) { const n = Number(v); return (n >= 1 && n <= 5) ? Math.round(n) : ''; }
function ciText_(v, max) { return String(v == null ? '' : v).slice(0, max || 500); }

function addCheckin(data) {
  const email = String(data.email || '').toLowerCase().trim();
  const week = ciDate_(data.week);
  if (!email || !/^\d{4}-\d{2}-\d{2}$/.test(week)) return checkinJson_({ error: 'Missing email or week' });

  const r = data.review && typeof data.review === 'object' ? data.review : null;
  const w = Number(data.weight);
  const row = [
    week, email, ciText_(data.name, 60), new Date(),
    ciScale_(data.overall), ciScale_(data.energy), ciScale_(data.hunger), ciScale_(data.sleep), ciScale_(data.stress),
    ciText_(data.lastFocus, 300), ciText_(data.focusResult, 20),
    ciText_(data.win, 500), ciText_(data.struggle, 500),
    (w >= 25 && w <= 350) ? Math.round(w * 10) / 10 : '',
    r ? ciText_(r.headline, 300) : '', r ? ciText_(r.focus, 300) : '',
    ciText_(data.tier, 10), r ? JSON.stringify(r).slice(0, 5000) : ''
  ];

  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (err) { return checkinJson_({ error: 'busy' }); }
  try {
    const sheet = getCheckinSheet_();
    const last = sheet.getLastRow();
    if (last > 1) {
      const keys = sheet.getRange(2, 1, last - 1, CHECKIN_HEADERS.length).getValues();
      for (let i = 0; i < keys.length; i++) {
        if (ciDate_(keys[i][0]) === week && String(keys[i][1]).toLowerCase().trim() === email) {
          // Keep an existing review if this save doesn't carry one
          if (!r) { row[14] = keys[i][14]; row[15] = keys[i][15]; row[17] = keys[i][17]; }
          sheet.getRange(i + 2, 1, 1, row.length).setValues([row]);
          return checkinJson_({ success: true, updated: true });
        }
      }
    }
    sheet.appendRow(row);
    return checkinJson_({ success: true });
  } finally {
    lock.releaseLock();
  }
}

/* Every client's check-ins as plain objects (used by the coach portal too). */
function checkinRows_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CHECKIN_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, CHECKIN_HEADERS.length).getValues();
  return vals.map(function (r) {
    let review = null;
    try { review = r[17] ? JSON.parse(r[17]) : null; } catch (err) {}
    return {
      week: ciDate_(r[0]), email: String(r[1]).toLowerCase().trim(), name: String(r[2] || ''),
      submittedAt: r[3] instanceof Date ? r[3].toISOString() : String(r[3] || ''),
      overall: r[4], energy: r[5], hunger: r[6], sleep: r[7], stress: r[8],
      lastFocus: String(r[9] || ''), focusResult: String(r[10] || ''),
      win: String(r[11] || ''), struggle: String(r[12] || ''), weight: r[13],
      tier: String(r[16] || ''), review: review
    };
  }).filter(function (c) { return c.email && /^\d{4}-\d{2}-\d{2}$/.test(c.week); });
}

function getMyCheckins(e) {
  const email = String(e.parameter.email || '').toLowerCase().trim();
  if (!email) return checkinJson_([]);
  const mine = checkinRows_().filter(function (c) { return c.email === email; })
    .sort(function (a, b) { return a.week < b.week ? -1 : 1; })
    .slice(-12);
  return checkinJson_(mine);
}

/* Run from the editor: saves a test check-in, reads it back, removes it. */
function testCheckins() {
  const em = 'zz-checkin-test@example.com', wk = '2026-10-18';
  Logger.log(addCheckin({ email: em, name: 'ZZ', week: wk, overall: 4, energy: 3, hunger: 2, sleep: 4, stress: 3, win: 'Meal prepped', struggle: 'Late nights' }).getContent());
  Logger.log(addCheckin({ email: em, name: 'ZZ', week: wk, overall: 4, energy: 3, hunger: 2, sleep: 4, stress: 3, win: 'Meal prepped', struggle: 'Late nights',
    review: { headline: 'Solid week', focus: 'Bed by 11 on weeknights' } }).getContent());
  const back = JSON.parse(getMyCheckins({ parameter: { email: em } }).getContent());
  Logger.log(JSON.stringify(back));
  const sheet = getCheckinSheet_(), rows = sheet.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) if (String(rows[i][1]) === em) sheet.deleteRow(i + 1);
  Logger.log(back.length === 1 && back[0].review && back[0].review.focus === 'Bed by 11 on weeknights' ? 'PASS' : 'FAIL');
}