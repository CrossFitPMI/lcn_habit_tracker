/*
  Lean Comp Nutrition — weekly summary email
  ------------------------------------------------------------------
  Add this as a NEW FILE in your existing Apps Script project
  (the one behind SCRIPT_URL). It doesn't modify anything you already
  have — it only reads the logs sheet and sends mail.

  Deliberately NOT a "you haven't logged" nag. It's a weekly summary
  worth opening; re-engagement is a side effect. Someone who drifted
  sees 3 logs instead of 6 and comes back on their own, without being
  told off.

  SETUP — in order:
    1. Paste this file in, and set CONFIG below (sheet names, your
       reply-to address).
    2. Run  setupWeeklyEmailTrigger  once. Approve the permissions
       prompt (it needs to read the sheet and send mail as you).
    3. Leave TEST_MODE = true and run  sendWeeklySummaries  — it emails
       ONLY you, once per client, so you can see exactly what everyone
       would receive.
    4. When you're happy, set TEST_MODE = false.

  Nothing sends automatically until step 2 is done AND TEST_MODE is false.
*/

// ───────────────────────── CONFIG ─────────────────────────
const CONFIG = {
  // These match the constants already in your project — SHEET_NAME and
  // PREFS_SHEET. Kept as their own copies so this file never fights with
  // the originals if you rename one.
  LOG_SHEET:      'Habit Log',

  APP_URL:        'https://app.leancompnutrition.com/',

  /* The deployed web app URL — the SAME one index.html uses as SCRIPT_URL.
     Must end in /exec. Don't rely on ScriptApp.getService().getUrl(): called
     from the editor it can hand back the /dev URL, which only the owner can
     open and which shows a Google Drive "unable to open the file" error. */
  SCRIPT_URL:     'https://script.google.com/macros/s/AKfycbyyNOABBFi7Q3IzqUYQ_OkYimfKWOOnjqo5FQp_nLobGbn48p0sdw3kziuuoZsbh-ux/exec',
  LOGO_URL:       'https://app.leancompnutrition.com/icons/icon-192.png',

  FROM_NAME:      'Lean Comp Nutrition',

  /* Apps Script sends as whichever Google account owns this project
     (crossfitpmi@gmail.com). To send as a different address it must first be
     added there as a verified alias:
       Gmail (as crossfitpmi) -> Settings -> Accounts and Import
       -> "Send mail as" -> Add another email address
       -> enter leancompnutrition@gmail.com -> confirm the verification email.
     Run  checkFromAddress  below to see which aliases are actually available.
     Leave FROM_EMAIL blank to just send as the owning account. */
  FROM_EMAIL:     'leancompnutrition@gmail.com',
  REPLY_TO:       'leancompnutrition@gmail.com',

  // Safety switch. true = every email goes to TEST_EMAIL instead of the client.
  TEST_MODE:      false,
  TEST_EMAIL:     'michealfitzpatrick@gmail.com',

  // Don't email someone who has never logged anything — they're not a
  // lapsed client, they just never started.
  MIN_LIFETIME_LOGS: 1,

  // Stop emailing people who have been gone for months. At that point it's
  // no longer a summary, it's junk mail.
  MAX_QUIET_DAYS: 60,
};

// Column headers as they appear in the sheet. Matching is trimmed and
// case-insensitive, so minor differences are fine.
// Header added to 'Leaderboard Prefs' for unsubscribes.
const OPTOUT_HEADER = 'Email Opt-Out';

// Matches the header row written by getSheet() in your existing script.
const COL = {
  name:    'Client Name',
  email:   'Client Email',
  date:    'Date',
  water:   'Water (L)',
  sleep:   'Sleep (hrs)',
  steps:   'Steps',
  fv:      'Fruit & Veg Portions',
  protein: 'Protein Target Hit',
  alcohol: 'No Alcohol',
  exercise:'Exercise Completed',
};

