// ═══════════════════════════════════════════════════════════════════════════
// BODY COMPOSITION + COACH PORTAL
//
// Add this as a NEW file in your Lean Comp Apps Script project (the one the
// app's SCRIPT_URL points at), next to Code.gs and Profiles.gs.
//
// Then add four router lines to Code.gs (see the instructions you were sent),
// and Deploy → Manage deployments → edit the live deployment → New version.
// ═══════════════════════════════════════════════════════════════════════════

const BODY_SHEET = 'Body Comp';
const BODY_HEADERS = [
  'ID', 'Date', 'Client Email', 'Client Name',
  'Weight (kg)', 'Muscle (kg)', 'Body Fat (%)', 'Fat Mass (kg)', 'InBody Score',
  'Source', 'Logged At'
];

function bodyJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getBodySheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(BODY_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(BODY_SHEET);
    sheet.getRange(1, 1, 1, BODY_HEADERS.length).setValues([BODY_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange('B:B').setNumberFormat('@');   // keep dates as plain yyyy-MM-dd text
  }
  return sheet;
}

/* Any date value → 'yyyy-MM-dd' in the script's own timezone, so a scan on
   the 3rd never turns into the 2nd on the way out. */
function bodyDate_(v) {
  if (v instanceof Date && !isNaN(v)) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

/* A number in a sensible range, or '' — junk never reaches the sheet. */
function bodyNum_(v, lo, hi) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (!isFinite(n) || n < lo || n > hi) return '';
  return Math.round(n * 10) / 10;
}

function bodyRowsAsObjects_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, BODY_HEADERS.length).getValues();
  return values.map(function (r) {
    const o = {};
    BODY_HEADERS.forEach(function (h, i) { o[h] = r[i]; });
    o['Date'] = bodyDate_(o['Date']);
    o['Logged At'] = o['Logged At'] instanceof Date ? o['Logged At'].toISOString() : String(o['Logged At'] || '');
    return o;
  }).filter(function (o) { return o['Client Email'] && o['Date']; });
}

// ── CLIENT: save one measurement (one per client per day — saving the same
//    day again replaces it, so a typo is fixed by simply re-saving) ──
function addBodyComp(data) {
  const email = String(data.email || '').toLowerCase().trim();
  const date = bodyDate_(data.date);
  const weight = bodyNum_(data.weight, 25, 350);
  if (!email || !/^\d{4}-\d{2}-\d{2}$/.test(date) || weight === '') {
    return bodyJson_({ error: 'Missing email, date or weight' });
  }
  const todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (date > todayStr) return bodyJson_({ error: 'future_date' });

  const source = ['inbody', 'scale', 'weight'].indexOf(String(data.source)) > -1 ? String(data.source) : 'weight';
  const row = [
    String(data.id || '').slice(0, 40) || Utilities.getUuid(),
    date, email, String(data.name || '').slice(0, 60),
    weight,
    bodyNum_(data.muscle, 5, 120),
    bodyNum_(data.bodyFat, 2, 75),
    bodyNum_(data.fatMass, 1, 250),
    bodyNum_(data.score, 0, 120),
    source,
    new Date()
  ];

  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (err) { return bodyJson_({ error: 'busy' }); }
  try {
    const sheet = getBodySheet_();
    const last = sheet.getLastRow();
    if (last > 1) {
      const keys = sheet.getRange(2, 1, last - 1, 3).getValues();   // ID, Date, Email
      for (let i = 0; i < keys.length; i++) {
        if (String(keys[i][2]).toLowerCase().trim() === email && bodyDate_(keys[i][1]) === date) {
          sheet.getRange(i + 2, 1, 1, row.length).setValues([row]);
          return bodyJson_({ success: true, updated: true });
        }
      }
    }
    sheet.appendRow(row);
    return bodyJson_({ success: true });
  } finally {
    lock.releaseLock();
  }
}

// ── CLIENT: delete one of their own measurements ──
function deleteBodyComp(data) {
  const email = String(data.email || '').toLowerCase().trim();
  const id = String(data.id || '');
  const date = bodyDate_(data.date);
  if (!email || (!id && !date)) return bodyJson_({ error: 'Missing email or id' });
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (err) { return bodyJson_({ error: 'busy' }); }
  try {
    const sheet = getBodySheet_();
    const last = sheet.getLastRow();
    if (last < 2) return bodyJson_({ success: true, deleted: 0 });
    const keys = sheet.getRange(2, 1, last - 1, 3).getValues();
    let deleted = 0;
    for (let i = keys.length - 1; i >= 0; i--) {
      const sameClient = String(keys[i][2]).toLowerCase().trim() === email;   // only ever their own rows
      const match = (id && String(keys[i][0]) === id) || (date && bodyDate_(keys[i][1]) === date);
      if (sameClient && match) { sheet.deleteRow(i + 2); deleted++; }
    }
    return bodyJson_({ success: true, deleted: deleted });
  } finally {
    lock.releaseLock();
  }
}

