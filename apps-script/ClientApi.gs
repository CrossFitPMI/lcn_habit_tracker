/*
  Lean Comp Nutrition — scoped data endpoints
  ------------------------------------------------------------------
  Add as a NEW FILE in the `lean comp tracker` Apps Script project.
  Nothing existing is modified; these are additional routes.

  WHY THIS EXISTS
  The old `getLogs` returns every client's rows — names, emails, and the
  free-text notes — to anyone who calls it. The endpoint needs no
  authentication and its URL sits in the page source of a public website, so
  anyone who views source can retrieve the lot. The Coach View PIN doesn't
  help: it's checked in the browser, long after the data has been sent.

  These endpoints return only what the caller actually needs:
    getMyLogs      one client's own rows
    getLeaderboard names + streak numbers only — no emails, dates or notes
    getMyPrefs     one client's leaderboard preference
    coachLogs      everything, but only with the coach PIN, checked HERE

  ROLLOUT — in this order, so the app is never broken:
    1. Add this file. Run `setCoachPin` once. Deploy.
       Nothing changes yet; the old endpoints still work.
    2. Update index.html to use the new endpoints. Deploy. Test properly.
    3. Only then block the old routes — see the note at the bottom.

  WHAT THIS DOES NOT FIX
  There is still no real authentication: anyone can "log in" by typing
  someone else's name and email. This change stops bulk exposure — no single
  request hands over the whole client base — but someone who knows a
  client's email can still read that client's logs. Closing that needs
  proper login (an emailed magic link), which is a bigger piece of work.
*/

// ─────────────────── SETUP: run once by hand ───────────────────
/* Moves the coach PIN out of the page source into Script Properties. It is
   currently hardcoded in index.html as COACH_PIN = '<redacted>', so anyone who
   views source can open Coach View. Change it here, run this once, then
   delete that constant from index.html. */
function setCoachPin(){
  const NEW_PIN = 'CHANGE_ME';          // ← change this, then run this function once
  PropertiesService.getScriptProperties().setProperty('COACH_PIN', String(NEW_PIN));
  Logger.log('Coach PIN stored. Now remove COACH_PIN from index.html.');
}

function coachPinOk_(pin){
  const stored = PropertiesService.getScriptProperties().getProperty('COACH_PIN');
  if(!stored) return false;
  return String(pin||'') === String(stored);
}