// ─────────────────── SCORING (mirrors the app) ───────────────────
// Must stay identical to calcLogScore() in index.html, or the email will
// quote a different number than the app shows. If you change the scoring
// there, change it here too.
function scoreWater_(v){ const l=parseFloat(v||0); if(l<=0)return 0; if(l<1.5)return 4; if(l<2)return 8; if(l<2.5)return 12; return 15; }
function scoreSleep_(v){ const h=parseFloat(v||0); if(h<=0)return 0; if(h<5)return 0; if(h<6)return 4; if(h<7)return 7; if(h<8)return 11; if(h<9)return 14; return 15; }
function scoreSteps_(v){ const s=parseFloat(v||0); if(s<=0)return 0; if(s<2000)return 0; if(s<4000)return 4; if(s<6000)return 8; if(s<8000)return 12; return 15; }
function scoreFV_(v){ const p=parseFloat(v||0); if(p<=0)return 0; if(p<2)return 4; if(p<3)return 7; if(p<4)return 10; if(p<5)return 13; return 15; }
function isYes_(v){ const s=String(v||'').trim().toLowerCase(); return s==='yes'||s==='true'||s==='y'||s==='1'; }

function scoreLog_(l){
  let s=0;
  s+=scoreWater_(l.water); s+=scoreSleep_(l.sleep); s+=scoreSteps_(l.steps); s+=scoreFV_(l.fv);
  if(isYes_(l.protein))  s+=15;
  if(isYes_(l.alcohol))  s+=15;
  if(isYes_(l.exercise)) s+=10;
  return Math.min(s,100);
}

// ───────────────────────── HELPERS ─────────────────────────
/* Uses the SPREADSHEET timezone, matching what getLogs() already does — a
   picked date is stored at local midnight and shifts to the previous day if
   read as UTC during Irish summer time. */
function tz_(){ return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(); }
function ymd_(d){ return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'); }

/* Sheet cells come back as Date objects or as strings depending on how the
   column is formatted. Normalise both to yyyy-MM-dd in the script's timezone —
   the same trap normalizeDateStr() handles in the front-end. */
function toYmd_(v){
  if(v instanceof Date) return ymd_(v);
  const s=String(v||'').trim();
  if(!s) return '';
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d=new Date(s);
  return isNaN(d) ? s : ymd_(d);
}

/* The Sunday that just ended — today if today IS Sunday, otherwise the
   previous Sunday. Getting this wrong is easy: an earlier version anchored
   off "the Monday of the current week", which on a Sunday-evening run
   reported the week BEFORE the one that had just finished. */
function sundayOnOrBefore_(d){
  const x=new Date(d); x.setHours(0,0,0,0);
  const dow=x.getDay();                 // 0 = Sunday
  if(dow!==0) x.setDate(x.getDate()-dow);
  return x;
}

function headerIndex_(headers){
  const map={};
  headers.forEach((h,i)=>{ map[String(h||'').trim().toLowerCase()]=i; });
  return function(name){
    const i=map[String(name).trim().toLowerCase()];
    return (i===undefined) ? -1 : i;
  };
}

function readLogs_(){
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.LOG_SHEET);
  if(!sh) throw new Error('Sheet "'+CONFIG.LOG_SHEET+'" not found — check CONFIG.LOG_SHEET.');
  const values=sh.getDataRange().getValues();
  if(values.length<2) return [];
  const idx=headerIndex_(values.shift());
  const need=idx(COL.date);
  if(need<0) throw new Error('Column "'+COL.date+'" not found — check the COL block against your sheet headers.');
  const get=(row,key)=>{ const i=idx(COL[key]); return i<0 ? '' : row[i]; };

  return values.map(function(row){
    return {
      name:    String(get(row,'name')||'').trim(),
      email:   String(get(row,'email')||'').trim().toLowerCase(),
      date:    toYmd_(get(row,'date')),
      water:   get(row,'water'),
      sleep:   get(row,'sleep'),
      steps:   get(row,'steps'),
      fv:      get(row,'fv'),
      protein: get(row,'protein'),
      alcohol: get(row,'alcohol'),
      exercise:get(row,'exercise'),
    };
  }).filter(function(l){ return l.date && (l.email || l.name); });
}