// ── CLIENT: their own measurements, oldest first ──
function getMyBodyComp(e) {
  const email = String(e.parameter.email || '').toLowerCase().trim();
  if (!email) return bodyJson_([]);
  const rows = bodyRowsAsObjects_(getBodySheet_())
    .filter(function (o) { return String(o['Client Email']).toLowerCase().trim() === email; })
    .sort(function (a, b) { return a['Date'] < b['Date'] ? -1 : 1; });
  return bodyJson_(rows);
}

// ═══════════════════════════════════════════════════════════════════════════
// COACH PORTAL  (app.leancompnutrition.com/coach/)
// One call returns everything the portal needs — every client's habit logs,
// body comp and setup answers — but only with the right coach PIN.
// ═══════════════════════════════════════════════════════════════════════════

/* Uses the SAME PIN as the old Coach View (the COACH_PIN script property
   that setCoachPin writes), so there is still only one PIN to change.

   It reads that property directly. It used to go through your existing
   checkCoachPin, but that deliberately waits ~30 seconds on a wrong PIN,
   which is longer than the portal waits — so one mistyped digit looked like
   the server had died. Guessing is still slowed: a short pause on every
   wrong PIN here, plus the lockout in coachGuard_ below. */
function coachPinOk_(pin) {
  pin = String(pin || '').trim();
  if (!pin) return false;
  const stored = String(PropertiesService.getScriptProperties().getProperty('COACH_PIN') || '').trim();
  if (/^\d{4,8}$/.test(stored)) {
    if (stored === pin) return true;
    Utilities.sleep(1500);
    return false;
  }
  // PIN stored some other way (e.g. scrambled) — fall back to asking checkCoachPin
  try {
    if (typeof checkCoachPin === 'function') {
      const out = checkCoachPin({ parameter: { action: 'checkCoachPin', pin: pin }, parameters: { pin: [pin] } });
      const j = JSON.parse(out.getContent());
      if (j && j.ok === true) return true;
      if (j && j.ok === false) return false;
    }
  } catch (err) { /* fall through to reading the stored PIN directly */ }
  const props = PropertiesService.getScriptProperties();
  const keys = ['COACH_PIN', 'coachPin', 'COACHPIN', 'coach_pin'];
  for (let i = 0; i < keys.length; i++) {
    const v = props.getProperty(keys[i]);
    if (v && String(v).trim() === pin) return true;
  }
  return false;
}

/* Slows down anyone trying to guess the PIN: after 8 wrong tries in 15
   minutes the portal refuses ALL logins for 15 minutes (including yours —
   just wait it out). */
function coachGuard_(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('coach_fail_count') || 0);
  if (fails >= 8) return { ok: false, error: 'locked' };
  if (coachPinOk_(pin)) return { ok: true };
  cache.put('coach_fail_count', String(fails + 1), 900);
  return { ok: false, error: 'unauthorised' };
}

/* Finds the daily habit log sheet. Tries "Habit Log" by name first (instant);
   only if that's missing does it check every tab's headers, which is slow. */
function findHabitLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const named = ss.getSheetByName('Habit Log');
  if (named) return named;
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const sh = sheets[i];
    if (sh.getLastRow() < 1 || sh.getLastColumn() < 3) continue;
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    if (head.indexOf('Water (L)') > -1 && head.indexOf('Date') > -1 &&
        (head.indexOf('Client Email') > -1 || head.indexOf('Client Name') > -1)) return sh;
  }
  return null;
}

function sheetAsObjects_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const head = values.shift().map(String);
  return values.map(function (r) {
    const o = {};
    head.forEach(function (h, i) {
      let v = r[i];
      if (v instanceof Date) v = (h === 'Date') ? bodyDate_(v) : v.toISOString();
      o[h] = v;
    });
    return o;
  });
}