// ─────────────────── helpers ───────────────────
function jsonOut_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function allRows_(){
  const sheet = getSheet();                                   // reuses your existing function
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  return rows.slice(1).map(function(row){
    const obj = {};
    headers.forEach(function(h,i){
      let v = row[i];
      if (h === 'Date' && v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      obj[h] = v;
    });
    return obj;
  }).reverse();
}

function sameClient_(row, email, name){
  const e = String(row['Client Email']||'').toLowerCase().trim();
  if (e) return e === String(email||'').toLowerCase().trim();
  // pre-email rows fall back to name, matching the front-end's own logic
  return String(row['Client Name']||'') === String(name||'');
}

// streak maths, mirroring calcStreakFromLogs() in index.html
function streakOf_(dates){
  const uniq = [...new Set(dates)].sort().reverse();
  let streak = 0;
  const now = new Date(); now.setHours(0,0,0,0);
  for (let i=0; i<uniq.length; i++){
    const d = new Date(uniq[i]); d.setHours(0,0,0,0);
    const diff = Math.round((now-d)/86400000);
    if (diff === i || diff === i+1) streak++; else break;
  }
  return streak;
}

// longest ever run, mirroring calcBestStreak()
function bestStreakOf_(dates){
  const uniq = [...new Set(dates)].filter(Boolean).sort();
  if (!uniq.length) return {len:0, ended:null};
  let best=1, run=1, bestEnd=uniq[0];
  for (let i=1; i<uniq.length; i++){
    const prev = new Date(uniq[i-1]), cur = new Date(uniq[i]);
    const gap = Math.round((cur-prev)/86400000);
    if (gap === 1){ run++; if (run > best){ best = run; bestEnd = uniq[i]; } }
    else { run = 1; }
  }
  return {len:best, ended:bestEnd};
}

function hiddenSet_(){
  const sheet = getPrefsSheet();                              // reuses your existing function
  const rows = sheet.getDataRange().getValues();
  const out = {};
  for (let i=1; i<rows.length; i++){
    if (String(rows[i][1]) === 'Yes') out[String(rows[i][0]).toLowerCase().trim()] = true;
  }
  return out;
}

// ─────────────────── endpoints ───────────────────

/* One client's own logs, in exactly the shape the front-end already expects
   so nothing downstream needs rewriting. */
function getMyLogs(e){
  const email = String(e.parameter.email||'').toLowerCase().trim();
  const name  = String(e.parameter.name||'');
  if (!email && !name) return jsonOut_([]);
  return jsonOut_(allRows_().filter(function(r){ return sameClient_(r, email, name); }));
}

/* Names and streak numbers only. No emails, dates, notes or scores.
   Hidden clients are dropped server-side rather than filtered in the
   browser — previously "hidden" only meant "not drawn", while the data was
   still delivered to every other client's device. */
function getLeaderboard(e){
  const me = String(e.parameter.me||'').toLowerCase().trim();
  const meName = String(e.parameter.meName||'');
  const hidden = hiddenSet_();
  const rows = allRows_();

  const groups = {};
  rows.forEach(function(r){
    const email = String(r['Client Email']||'').toLowerCase().trim();
    const key = email || ('name:' + (r['Client Name']||''));
    if (!groups[key]) groups[key] = {email:email, name:r['Client Name']||'—', dates:[]};
    if (r['Client Name']) groups[key].name = r['Client Name'];
    groups[key].dates.push(String(r['Date']).slice(0,10));
  });

  const out = [];
  Object.keys(groups).forEach(function(k){
    const g = groups[k];
    const isMe = g.email ? (g.email === me) : (g.name === meName);
    if (hidden[g.email] && !isMe) return;                     // hidden never leaves the server
    out.push({
      name:   g.name,
      streak: streakOf_(g.dates),
      best:   bestStreakOf_(g.dates),
      isMe:   isMe,
      hidden: !!hidden[g.email],                              // only ever true for yourself
    });
  });
  return jsonOut_(out);
}

/* Just this client's own preference. The old getPrefs returned every
   client's email address alongside their setting. */
function getMyPrefs(e){
  const email = String(e.parameter.email||'').toLowerCase().trim();
  if (!email) return jsonOut_({hidden:false});
  return jsonOut_({hidden: !!hiddenSet_()[email]});
}

/* Everything — but only for the coach, and the PIN is checked here rather
   than in the browser. */
function coachLogs(e){
  if (!coachPinOk_(e.parameter.pin)) return jsonOut_({error:'unauthorised'});
  return jsonOut_(allRows_());
}

/* Lets the front-end verify the PIN before unlocking the tab. */
function checkCoachPin(e){
  return jsonOut_({ok: coachPinOk_(e.parameter.pin)});
}

/*
  ─────────────────── STEP 3: block the old routes ───────────────────
  Once index.html is updated and verified, stop the legacy bulk routes from
  serving. In your `doGet`, replace:

      if (action === 'getLogs') return getLogs(e);
      if (action === 'getPrefs') return getPrefs();

  with:

      if (action === 'getLogs')  return jsonOut_({error:'gone'});
      if (action === 'getPrefs') return jsonOut_({error:'gone'});

  Keep the functions themselves. WeeklyEmail.gs doesn't call them (it reads
  the sheet directly), but deleting things you don't have to is how outages
  happen — blocking the route is enough.

  Do NOT do this until step 2 is deployed and tested, or every client's app
  goes blank.
*/
/* Rewrites an existing row in place, matched by ID.

   Ownership is checked HERE, server-side. Without that check anyone could
   edit anyone else's log by guessing an ID — and IDs are just Date.now(),
   so they're guessable. The client's own browser saying "this is mine" is
   not evidence of anything.

   Client Name and Client Email are deliberately never overwritten: the row
   keeps whoever originally owned it, so an edit can't reassign a log to
   somebody else. */
function updateLog(data){
  const id    = String(data.id || '').trim();
  const email = String(data.clientEmail || '').toLowerCase().trim();
  const name  = String(data.clientName || '');
  if (!id) return jsonOut_({error:'missing_id'});

  const sheet   = getSheet();
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0];
  const col = function(h){ return headers.indexOf(h); };

  const cID = col('ID'), cEmail = col('Client Email'), cName = col('Client Name');
  if (cID < 0) return jsonOut_({error:'no_id_column'});

  for (let r = 1; r < rows.length; r++){
    if (String(rows[r][cID]) !== id) continue;

    const rowEmail = String(rows[r][cEmail] || '').toLowerCase().trim();
    // pre-email rows fall back to name, matching how the rest of the app matches
    const owns = rowEmail ? (rowEmail === email)
                          : (String(rows[r][cName] || '') === name);
    if (!owns) return jsonOut_({error:'not_yours'});

    const set = function(h, v){
      const i = col(h);
      if (i >= 0) sheet.getRange(r + 1, i + 1).setValue(v);
    };

    set('Date',                  data.date);
    set('Water (L)',             data.water);
    set('Protein Target Hit',    data.proteinHit ? 'Yes' : 'No');
    set('No Alcohol',            data.noAlcohol  ? 'Yes' : 'No');
    set('Exercise Completed',    data.exercise   ? 'Yes' : 'No');
    set('Sleep (hrs)',           data.sleep);
    set('Steps',                 data.steps);
    set('Fruit & Veg Portions',  data.fruitsVeg);
    set('Score',                 data.score || 0);
    set('Notes',                 data.notes || '');
    set('Timestamp',             new Date().toISOString());

    return jsonOut_({success:true, id:id});
  }
  return jsonOut_({error:'not_found'});
}

