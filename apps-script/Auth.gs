// ═══════════════════════════════════════════════════════════════════════════
// SIGN-IN BY EMAILED CODE
//
// Add as a NEW file (Auth.gs). Until this existed, the app trusted whatever
// email it was sent: anyone who knew a client's email could read and change
// that client's data. Now a client proves the email is theirs once per
// device:
//
//   1. requestCode  — the app sends an email address; a 6-digit code is
//                     emailed to it (valid 10 minutes).
//   2. verifyCode   — the app sends the code back; if it matches, it gets a
//                     signed "token" that says "this device belongs to
//                     <email>", valid for 90 days.
//   3. Every later request carries the token. authGate_ checks it.
//
// The Cloudflare Worker checks the same token, using the same secret.
//
// ONE-TIME SETUP (from this editor):
//   • Run setupAuth once. It creates the secret and prints it in the log.
//   • Copy that value into Cloudflare: the lean-comp-coach Worker → Settings
//     → Variables and Secrets → Add → name AUTH_SECRET, type Secret.
//
// TWO STAGES:
//   • Stage one (default): requests WITHOUT a valid token are still allowed,
//     so nobody is locked out while the app update reaches everyone.
//   • Stage two: run enforceAuthOn. From then on a valid token is required.
//     (enforceAuthOff undoes it.) Set AUTH_ENFORCE = true on the Worker too.
// ═══════════════════════════════════════════════════════════════════════════

const AUTH_FROM_NAME   = 'Lean Comp Nutrition';
const AUTH_REPLY_TO    = 'leancompnutrition@gmail.com';
const AUTH_CODE_MINUTES = 10;     // how long a code works
const AUTH_CODE_TRIES   = 5;      // wrong guesses before a code is thrown away
const AUTH_CODES_PER_HOUR = 5;    // codes one email address can ask for per hour
const AUTH_TOKEN_DAYS   = 90;     // how long a device stays signed in

/* The client routes that need a signed-in client. Coach routes use the PIN. */
const AUTH_GET_ACTIONS  = ['getMyLogs','getLeaderboard','getMyPrefs','getMyTargets','getMealPrefs','getProfile','getMyBodyComp','getMyCheckins'];
const AUTH_POST_ACTIONS = ['addLog','updateLog','setPref','setMealPrefs','setProfile','addBodyComp','addCheckin','deleteBodyComp'];

function authJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function authSecret_()  { return PropertiesService.getScriptProperties().getProperty('AUTH_SECRET') || ''; }
function authEnforced_() { return PropertiesService.getScriptProperties().getProperty('AUTH_ENFORCE') === 'true'; }
function authEmail_(v)  { return String(v || '').toLowerCase().trim(); }
function authValidEmail_(s) { return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

function authB64_(bytesOrString) { return Utilities.base64EncodeWebSafe(bytesOrString).replace(/=+$/, ''); }
function authHex_(bytes) { return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }
function authSha_(s) { return authHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function authSign_(payload, secret) { return authB64_(Utilities.computeHmacSha256Signature(payload, secret)); }
/* Compares without stopping at the first difference. */
function authSame_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ── tokens ─────────────────────────────────────────────────────────────── */
function authMakeToken_(email, secret) {
  const exp = Date.now() + AUTH_TOKEN_DAYS * 86400000;
  const payload = authB64_(JSON.stringify({ e: email, x: exp }));
  return { token: payload + '.' + authSign_(payload, secret), exp: exp };
}
/* Returns the email a token was issued to, or '' if it is missing, forged or expired. */
function authTokenEmail_(token) {
  const secret = authSecret_();
  const t = String(token || '');
  const dot = t.indexOf('.');
  if (!secret || dot < 1 || t.length > 1000) return '';
  const payload = t.slice(0, dot), sig = t.slice(dot + 1);
  if (!authSame_(sig, authSign_(payload, secret))) return '';
  try {
    const pad = payload + '==='.slice((payload.length + 3) % 4);
    const obj = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(pad)).getDataAsString());
    if (!obj || !obj.e || !(Number(obj.x) > Date.now())) return '';
    return authEmail_(obj.e);
  } catch (err) { return ''; }
}

/* Called from doGet / doPost before a client route runs.
   Returns null to let the request through, or a response to send back. */
function authGate_(email, token) {
  const who = authEmail_(email);
  const signedInAs = authTokenEmail_(token);
  if (signedInAs && signedInAs === who) return null;          // properly signed in
  if (!authEnforced_()) return null;                           // stage one: still allowed
  return authJson_({ error: 'auth_required' });
}