// ─────────────────── EMAIL OPT-OUT ───────────────────
/* Reuses getPrefsSheet() from your existing script rather than creating a
   second function that manages the same 'Leaderboard Prefs' tab. Only adds
   one column — your Email/Hidden/Updated columns are never touched, so
   getPrefs() and setPref() keep working exactly as before. */
function prefsSheet_(){
  const sh=getPrefsSheet();
  const lastCol=Math.max(1, sh.getLastColumn());
  const headers=sh.getRange(1,1,1,lastCol).getValues()[0]||[];
  if(headers.map(String).indexOf(OPTOUT_HEADER)===-1){
    sh.getRange(1, lastCol+1).setValue(OPTOUT_HEADER);
  }
  return sh;
}

function optedOutEmails_(){
  const sh=prefsSheet_();
  const values=sh.getDataRange().getValues();
  if(values.length<2) return {};
  const idx=headerIndex_(values.shift());
  const eI=idx('Email'), oI=idx(OPTOUT_HEADER);
  const out={};
  if(eI<0||oI<0) return out;
  values.forEach(function(r){
    if(isYes_(r[oI])) out[String(r[eI]||'').trim().toLowerCase()]=true;
  });
  return out;
}

/* Signed so one client can't unsubscribe another by editing the URL. */
function unsubToken_(email){
  const props=PropertiesService.getScriptProperties();
  let secret=props.getProperty('UNSUB_SECRET');
  if(!secret){
    secret=Utilities.getUuid();
    props.setProperty('UNSUB_SECRET', secret);
  }
  const sig=Utilities.computeHmacSha256Signature(String(email).toLowerCase(), secret);
  return sig.map(function(b){ return ('0'+(b&0xFF).toString(16)).slice(-2); }).join('').slice(0,24);
}

function setEmailOptOut_(email, optedOut){
  email=String(email||'').trim().toLowerCase();
  if(!email) return false;
  const sh=prefsSheet_();
  const values=sh.getDataRange().getValues();
  const idx=headerIndex_(values[0]);
  const eI=idx('Email'), oI=idx(OPTOUT_HEADER);
  for(let r=1;r<values.length;r++){
    if(String(values[r][eI]||'').trim().toLowerCase()===email){
      sh.getRange(r+1, oI+1).setValue(optedOut ? 'Yes' : '');
      return true;
    }
  }
  const row=new Array(values[0].length).fill('');
  row[eI]=email;
  const hI=idx('Hidden'), uI=idx('Updated');
  if(hI>=0) row[hI]='No';                       // keep getPrefs()'s shape intact
  if(uI>=0) row[uI]=new Date().toISOString();
  row[oI]=optedOut ? 'Yes' : '';
  sh.appendRow(row);
  return true;
}

/* ── ADD THIS TO YOUR EXISTING doGet ──────────────────────────────
   Paste these 3 lines at the TOP of your current doGet(e) function.
   Don't create a second doGet — Apps Script only allows one.

     if (e && e.parameter && e.parameter.action === 'unsubscribe') {
       return handleUnsubscribe(e);
     }
─────────────────────────────────────────────────────────────────── */
function handleUnsubscribe(e){
  /* Only ever called by doGet with a real request. Run by hand from the editor
     there is no event object, so say so plainly instead of throwing
     "Cannot read properties of undefined". */
  if(!e || !e.parameter){
    Logger.log('handleUnsubscribe is not meant to be run from the editor — it needs a real web request.');
    Logger.log('Run  checkUnsubscribeUrl  instead, then open the URL it prints.');
    return HtmlService.createHtmlOutput('Run checkUnsubscribeUrl instead.');
  }
  const email=String((e.parameter.email||'')).trim().toLowerCase();
  const token=String((e.parameter.token||'')).trim();
  const ok = email && token && token===unsubToken_(email);
  if(ok) setEmailOptOut_(email, true);
  const msg = ok
    ? '<h2 style="color:#3d7a1a">You\'re unsubscribed</h2><p>You won\'t get the weekly summary any more. Your habit logs and coaching are unaffected — nothing else changes.</p><p>Changed your mind? Just tell your coach.</p>'
    : '<h2 style="color:#cc2200">That link didn\'t work</h2><p>Ask your coach to take you off the list and it\'ll be sorted.</p>';
  return HtmlService.createHtmlOutput(
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;line-height:1.6">'+msg+'</div>'
  );
}