/* Run by hand to check the route works without going near the app.
   Reads the most recent log, rewrites it with its own current values (so
   nothing actually changes), and reports the result. */
function testUpdateLog(){
  const rows = allRows_();
  if (!rows.length){ Logger.log('No logs to test with.'); return; }
  const l = rows[0];
  Logger.log('Testing against ID ' + l['ID'] + ' (' + l['Client Name'] + ', ' + l['Date'] + ')');

  const same = updateLog({
    id: l['ID'], clientEmail: l['Client Email'], clientName: l['Client Name'],
    date: l['Date'], water: l['Water (L)'],
    proteinHit: l['Protein Target Hit'] === 'Yes',
    noAlcohol:  l['No Alcohol'] === 'Yes',
    exercise:   l['Exercise Completed'] === 'Yes',
    sleep: l['Sleep (hrs)'], steps: l['Steps'], fruitsVeg: l['Fruit & Veg Portions'],
    score: l['Score'], notes: l['Notes'] || ''
  });
  Logger.log('same-owner  -> ' + same.getContent());

  const other = updateLog({
    id: l['ID'], clientEmail: 'somebody.else@example.com', clientName: 'Somebody Else',
    date: l['Date'], notes: 'THIS SHOULD NOT BE WRITTEN'
  });
  Logger.log('wrong-owner -> ' + other.getContent() + '   (must say not_yours)');
}
function auditScores(){
  const rows = allRows_();
  let ok=0, missing=0, mismatch=0;
  const bad=[];
  rows.forEach(function(l){
    const stored = parseFloat(l['Score']);
    if (!stored || isNaN(stored)) { missing++; bad.push(l['Date']+' '+l['Client Name']+' (blank)'); return; }
    // recompute with today's default scoring and compare
    let s=0;
    const w=+l['Water (L)']||0;      s += w<=0?0 : w<1.5?4 : w<2?8 : w<2.5?12 : 15;
    const h=+l['Sleep (hrs)']||0;    s += h<=0?0 : h<5?0 : h<6?4 : h<7?7 : h<8?11 : h<9?14 : 15;
    const st=+l['Steps']||0;         s += st<=0?0 : st<2000?0 : st<4000?4 : st<6000?8 : st<8000?12 : 15;
    const f=+l['Fruit & Veg Portions']||0; s += f<=0?0 : f<2?4 : f<3?7 : f<4?10 : f<5?13 : 15;
    if (l['Protein Target Hit']==='Yes') s+=15;
    if (l['No Alcohol']==='Yes') s+=15;
    if (l['Exercise Completed']==='Yes') s+=10;
    s = Math.min(s,100);
    if (s === stored) ok++;
    else { mismatch++; bad.push(l['Date']+' '+l['Client Name']+': stored '+stored+' vs computed '+s); }
  });
  Logger.log('Total logs: '+rows.length);
  Logger.log('Stored score matches computed: '+ok);
  Logger.log('Stored score BLANK: '+missing);
  Logger.log('Stored score DIFFERS: '+mismatch);
  bad.slice(0,15).forEach(function(b){ Logger.log('   '+b); });
}
/*
  Per-client habit targets
  ------------------------------------------------------------------
  Add to the BOTTOM of ClientApi.gs, then add ONE line to doGet:

      if (action === 'getMyTargets') return getMyTargets(e);

  Deploy a new version.

  HOW TARGETS WORK
  A `Client Targets` tab, one row per client. Blank cell or missing row =
  the default, so a new client works without you touching anything.

  Scoring keeps each habit's existing band SHAPE and scales the thresholds
  by target ÷ default. At the default target the numbers are identical to
  today's — backward compatible by construction, not by luck. Raise
  someone's step target to 12,000 and the bands stretch to
  3,000/6,000/9,000/12,000.

  HISTORY IS FROZEN
  Scores are recomputed from raw values at render time, so changing a target
  would otherwise rescore every log that client has ever written — their 94s
  quietly becoming 81s, with no explanation. Instead the stored Score column
  is treated as the record for past logs, and targets only affect scoring
  from the moment they change. Audited before building this: 37 of 39 logs
  had a stored score matching the computed one, 0 mismatches, 2 blanks.
*/

