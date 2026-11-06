// Lean Comp Nutrition — Habit Tracker Google Apps Script
// Paste this into Apps Script attached to your Google Sheet
// Deploy as Web App: Execute as Me, Anyone can access

const SHEET_NAME = 'Habit Log';

function doGet(e) {
  const action = e.parameter.action;
  if (action === 'version')        return jsonOut_({ marker: 'SEPT15-DEDUPE' });
  if (action === 'unsubscribe')    return handleUnsubscribe(e);
  if (action === 'getMyLogs')      return getMyLogs(e);
  if (action === 'getLeaderboard') return getLeaderboard(e);
  if (action === 'getMyPrefs')     return getMyPrefs(e);
  if (action === 'getMyTargets')   return getMyTargets(e);
  if (action === 'coachLogs')      return coachLogs(e);
  if (action === 'checkCoachPin')  return checkCoachPin(e);
  if (action === 'getLogs')        return jsonOut_({error:'gone'});
  if (action === 'getPrefs')       return jsonOut_({error:'gone'});
  if (action === 'getMealPrefs')   return getMealPrefs(e);
  if (action === 'getProfile')     return getProfile(e);
  if (action === 'getMyBodyComp') return getMyBodyComp(e);
  if (action === 'getMyCheckins') return getMyCheckins(e);
  if (action === 'coachData') return coachData(e);
  return ContentService.createTextOutput(JSON.stringify({ error: 'Unknown action' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  if (data.action === 'addLog') return addLog(data);
  if (data.action === 'updateLog') return updateLog(data);
  if (data.action === 'setPref') return setPref(data);
  if (data.action === 'setMealPrefs') return setMealPrefs(data);
  if (data.action === 'setProfile') return setProfile(data);
  if (data.action === 'addBodyComp') return addBodyComp(data);
  if (data.action === 'addCheckin') return addCheckin(data);
  if (data.action === 'deleteBodyComp') return deleteBodyComp(data);
  return ContentService.createTextOutput(JSON.stringify({ error: 'Unknown action' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow([
      'ID', 'Date', 'Client Name',
      'Water (L)', 'Protein Target Hit', 'No Alcohol',
      'Exercise Completed', 'Sleep (hrs)', 'Steps',
      'Fruit & Veg Portions', 'Score', 'Notes', 'Timestamp', 'Client Email'
    ]);
    sheet.setFrozenRows(1);
  } else {
    // Self-heal: your sheet already exists from before "Client Email" was added.
    // This adds the column once, automatically, without you touching the sheet by hand.
    // It only ever appends a new column — it never reorders or rewrites existing ones.
    const lastCol = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    if (headers.indexOf('Client Email') === -1) {
      sheet.getRange(1, lastCol + 1).setValue('Client Email');
    }
  }
  return sheet;
}

function addLog(data) {
  /* Two clients (or two taps) hitting this at once used to append two rows.
     A script lock serialises them so the duplicate check below can't be
     raced past. */
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      error: 'busy', message: 'Server was busy — try saving again.'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const sheet = getSheet();
    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    const date = String(data.date || '').slice(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return ContentService.createTextOutput(JSON.stringify({
        error: 'bad_date', message: 'That date did not look right.'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    /* Compared in the sheet's own timezone, not UTC — otherwise an Irish
       evening log looks like tomorrow and gets rejected. */
    const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    if (date > todayStr) {
      return ContentService.createTextOutput(JSON.stringify({
        error: 'future_date', message: "You can't log a day that hasn't happened yet."
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const email = String(data.clientEmail || '').toLowerCase().trim();
    const name  = String(data.clientName || '').trim();

    const values = [
      date,
      data.clientName,
      data.water,
      data.proteinHit ? 'Yes' : 'No',
      data.noAlcohol ? 'Yes' : 'No',
      data.exercise ? 'Yes' : 'No',
      data.sleep,
      data.steps,
      data.fruitsVeg,
      data.score || 0,
      data.notes || '',
      new Date().toISOString(),
      data.clientEmail || ''
    ];

    /* One log per client per day. If today's row already exists, overwrite it
       and keep the original ID — otherwise every average, streak and badge
       counts that day twice. */
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      let rowDate = rows[i][1];
      rowDate = (rowDate instanceof Date)
        ? Utilities.formatDate(rowDate, tz, 'yyyy-MM-dd')
        : String(rowDate).slice(0, 10);
      if (rowDate !== date) continue;

      const rowEmail = String(rows[i][13] || '').toLowerCase().trim();
      // Match on email where we have one; fall back to name for pre-email rows.
      const same = email ? (rowEmail === email)
                         : (!rowEmail && String(rows[i][2] || '').trim() === name);
      if (!same) continue;

      const id = rows[i][0];
      sheet.getRange(i + 1, 1, 1, 14).setValues([[id].concat(values)]);
      return ContentService.createTextOutput(JSON.stringify({
        success: true, id: id, updated: true
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const id = Date.now();
    sheet.appendRow([id].concat(values));
    return ContentService.createTextOutput(JSON.stringify({ success: true, id: id }))
      .setMimeType(ContentService.MimeType.JSON);

  } finally {
    lock.releaseLock();
  }
}

function getLogs(e) {
  const sheet = getSheet();
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const logs = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      let v = row[i];
      // Sheets stores picked dates as midnight LOCAL time; raw JSON
      // serialization converts to UTC, which lands on the previous day
      // in summer (Irish time = UTC+1). Format the Date column in the
      // sheet's own timezone so the day is always the day the client picked.
      if (h === 'Date' && v instanceof Date) {
        v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      }
      obj[h] = v;
    });
    return obj;
  }).reverse();
  return ContentService.createTextOutput(JSON.stringify(logs))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Leaderboard preferences ────────────────────────────────────────────────
// Stores which clients have chosen to hide themselves from the streak board.
// Lives in its own small sheet so it never touches the habit log data.

const PREFS_SHEET = 'Leaderboard Prefs';

function getPrefsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(PREFS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PREFS_SHEET);
    sheet.appendRow(['Email', 'Hidden', 'Updated']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function setPref(data) {
  const email = String(data.email || '').toLowerCase().trim();
  if (!email) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Missing email' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const sheet = getPrefsSheet();
  const rows = sheet.getDataRange().getValues();
  const hidden = data.hidden ? 'Yes' : 'No';
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() === email) {
      sheet.getRange(i + 1, 2, 1, 2).setValues([[hidden, new Date().toISOString()]]);
      return ContentService.createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }
  sheet.appendRow([email, hidden, new Date().toISOString()]);
  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getPrefs() {
  const sheet = getPrefsSheet();
  const rows = sheet.getDataRange().getValues();
  const prefs = rows.slice(1).map(r => ({
    email: String(r[0]).toLowerCase(),
    hidden: r[1] === 'Yes',
  }));
  return ContentService.createTextOutput(JSON.stringify(prefs))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Meal plan preferences ──────────────────────────────────────────────────
// One row per client: their questionnaire answers as JSON. Allergies and
// avoid-lists live in here, so this is coaching-critical data.

const MEAL_PREFS_SHEET = 'Meal Prefs';

function getMealPrefsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(MEAL_PREFS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MEAL_PREFS_SHEET);
    sheet.appendRow(['Email', 'Prefs JSON', 'Updated']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function setMealPrefs(data) {
  const email = String(data.email || '').toLowerCase().trim();
  if (!email) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Missing email' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const sheet = getMealPrefsSheet();
  const rows = sheet.getDataRange().getValues();
  const json = JSON.stringify(data.prefs || {});
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() === email) {
      sheet.getRange(i + 1, 2, 1, 2).setValues([[json, new Date().toISOString()]]);
      return ContentService.createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }
  sheet.appendRow([email, json, new Date().toISOString()]);
  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getMealPrefs(e) {
  const email = String(e.parameter.email || '').toLowerCase().trim();
  const sheet = getMealPrefsSheet();
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() === email) {
      let prefs = {};
      try { prefs = JSON.parse(rows[i][1]); } catch (err) {}
      return ContentService.createTextOutput(JSON.stringify(prefs))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService.createTextOutput(JSON.stringify(null))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════════
// ONE-TIME MIGRATION — fixes the shifted-columns bug at the source.
//
// THE BUG: the sheet's header row was written by the original script, before
// 'Exercise Completed', 'Score' and 'Client Email' existed. Newer rows are
// written with those extra values, so every value since then sits one or two
// columns out of step with the headers — which is why "7000 PORTIONS" shows
// up where fruit & veg should be.
//
// WHAT THIS DOES:
//   1. Makes a full backup copy of the sheet first (nothing is ever lost).
//   2. Rewrites the header row to the correct current layout.
//   3. Detects each row's format and only re-shuffles the genuinely old rows
//      (11-value format). Newer rows were already written in the right order
//      — the headers were the problem — so they're left untouched.
//
// HOW TO RUN (in the Apps Script editor):
//   1. Pick "migrateDryRun" in the function dropdown next to Run ▶, click Run.
//      Then open Execution log (View → Logs). It reports what WOULD change,
//      touching nothing.
//   2. If the numbers look right, pick "migrateApply" and Run. Done.
//   3. Reload the app — My History should now label everything correctly.
// ═══════════════════════════════════════════════════════════════════════════

const CORRECT_HEADERS = [
  'ID', 'Date', 'Client Name',
  'Water (L)', 'Protein Target Hit', 'No Alcohol',
  'Exercise Completed', 'Sleep (hrs)', 'Steps',
  'Fruit & Veg Portions', 'Score', 'Notes', 'Timestamp', 'Client Email'
];

function migrateDryRun() { migrateShiftedRows_(true); }
function migrateApply()  { migrateShiftedRows_(false); }

function migrateShiftedRows_(dryRun) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log('Sheet "' + SHEET_NAME + '" not found — nothing to do.'); return; }

  const all = sheet.getDataRange().getValues();
  const dataRows = all.slice(1);
  let oldFormat = 0, newFormat = 0, unknown = 0;
  const fixed = [];

  dataRows.forEach(function(row, i) {
    // Detection: in the NEW write order, position 7 is 'Exercise Completed'
    // ('Yes'/'No'). In the OLD order, position 7 was 'Sleep (hrs)' (a number).
    const v7 = row[6];
    if (v7 === 'Yes' || v7 === 'No') {
      // New-format row: values already in the correct order. Keep as-is,
      // padded/trimmed to 14 columns.
      newFormat++;
      const r = row.slice(0, 14);
      while (r.length < 14) r.push('');
      fixed.push(r);
    } else if (v7 === '' || typeof v7 === 'number' || !isNaN(parseFloat(v7))) {
      // Old-format row (11 values, no Exercise/Score/Email):
      // [ID, Date, Name, Water, Protein, NoAlc, Sleep, Steps, FV, Notes, Timestamp]
      oldFormat++;
      fixed.push([
        row[0], row[1], row[2],           // ID, Date, Client Name
        row[3], row[4], row[5],           // Water, Protein, No Alcohol
        '',                                // Exercise Completed — never recorded for these
        row[6], row[7], row[8],           // Sleep, Steps, Fruit & Veg
        '',                                // Score — front-ends recompute this anyway
        row[9]  !== undefined ? row[9]  : '',  // Notes
        row[10] !== undefined ? row[10] : '',  // Timestamp
        ''                                 // Client Email — predates email capture
      ]);
    } else {
      // Doesn't match either known shape — leave untouched and flag it.
      unknown++;
      Logger.log('Row ' + (i + 2) + ' does not match either known format — left as-is: ' + JSON.stringify(row));
      const r = row.slice(0, 14);
      while (r.length < 14) r.push('');
      fixed.push(r);
    }
  });

  Logger.log('── Migration ' + (dryRun ? 'DRY RUN (no changes made)' : 'APPLYING') + ' ──');
  Logger.log('Rows total: ' + dataRows.length);
  Logger.log('Old-format rows to re-shuffle: ' + oldFormat);
  Logger.log('New-format rows (kept as written, headers fixed): ' + newFormat);
  Logger.log('Unrecognised rows (left untouched): ' + unknown);

  if (dryRun) {
    Logger.log('Looks right? Run migrateApply to make it real. A backup is taken automatically first.');
    return;
  }

  // 1. Backup before touching anything.
  const backupName = SHEET_NAME + ' backup ' + new Date().toISOString().slice(0, 10);
  if (!ss.getSheetByName(backupName)) {
    sheet.copyTo(ss).setName(backupName);
    Logger.log('Backup created: "' + backupName + '"');
  } else {
    Logger.log('Backup "' + backupName + '" already exists from an earlier run today — reusing it.');
  }

  // 2. Correct headers + corrected rows, written in one pass.
  sheet.clearContents();
  sheet.getRange(1, 1, 1, CORRECT_HEADERS.length).setValues([CORRECT_HEADERS]);
  if (fixed.length) {
    sheet.getRange(2, 1, fixed.length, 14).setValues(fixed);
  }
  sheet.setFrozenRows(1);
  Logger.log('Done. Reload the app and check My History — labels should now be correct.');
}

// ═══════════════════════════════════════════════════════════════════════════
// DUPLICATE TOOLS
// ═══════════════════════════════════════════════════════════════════════════

/* Proves the one-log-per-day rule works: saves the same test day twice and
   checks only one row results. Cleans up after itself. */
function testNoDuplicates(){
  const testEmail = 'zz-test@example.com';
  const d = Utilities.formatDate(new Date(),
              SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  const make = function(water){
    return { date: d, clientName: 'ZZ Test', clientEmail: testEmail,
             water: water, sleep: 8, steps: 9000, fruitsVeg: 5,
             proteinHit: true, noAlcohol: true, exercise: true, score: 99, notes: 'test' };
  };
  Logger.log('1st save -> ' + addLog(make(2)).getContent());
  Logger.log('2nd save -> ' + addLog(make(3)).getContent());

  const sheet = getSheet();
  const rows = sheet.getDataRange().getValues();
  let found = 0, water = null, lastRow = -1;
  for (let i = rows.length - 1; i >= 1; i--){
    if (String(rows[i][13]).toLowerCase() === testEmail){ found++; water = rows[i][3]; lastRow = i + 1; }
  }
  Logger.log(found === 1 ? ('PASS - one row only, water=' + water + ' (should be 3)')
                         : ('FAIL - ' + found + ' rows created'));
  if (lastRow > 0){ sheet.deleteRow(lastRow); Logger.log('Test row cleaned up.'); }
}

/* Reports any client/day that appears more than once. Run before and after
   the cleanup to confirm it did what you expected. Changes nothing. */
function checkDuplicates(){
  const sheet = getSheet();
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const rows = sheet.getDataRange().getValues();
  Logger.log('Total data rows: ' + (rows.length - 1));
  const seen = {};
  rows.slice(1).forEach(function(r, i){
    let d = r[1];
    d = (d instanceof Date) ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : String(d).slice(0,10);
    const key = String(r[13]||'').toLowerCase().trim() + '  |  ' + d;
    if (!seen[key]) seen[key] = [];
    seen[key].push('row ' + (i+2) + ' id=' + r[0] + ' written=' + r[12]);
  });
  let dupes = 0;
  Object.keys(seen).forEach(function(k){
    if (seen[k].length > 1){
      dupes++;
      Logger.log('DUPLICATE  ' + k);
      seen[k].forEach(function(x){ Logger.log('    ' + x); });
    }
  });
  Logger.log(dupes ? (dupes + ' duplicate group(s) found.') : 'No duplicates.');
}

/* Removes duplicate rows, keeping the LAST-written row for each client/day —
   the one the client most recently intended. Takes a backup first.
   Run cleanDuplicates (dry run) before cleanDuplicatesApply. */
function cleanDuplicates(){ cleanDuplicates_(true); }
function cleanDuplicatesApply(){ cleanDuplicates_(false); }

function cleanDuplicates_(dryRun){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getSheet();
  const tz = ss.getSpreadsheetTimeZone();
  const rows = sheet.getDataRange().getValues();

  const groups = {};
  for (let i = 1; i < rows.length; i++){
    let d = rows[i][1];
    d = (d instanceof Date) ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : String(d).slice(0,10);
    const email = String(rows[i][13]||'').toLowerCase().trim();
    const key = (email || ('name:' + String(rows[i][2]||'').trim())) + '|' + d;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ row: i + 1, written: String(rows[i][12]||''), id: rows[i][0] });
  }

  const toDelete = [];
  Object.keys(groups).forEach(function(k){
    const g = groups[k];
    if (g.length < 2) return;
    /* Keep the most recently written. Rows with a blank Timestamp sort first,
       so they're the ones dropped — correct, since a blank timestamp means an
       old row that predates a later correction. */
    g.sort(function(a,b){ return a.written < b.written ? -1 : (a.written > b.written ? 1 : a.row - b.row); });
    const keep = g[g.length - 1];
    Logger.log(k + '  -> keeping row ' + keep.row + ' (written ' + (keep.written||'blank') + ')');
    g.slice(0, -1).forEach(function(x){
      Logger.log('      deleting row ' + x.row + ' (written ' + (x.written||'blank') + ')');
      toDelete.push(x.row);
    });
  });

  if (!toDelete.length){ Logger.log('Nothing to delete.'); return; }
  Logger.log((dryRun ? '[DRY RUN] ' : '') + toDelete.length + ' row(s) would be deleted, across ' +
             Object.keys(groups).filter(function(k){ return groups[k].length > 1; }).length + ' group(s).');

  if (dryRun){ Logger.log('Happy with that? Run cleanDuplicatesApply.'); return; }

  const backupName = SHEET_NAME + ' pre-dedupe ' + new Date().toISOString().slice(0,16).replace(':','');
  sheet.copyTo(ss).setName(backupName);
  Logger.log('Backup created: "' + backupName + '"');

  // Delete bottom-up so earlier row numbers stay valid as rows shift.
  toDelete.sort(function(a,b){ return b - a; }).forEach(function(r){ sheet.deleteRow(r); });
  Logger.log('Deleted ' + toDelete.length + ' row(s).');
}
/* Calls the DEPLOYED web app the same way index.html does. If the deployment
   is serving old code, the second call returns a new id instead of updated:true. */
function testLiveEndpoint(){
  const url = 'https://script.google.com/macros/s/AKfycby0FsfiEBZcbaoLtNtfExIpHNaRkuylq-qjrLZITIQIJUn4JQKuvrlfmm4wiyWbQvmf/exec';
  const d = Utilities.formatDate(new Date(),
              SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  const payload = function(water){
    return JSON.stringify({ action:'addLog', date:d, clientName:'ZZ Live Test',
      clientEmail:'zz-live@example.com', water:water, sleep:8, steps:9000,
      fruitsVeg:5, proteinHit:true, noAlcohol:true, exercise:true, score:99, notes:'live test' });
  };
  const call = function(w){
    return UrlFetchApp.fetch(url, { method:'post', contentType:'text/plain',
      payload: payload(w), muteHttpExceptions:true }).getContentText();
  };
  Logger.log('1st -> ' + call(2));
  Logger.log('2nd -> ' + call(3));

  // tidy up whatever it created
  const sheet = getSheet();
  const rows = sheet.getDataRange().getValues();
  let n = 0;
  for (let i = rows.length - 1; i >= 1; i--){
    if (String(rows[i][13]).toLowerCase() === 'zz-live@example.com'){ sheet.deleteRow(i+1); n++; }
  }
  Logger.log('Rows created by this test: ' + n + (n === 1 ? '  <- DEPLOYED CODE IS CURRENT'
                                                        : '  <- DEPLOYED CODE IS STALE, redeploy needed'));
}
/* Asks the live URL who it is. Old deployments don't know about the 'version'
   action and will answer "Unknown action" — that's the tell. */
function whichDeployment(){
  const url = 'https://script.google.com/macros/s/AKfycby0FsfiEBZcbaoLtNtfExIpHNaRkuylq-qjrLZITIQIJUn4JQKuvrlfmm4wiyWbQvmf/exec';
  Logger.log('URL in index.html answers: ' +
    UrlFetchApp.fetch(url + '?action=version', {muteHttpExceptions:true}).getContentText());
  try {
    Logger.log('This project\'s own service URL: ' + ScriptApp.getService().getUrl());
  } catch(e){ Logger.log('Could not read own service URL: ' + e.message); }
}