// ─────────────────── WEEKLY AGGREGATION ───────────────────
function summarise_(logs, startYmd, endYmd){
  const inRange=logs.filter(function(l){ return l.date>=startYmd && l.date<=endYmd; });
  // one log per day — last row wins, matching the app
  const byDay={};
  inRange.forEach(function(l){ byDay[l.date]=l; });
  const days=Object.keys(byDay).map(function(k){ return byDay[k]; });

  const n=days.length;
  const sum=function(f){ return days.reduce(function(a,l){ return a+f(l); },0); };
  return {
    days: n,
    avgScore: n ? Math.round(sum(scoreLog_)/n) : 0,
    water:    n ? sum(function(l){ return parseFloat(l.water)||0; })/n : 0,
    sleep:    n ? sum(function(l){ return parseFloat(l.sleep)||0; })/n : 0,
    steps:    n ? sum(function(l){ return parseFloat(l.steps)||0; })/n : 0,
    protein:  n ? Math.round(100*sum(function(l){ return isYes_(l.protein)?1:0; })/n) : 0,
    alcohol:  n ? Math.round(100*sum(function(l){ return isYes_(l.alcohol)?1:0; })/n) : 0,
    exercise: n ? Math.round(100*sum(function(l){ return isYes_(l.exercise)?1:0; })/n) : 0,
  };
}

/* One specific thing to try, picked from the weakest habit. Rule-based on
   purpose: it costs nothing, never invents a number, and can't produce an
   off-tone message on a bad week. */
function buildInsight_(cur){
  if(cur.days===0) return null;
  const candidates=[
    { key:'water',    gap: Math.max(0, 2.5-cur.water)/2.5,
      line:'Water was the softest one — averaging '+cur.water.toFixed(1)+'L against a 2.5L target. Filling a bottle at the start of the day is usually the whole fix.' },
    { key:'sleep',    gap: Math.max(0, 8-cur.sleep)/8,
      line:'Sleep averaged '+cur.sleep.toFixed(1)+' hours. Pulling bedtime back 20 minutes tends to be more sustainable than trying to find a full hour.' },
    { key:'steps',    gap: Math.max(0, 8000-cur.steps)/8000,
      line:'Steps came in around '+Math.round(cur.steps).toLocaleString()+' a day. One deliberate 15-minute walk usually covers the gap.' },
    { key:'protein',  gap: (100-cur.protein)/100,
      line:'Protein target was hit on '+cur.protein+'% of logged days. Protein at breakfast is normally the one that moves this.' },
    { key:'exercise', gap: (100-cur.exercise)/100,
      line:'Training happened on '+cur.exercise+'% of logged days. Booking the class in advance beats deciding on the day.' },
  ];
  candidates.sort(function(a,b){ return b.gap-a.gap; });
  return candidates[0].gap>0.08 ? candidates[0].line : "Nothing obvious to fix this week — everything's landing near target. Keep it boring.";
}

// ─────────────────── EMAIL TEMPLATE ───────────────────
function bar_(label, now, prev, suffix, dp){
  const fmt=function(v){ return dp ? v.toFixed(dp) : Math.round(v); };
  const delta=now-prev;
  const arrow = delta>0.05 ? '&#9650;' : (delta<-0.05 ? '&#9660;' : '&rarr;');
  const colour= delta>0.05 ? '#3d7a1a' : (delta<-0.05 ? '#a07800' : '#7a9060');
  const pct=Math.max(3, Math.min(100, prev>0 ? (now/Math.max(now,prev))*100 : (now>0?100:3)));
  return ''+
  '<tr><td style="padding:9px 0 2px;font-size:13px;color:#1a2e0a;font-weight:600">'+label+
    '<span style="float:right;color:'+colour+';font-weight:700">'+arrow+' '+fmt(now)+suffix+'</span></td></tr>'+
  '<tr><td style="padding-bottom:6px"><div style="background:#e8f0e0;border-radius:6px;height:8px;width:100%">'+
    '<div style="background:#5a9e2f;border-radius:6px;height:8px;width:'+pct.toFixed(0)+'%"></div></div>'+
    '<div style="font-size:11px;color:#7a9060;padding-top:3px">last week '+fmt(prev)+suffix+'</div></td></tr>';
}