function coachData(e) {
  const guard = coachGuard_(e.parameter.pin);
  if (!guard.ok) return bodyJson_({ error: guard.error });
  return bodyJson_(coachPayload_());
}

function coachPayload_() {
  const logs = sheetAsObjects_(findHabitLogSheet_())
    .filter(function (o) { return o['Date'] && (o['Client Email'] || o['Client Name']); });

  const body = bodyRowsAsObjects_(getBodySheet_());

  let profiles = [];
  const ps = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Profiles');
  if (ps && ps.getLastRow() > 1) {
    const vals = ps.getDataRange().getValues();
    const head = vals.shift().map(String);
    const iEmail = head.indexOf('Email'), iName = head.indexOf('Name'), iJson = head.indexOf('Profile JSON');
    profiles = vals.map(function (r) {
      let p = null;
      try { p = JSON.parse(r[iJson]); } catch (err) {}
      return { email: String(r[iEmail] || '').toLowerCase().trim(), name: String(r[iName] || ''), profile: p };
    }).filter(function (x) { return x.email; });
  }

  // Weekly check-ins (Checkins.gs) — empty until that file is added
  const checkins = (typeof checkinRows_ === 'function') ? checkinRows_() : [];

  return { ok: true, generatedAt: new Date().toISOString(), logs: logs, body: body, profiles: profiles, checkins: checkins };
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN THESE FROM THE EDITOR TO CHECK IT ALL WORKS
// ═══════════════════════════════════════════════════════════════════════════

/* Saves a test measurement, reads it back, deletes it. Look for PASS. */
function testBodyComp() {
  const em = 'zz-body-test@example.com';
  const d = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  Logger.log('save   -> ' + addBodyComp({ email: em, name: 'ZZ Test', date: d, weight: 80.4, muscle: 35.2, bodyFat: 21.5, source: 'inbody' }).getContent());
  Logger.log('resave -> ' + addBodyComp({ email: em, name: 'ZZ Test', date: d, weight: 80.1, source: 'scale' }).getContent());
  const back = JSON.parse(getMyBodyComp({ parameter: { email: em } }).getContent());
  Logger.log('read   -> ' + JSON.stringify(back));
  Logger.log('delete -> ' + deleteBodyComp({ email: em, date: d }).getContent());
  Logger.log(back.length === 1 && back[0]['Weight (kg)'] === 80.1 ? 'PASS' : 'FAIL');
}

/* Checks the portal can find your habit logs and recognise your PIN setup.
   Doesn't print the PIN itself. */
function testCoachPortal() {
  const sh = findHabitLogSheet_();
  Logger.log('Habit log sheet: ' + (sh ? '"' + sh.getName() + '" with ' + (sh.getLastRow() - 1) + ' rows' : 'NOT FOUND'));
  Logger.log('checkCoachPin function: ' + (typeof checkCoachPin === 'function' ? 'found' : 'NOT FOUND'));
  Logger.log('Script property names: ' + PropertiesService.getScriptProperties().getKeys().join(', '));
  Logger.log('Wrong PIN rejected: ' + (coachPinOk_('0000-not-a-pin') === false ? 'yes' : 'NO — tell Claude'));
  CacheService.getScriptCache().remove('coach_fail_count');
  Logger.log('Login lockout counter reset.');
}

/* Times each part of a portal login, so we can see what's slow. */
function testCoachSpeed() {
  let t = Date.now();
  const ok = coachPinOk_('0000-not-a-pin');
  Logger.log('Wrong-PIN check: ' + (Date.now() - t) + ' ms (should be about 1500)  rejected=' + (ok === false));
  t = Date.now();
  const sh = findHabitLogSheet_();
  Logger.log('Find habit log: ' + (Date.now() - t) + ' ms  (' + (sh ? sh.getName() : 'NOT FOUND') + ')');
  t = Date.now();
  const p = coachPayload_();
  Logger.log('Read all data: ' + (Date.now() - t) + ' ms  (' + p.logs.length + ' logs, ' + p.body.length + ' body entries, ' + p.profiles.length + ' profiles)');
  Logger.log('PIN stored as plain digits: ' + /^\d{4,8}$/.test(String(PropertiesService.getScriptProperties().getProperty('COACH_PIN') || '').trim()));
  CacheService.getScriptCache().remove('coach_fail_count');
}

/* If you ever lock yourself out with wrong PINs, run this to unlock at once. */
function resetCoachLockout() {
  CacheService.getScriptCache().remove('coach_fail_count');
  Logger.log('Unlocked.');
}