/* ── step 1: email a code ───────────────────────────────────────────────── */
function requestCode(e) {
  const email = authEmail_(e.parameter.email);
  if (!authValidEmail_(email)) return authJson_({ error: 'bad_email' });
  const secret = authSecret_();
  if (!secret) return authJson_({ error: 'not_configured' });

  const cache = CacheService.getScriptCache();
  const id = authSha_(email);
  const rateKey = 'authr:' + id;
  const asked = parseInt(cache.get(rateKey) || '0', 10);
  if (asked >= AUTH_CODES_PER_HOUR) return authJson_({ error: 'too_many', message: 'Too many codes requested. Please try again in an hour.' });
  // Gmail only lets this account send so many emails a day; keep a few back.
  if (MailApp.getRemainingDailyQuota() < 3) return authJson_({ error: 'mail_limit', message: 'We can’t send any more codes today. Please try again tomorrow.' });

  // 6 digits from a random UUID (not Math.random, which is guessable).
  const code = ('000000' + (parseInt(authSha_(Utilities.getUuid() + secret).slice(0, 8), 16) % 1000000)).slice(-6);
  cache.put('authc:' + id, JSON.stringify({ h: authSha_(code + '|' + email + '|' + secret), tries: 0 }), AUTH_CODE_MINUTES * 60);
  cache.put(rateKey, String(asked + 1), 3600);

  const text = 'Your Lean Comp Nutrition sign-in code is ' + code + '.\n\n' +
    'Type it into the app to finish signing in. It works for ' + AUTH_CODE_MINUTES + ' minutes.\n\n' +
    'If you didn’t ask for this, you can ignore this email. Nobody can sign in without the code.';
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#1f2a1a;max-width:440px">' +
    '<p>Your Lean Comp Nutrition sign-in code is:</p>' +
    '<p style="font-size:34px;font-weight:bold;letter-spacing:6px;color:#3d7a1a;margin:14px 0">' + code + '</p>' +
    '<p>Type it into the app to finish signing in. It works for ' + AUTH_CODE_MINUTES + ' minutes.</p>' +
    '<p style="color:#6b7a63;font-size:13px">If you didn’t ask for this, you can ignore this email. Nobody can sign in without the code.</p></div>';
  try {
    MailApp.sendEmail({ to: email, subject: code + ' is your Lean Comp Nutrition code', body: text, htmlBody: html, name: AUTH_FROM_NAME, replyTo: AUTH_REPLY_TO });
  } catch (err) {
    cache.remove('authc:' + id);
    return authJson_({ error: 'send_failed', message: 'We couldn’t send the email. Check the address and try again.' });
  }
  return authJson_({ ok: true, minutes: AUTH_CODE_MINUTES });
}

/* ── step 2: check the code, hand back a token ──────────────────────────── */
function verifyCode(e) {
  const email = authEmail_(e.parameter.email);
  const code = String(e.parameter.code || '').replace(/\D/g, '');
  const secret = authSecret_();
  if (!authValidEmail_(email) || code.length !== 6) return authJson_({ error: 'bad_code', message: 'That code isn’t right. Check it and try again.' });
  if (!secret) return authJson_({ error: 'not_configured' });

  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (err) { return authJson_({ error: 'busy' }); }
  try {
    const cache = CacheService.getScriptCache();
    const key = 'authc:' + authSha_(email);
    let rec = null;
    try { rec = JSON.parse(cache.get(key) || 'null'); } catch (err) { rec = null; }
    if (!rec) return authJson_({ error: 'expired', message: 'That code has expired. Ask for a new one.' });
    if (!authSame_(rec.h, authSha_(code + '|' + email + '|' + secret))) {
      rec.tries = (rec.tries || 0) + 1;
      if (rec.tries >= AUTH_CODE_TRIES) { cache.remove(key); return authJson_({ error: 'expired', message: 'Too many wrong tries. Ask for a new code.' }); }
      cache.put(key, JSON.stringify(rec), AUTH_CODE_MINUTES * 60);
      return authJson_({ error: 'bad_code', message: 'That code isn’t right. Check it and try again.' });
    }
    cache.remove(key);                       // a code works once
    const t = authMakeToken_(email, secret);
    return authJson_({ ok: true, token: t.token, exp: t.exp });
  } finally {
    lock.releaseLock();
  }
}

/* ── run from the editor ────────────────────────────────────────────────── */

/* Run ONCE. Creates the secret (if there isn't one) and prints it so you can
   copy it into Cloudflare as AUTH_SECRET. Safe to run again: it never
   changes an existing secret (changing it would sign everyone out). */
function setupAuth() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('AUTH_SECRET');
  if (!s) {
    s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('AUTH_SECRET', s);
    Logger.log('Created a new secret.');
  } else {
    Logger.log('A secret already exists; showing it again.');
  }
  Logger.log('AUTH_SECRET (copy everything between the arrows into Cloudflare):');
  Logger.log('>>>' + s + '<<<');
  Logger.log('Stage two (sign-in required) is ' + (authEnforced_() ? 'ON' : 'OFF') + '.');
}
/* Stage two: require a valid sign-in on every client route. */
function enforceAuthOn()  { PropertiesService.getScriptProperties().setProperty('AUTH_ENFORCE', 'true');  Logger.log('Sign-in is now REQUIRED.'); }
function enforceAuthOff() { PropertiesService.getScriptProperties().setProperty('AUTH_ENFORCE', 'false'); Logger.log('Sign-in is no longer required (stage one).'); }

/* Checks the token maths without sending any email. Expect PASS. */
function testAuth() {
  const secret = authSecret_();
  if (!secret) { Logger.log('No secret yet. Run setupAuth first.'); return; }
  const t = authMakeToken_('zz-auth-test@example.com', secret).token;
  const ok = authTokenEmail_(t) === 'zz-auth-test@example.com'
    && authTokenEmail_(t.slice(0, -2) + 'xx') === ''
    && authTokenEmail_('') === '';
  Logger.log(ok ? 'PASS' : 'FAIL');
  Logger.log('Emails this account can still send today: ' + MailApp.getRemainingDailyQuota());
}