function buildEmail_(client, cur, prev, weekLabel, unsubUrl){
  const returning = cur.days===0;
  const insight = buildInsight_(cur);

  const headline = returning
    ? 'Nothing logged this week'
    : cur.days+' day'+(cur.days===1?'':'s')+' logged &middot; '+cur.avgScore+'/100 average';

  const opening = returning
    ? "No logs from you this week. No drama — weeks go like that. Everything's still here, and one log today puts you straight back in it."
    : (cur.avgScore>=prev.avgScore && prev.days>0
        ? "Solid week. Here's how it landed."
        : "Here's how the week landed.");

  const body = returning ? '' : ''+
    '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">'+
      bar_('Average daily score', cur.avgScore, prev.avgScore, '', 0)+
      bar_('Water', cur.water, prev.water, 'L', 1)+
      bar_('Sleep', cur.sleep, prev.sleep, 'h', 1)+
      bar_('Steps', cur.steps/1000, prev.steps/1000, 'k', 1)+
      bar_('Protein target', cur.protein, prev.protein, '%', 0)+
      bar_('Alcohol-free days', cur.alcohol, prev.alcohol, '%', 0)+
    '</table>';

  const insightBlock = insight ? ''+
    '<div style="background:#f4f9f0;border-left:3px solid #5a9e2f;border-radius:6px;padding:12px 14px;margin-top:18px">'+
      '<div style="font-size:11px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:#3d7a1a;margin-bottom:5px">One thing for next week</div>'+
      '<div style="font-size:13.5px;color:#1a2e0a;line-height:1.55">'+insight+'</div>'+
    '</div>' : '';

  return ''+
  '<div style="background:#f4f9f0;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">'+
  '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #ddeece">'+
    '<tr><td style="background:linear-gradient(135deg,#3d7a1a 0%,#5a9e2f 100%);padding:20px 22px">'+
      '<img src="'+CONFIG.LOGO_URL+'" width="42" height="42" alt="" style="vertical-align:middle;border-radius:9px;background:#fff">'+
      '<span style="color:#fff;font-size:17px;font-weight:800;margin-left:10px;vertical-align:middle">Your week</span>'+
      '<div style="color:rgba(255,255,255,.85);font-size:12px;margin-top:6px">'+weekLabel+'</div>'+
    '</td></tr>'+
    '<tr><td style="padding:20px 22px">'+
      '<div style="font-size:19px;font-weight:800;color:#1a2e0a;letter-spacing:-.02em">'+headline+'</div>'+
      '<div style="font-size:13.5px;color:#5c6b52;line-height:1.6;margin-top:6px">Hi '+(client.name||'there')+' — '+opening+'</div>'+
      body+
      insightBlock+
      '<div style="text-align:center;margin-top:22px">'+
        '<a href="'+CONFIG.APP_URL+'" style="display:inline-block;background:#5a9e2f;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 26px;border-radius:10px">'+
        (returning ? 'Log today &rarr;' : 'Open the tracker &rarr;')+'</a>'+
      '</div>'+
    '</td></tr>'+
    '<tr><td style="padding:14px 22px 18px;border-top:1px solid #eef4e8;font-size:11px;color:#9aab8c;line-height:1.6;text-align:center">'+
      'You get this because you track your habits with Lean Comp Nutrition.<br>'+
      '<a href="'+unsubUrl+'" style="color:#9aab8c">Unsubscribe from the weekly summary</a>'+
    '</td></tr>'+
  '</table></div>';
}

// ─────────────────── SENDING ───────────────────
/* MailApp can't set a From address at all; GmailApp can, but only to an alias
   the owning account has verified. Falls back to MailApp when FROM_EMAIL is
   blank so this keeps working either way. */