const TARGETS_SHEET = 'Client Targets';

/* The defaults every client starts on — the values the app has always used. */
const DEFAULT_TARGETS = {
  water: 2.5,     // litres
  sleep: 8,       // hours
  steps: 8000,    // steps
  fv:    5        // portions
};

function getTargetsSheet(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TARGETS_SHEET);
  if (!sheet){
    sheet = ss.insertSheet(TARGETS_SHEET);
    sheet.appendRow(['Email','Water (L)','Sleep (hrs)','Steps','Fruit & Veg Portions','Updated','Notes']);
    sheet.setFrozenRows(1);
    sheet.getRange(2,1).setValue('— leave a cell blank to use the default —');
  }
  return sheet;
}

/* One client's targets, with defaults filled in for anything blank.
   Never returns a partial object: callers can rely on all four being present. */
function targetsFor_(email){
  const t = {
    water: DEFAULT_TARGETS.water,
    sleep: DEFAULT_TARGETS.sleep,
    steps: DEFAULT_TARGETS.steps,
    fv:    DEFAULT_TARGETS.fv,
    custom: false
  };
  email = String(email||'').toLowerCase().trim();
  if (!email) return t;

  const rows = getTargetsSheet().getDataRange().getValues();
  if (rows.length < 2) return t;
  const idx = headerIndex_(rows[0]);
  const eI = idx('Email');
  if (eI < 0) return t;

  for (let r = 1; r < rows.length; r++){
    if (String(rows[r][eI]||'').toLowerCase().trim() !== email) continue;
    const pick = function(header, fallback){
      const i = idx(header);
      if (i < 0) return fallback;
      const v = parseFloat(rows[r][i]);
      // 0 is not a valid target — treat it as "unset" rather than "impossible"
      return (isNaN(v) || v <= 0) ? fallback : v;
    };
    t.water = pick('Water (L)',              DEFAULT_TARGETS.water);
    t.sleep = pick('Sleep (hrs)',            DEFAULT_TARGETS.sleep);
    t.steps = pick('Steps',                  DEFAULT_TARGETS.steps);
    t.fv    = pick('Fruit & Veg Portions',   DEFAULT_TARGETS.fv);
    t.custom = (t.water !== DEFAULT_TARGETS.water) || (t.sleep !== DEFAULT_TARGETS.sleep) ||
               (t.steps !== DEFAULT_TARGETS.steps) || (t.fv !== DEFAULT_TARGETS.fv);
    break;
  }
  return t;
}

/* Endpoint: the app fetches this on load so the form can show the right
   targets and score today's entry against them. */
function getMyTargets(e){
  return jsonOut_(targetsFor_(String(e.parameter.email||'')));
}