function sendMail_(to, subject, html){
  if(CONFIG.FROM_EMAIL){
    GmailApp.sendEmail(to, subject, '', {
      htmlBody: html,
      from:     CONFIG.FROM_EMAIL,
      name:     CONFIG.FROM_NAME,
      replyTo:  CONFIG.REPLY_TO,
    });
  } else {
    MailApp.sendEmail({
      to: to, subject: subject, htmlBody: html,
      name: CONFIG.FROM_NAME, replyTo: CONFIG.REPLY_TO,
    });
  }
}

/* Checked BEFORE the send loop starts. Without this, an unverified alias
   throws partway through and some clients get an email while others don't —
   then re-running double-sends to the first group. */
function assertFromAddressUsable_(){
  if(!CONFIG.FROM_EMAIL) return;
  const owner=Session.getEffectiveUser().getEmail();
  if(CONFIG.FROM_EMAIL.toLowerCase()===String(owner).toLowerCase()) return;
  const aliases=GmailApp.getAliases().map(function(a){ return a.toLowerCase(); });
  if(aliases.indexOf(CONFIG.FROM_EMAIL.toLowerCase())===-1){
    throw new Error(
      'Cannot send as "'+CONFIG.FROM_EMAIL+'" — it is not a verified alias on '+owner+'.\n'+
      'Available aliases: '+(aliases.length?aliases.join(', '):'(none)')+'\n'+
      'Add it in Gmail -> Settings -> Accounts and Import -> "Send mail as", '+
      'or clear CONFIG.FROM_EMAIL to send as '+owner+'. Nothing was sent.'
    );
  }
}

/* Prints the unsubscribe URL for your own address so you can test the route
   without sending anything, and without unsubscribing a real client. */
function checkUnsubscribeUrl(){
  const email=CONFIG.TEST_EMAIL;
  const url=(CONFIG.SCRIPT_URL||ScriptApp.getService().getUrl())+
            '?action=unsubscribe&email='+encodeURIComponent(email)+'&token='+unsubToken_(email);
  Logger.log('Open this in a browser to test the unsubscribe route:');
  Logger.log(url);
  Logger.log('');
  Logger.log('Expected: a green "You are unsubscribed" page.');
  Logger.log('If you get a Google Drive error instead, the doGet edit has not been');
  Logger.log('deployed yet — add the unsubscribe line to Code.gs, then');
  Logger.log('Deploy -> Manage deployments -> pencil -> New version -> Deploy.');
}

/* Run this on its own to see exactly what you're allowed to send as. */
function checkFromAddress(){
  Logger.log('Script runs as: '+Session.getEffectiveUser().getEmail());
  const aliases=GmailApp.getAliases();
  Logger.log('Verified "send mail as" aliases: '+(aliases.length?aliases.join(', '):'(none yet)'));
  Logger.log('CONFIG.FROM_EMAIL is currently: '+(CONFIG.FROM_EMAIL||'(blank — will send as the owning account)'));
  try{
    assertFromAddressUsable_();
    Logger.log('✅ Good — emails will arrive from '+(CONFIG.FROM_EMAIL||Session.getEffectiveUser().getEmail()));
  }catch(err){
    Logger.log('❌ '+err.message);
  }
}

// ─────────────────── MAIN ───────────────────
function sendWeeklySummaries(){
  assertFromAddressUsable_();   // fail before sending anything, not halfway through
  const logs=readLogs_();
  if(!logs.length){ Logger.log('No logs found — nothing to send.'); return; }

  // The most recently completed Mon-Sun week. On the Sunday-evening trigger
  // that's the week ending today; run manually midweek it's the last full week.
  const today=new Date();
  const curSun=sundayOnOrBefore_(today);
  const curMon=new Date(curSun); curMon.setDate(curMon.getDate()-6);
  const preSun=new Date(curMon); preSun.setDate(preSun.getDate()-1);
  const preMon=new Date(preSun); preMon.setDate(preMon.getDate()-6);

  const curStart=ymd_(curMon), curEnd=ymd_(curSun);
  const preStart=ymd_(preMon), preEnd=ymd_(preSun);
  const weekLabel=Utilities.formatDate(curMon, tz_(), 'd MMM')+' – '+
                  Utilities.formatDate(curSun, tz_(), 'd MMM yyyy');

  // group by email (the only identifier we can actually send to)
  const byClient={};
  logs.forEach(function(l){
    if(!l.email) return;
    if(!byClient[l.email]) byClient[l.email]={ email:l.email, name:l.name, logs:[] };
    if(l.name) byClient[l.email].name=l.name;
    byClient[l.email].logs.push(l);
  });

  const optedOut=optedOutEmails_();
  const scriptUrl=CONFIG.SCRIPT_URL || ScriptApp.getService().getUrl();
  if(!/\/exec$/.test(scriptUrl)){
    throw new Error('CONFIG.SCRIPT_URL must be the deployed web app URL ending in /exec. Got: '+scriptUrl+'. Nothing was sent.');
  }
  let sent=0, skipped=0;

  Object.keys(byClient).forEach(function(email){
    const c=byClient[email];

    if(optedOut[email]){ skipped++; return; }
    if(c.logs.length<CONFIG.MIN_LIFETIME_LOGS){ skipped++; return; }

    const latest=c.logs.map(function(l){ return l.date; }).sort().pop();
    const quietDays=Math.round((today-new Date(latest))/86400000);
    if(quietDays>CONFIG.MAX_QUIET_DAYS){ skipped++; return; }

    const cur=summarise_(c.logs, curStart, curEnd);
    const prev=summarise_(c.logs, preStart, preEnd);

    const unsubUrl=scriptUrl+'?action=unsubscribe&email='+encodeURIComponent(email)+'&token='+unsubToken_(email);
    const html=buildEmail_(c, cur, prev, weekLabel, unsubUrl);
    const subject = cur.days===0
      ? 'Your week — pick it back up whenever'
      : 'Your week: '+cur.avgScore+'/100 across '+cur.days+' day'+(cur.days===1?'':'s');

    const to = CONFIG.TEST_MODE ? CONFIG.TEST_EMAIL : email;
    sendMail_(to, (CONFIG.TEST_MODE ? '[TEST → '+email+'] ' : '')+subject, html);
    sent++;
  });

  Logger.log('Weekly summary: '+sent+' sent'+(CONFIG.TEST_MODE?' (TEST MODE — all to '+CONFIG.TEST_EMAIL+')':'')+', '+skipped+' skipped.');
  Logger.log('Gmail quota remaining today: '+MailApp.getRemainingDailyQuota());
}

/* Run once, by hand, to schedule it. Safe to re-run — it clears its own
   old trigger first rather than stacking duplicates. */
function setupWeeklyEmailTrigger(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if(t.getHandlerFunction()==='sendWeeklySummaries') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendWeeklySummaries')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(18)          // 6–7pm Sunday
    .create();
  Logger.log('Scheduled: sendWeeklySummaries every Sunday around 18:00 ('+tz_()+').');
}

function removeWeeklyEmailTrigger(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if(t.getHandlerFunction()==='sendWeeklySummaries') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Weekly email trigger removed.');
}

/* Sanity check before you send anything: prints what each client would get,
   without sending a single email. */
function previewWeeklySummaries(){
  const logs=readLogs_();
  const today=new Date();
  const curSun=sundayOnOrBefore_(today);
  const curMon=new Date(curSun); curMon.setDate(curMon.getDate()-6);
  const byClient={};
  logs.forEach(function(l){
    if(!l.email) return;
    if(!byClient[l.email]) byClient[l.email]={email:l.email,name:l.name,logs:[]};
    byClient[l.email].logs.push(l);
  });
  const optedOut=optedOutEmails_();
  Object.keys(byClient).forEach(function(e){
    const c=byClient[e];
    const cur=summarise_(c.logs, ymd_(curMon), ymd_(curSun));
    Logger.log([e, c.name, 'days='+cur.days, 'avg='+cur.avgScore, optedOut[e]?'OPTED OUT':''].join('  '));
  });
  Logger.log('Week being summarised: '+ymd_(curMon)+' to '+ymd_(curSun));
  Logger.log('Total clients: '+Object.keys(byClient).length);
}