/* Adds a row for every client who has logged but has no targets row yet,
   pre-filled with the defaults. Gives you something to edit rather than a
   blank sheet. Safe to re-run — it never overwrites an existing row. */
function seedTargetsSheet(){
  const sheet = getTargetsSheet();
  const existing = {};
  const rows = sheet.getDataRange().getValues();
  const idx = headerIndex_(rows[0]);
  const eI = idx('Email');
  for (let r = 1; r < rows.length; r++){
    const em = String(rows[r][eI]||'').toLowerCase().trim();
    if (em) existing[em] = true;
  }

  const seen = {};
  allRows_().forEach(function(l){
    const em = String(l['Client Email']||'').toLowerCase().trim();
    if (em && !existing[em] && !seen[em]){
      seen[em] = true;
      sheet.appendRow([em, DEFAULT_TARGETS.water, DEFAULT_TARGETS.sleep,
                       DEFAULT_TARGETS.steps, DEFAULT_TARGETS.fv,
                       new Date().toISOString(), '']);
    }
  });
  const added = Object.keys(seen).length;
  Logger.log(added ? ('Added '+added+' client(s) at default targets. Edit the sheet to change them.')
                   : 'Every client already has a targets row — nothing added.');
}

/* Backfills the two logs with no stored Score, using today's default
   scoring. Once history is frozen those rows would otherwise read as 0.
   Run once. Reports first, changes nothing unless you pass false. */
function backfillMissingScores(dryRun){
  if (dryRun === undefined) dryRun = true;
  const sheet = getSheet();
  const rows = sheet.getDataRange().getValues();
  const idx = headerIndex_(rows[0]);
  const cScore = idx('Score');
  if (cScore < 0){ Logger.log('No Score column.'); return; }

  const g = function(r,h){ const i = idx(h); return i<0 ? '' : rows[r][i]; };
  let fixed = 0;
  for (let r = 1; r < rows.length; r++){
    const stored = parseFloat(rows[r][cScore]);
    if (stored && !isNaN(stored)) continue;

    let s = 0;
    const w  = parseFloat(g(r,'Water (L)'))||0;
    const h  = parseFloat(g(r,'Sleep (hrs)'))||0;
    const st = parseFloat(g(r,'Steps'))||0;
    const f  = parseFloat(g(r,'Fruit & Veg Portions'))||0;
    s += w<=0?0 : w<1.5?4 : w<2?8 : w<2.5?12 : 15;
    s += h<=0?0 : h<5?0 : h<6?4 : h<7?7 : h<8?11 : h<9?14 : 15;
    s += st<=0?0 : st<2000?0 : st<4000?4 : st<6000?8 : st<8000?12 : 15;
    s += f<=0?0 : f<2?4 : f<3?7 : f<4?10 : f<5?13 : 15;
    if (String(g(r,'Protein Target Hit'))==='Yes') s += 15;
    if (String(g(r,'No Alcohol'))==='Yes')         s += 15;
    if (String(g(r,'Exercise Completed'))==='Yes') s += 10;
    s = Math.min(s,100);

    Logger.log((dryRun?'[dry run] ':'')+'Row '+(r+1)+'  '+g(r,'Date')+'  '+g(r,'Client Name')+'  -> score '+s);
    if (!dryRun) sheet.getRange(r+1, cScore+1).setValue(s);
    fixed++;
  }
  Logger.log(dryRun ? (fixed+' row(s) would be backfilled. Run backfillMissingScoresApply() to do it.')
                    : (fixed+' row(s) backfilled.'));
}
function backfillMissingScoresApply(){ backfillMissingScores(false); }

/* Prints each client's effective targets — the quick way to confirm the
   sheet is being read the way you think it is. */
function testTargets(){
  const seen = {};
  allRows_().forEach(function(l){
    const em = String(l['Client Email']||'').toLowerCase().trim();
    if (em && !seen[em]){
      seen[em] = true;
      const t = targetsFor_(em);
      Logger.log(em.padEnd(32) + ' water ' + t.water + 'L, sleep ' + t.sleep + 'h, steps ' +
                 t.steps + ', f&v ' + t.fv + (t.custom ? '   (custom)' : '   (defaults)'));
    }
  });
}