// ═══════════════════════════════════════════════════════════════════════════
// CLIENT PROFILES — answers from the app's first-login setup
//
// One row per client, updated (never duplicated) if they redo the setup.
// The readable columns are for you; the last column holds the full answers
// as JSON, which is what the app reads back on a new phone.
// ═══════════════════════════════════════════════════════════════════════════

const PROFILES_SHEET = 'Profiles';
const PROFILE_HEADERS = [
  'Email', 'Name', 'Completed', 'Goal',
  'Skips meals when busy', 'Tracked food before', 'Weekends throw off',
  'Water (1-10)', 'Protein (1-10)', 'Sleep (1-10)', 'Steps (1-10)',
  'Fruit & veg (1-10)', 'Exercise (1-10)', 'Alcohol (1-10)', 'Lowest habit',
  'Calories', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Maintenance kcal',
  'Sex', 'Age', 'Height (cm)', 'Weight (kg)',
  'Work', 'Biggest challenge', 'Updated', 'Profile JSON'
];

function getProfilesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(PROFILES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PROFILES_SHEET);
    sheet.getRange(1, 1, 1, PROFILE_HEADERS.length).setValues([PROFILE_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function profileJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

const GOAL_LABELS_ = { lose: 'Lose fat', maintain: 'Maintain & feel better', gain: 'Build muscle', energy: 'More energy' };
const HABIT_KEYS_  = ['water', 'protein', 'sleep', 'steps', 'fv', 'exercise', 'alcohol'];
const HABIT_NAMES_ = { water: 'Water', protein: 'Protein', sleep: 'Sleep', steps: 'Steps', fv: 'Fruit & veg', exercise: 'Exercise', alcohol: 'Alcohol' };

function setProfile(data) {
  const email = String(data.email || '').toLowerCase().trim();
  const p = data.profile;
  if (!email || !p || typeof p !== 'object') return profileJson_({ error: 'Missing email or profile' });

  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (err) { return profileJson_({ error: 'busy' }); }
  try {
    const sheet = getProfilesSheet_();
    const r = p.ratings || {}, a = p.answers || {}, t = p.targets || {}, b = p.body || {}, ab = p.about || {};
    let lowest = '';
    HABIT_KEYS_.forEach(function (k) { if (r[k] != null && (lowest === '' || r[k] < r[lowest])) lowest = k; });
    const round1 = function (x) { return (x == null || x === '') ? '' : Math.round(Number(x) * 10) / 10; };

    const row = [
      email, String(data.name || ''), String(p.completedAt || ''), GOAL_LABELS_[p.goal] || '',
      a.skipsMeals || '', a.trackedBefore || '', a.weekendsOff || '',
      r.water != null ? r.water : '', r.protein != null ? r.protein : '', r.sleep != null ? r.sleep : '',
      r.steps != null ? r.steps : '', r.fv != null ? r.fv : '', r.exercise != null ? r.exercise : '',
      r.alcohol != null ? r.alcohol : '', HABIT_NAMES_[lowest] || '',
      t.kcal || '', t.protein || '', t.carbs || '', t.fat || '', t.tdee || '',
      b.sex === 'm' ? 'Male' : (b.sex === 'f' ? 'Female' : ''), b.age || '',
      round1(b.heightCm), round1(b.weightKg),
      String(ab.work || '').slice(0, 200), String(ab.challenge || '').slice(0, 500),
      new Date().toISOString(), JSON.stringify(p)
    ];

    const emails = sheet.getLastRow() > 1
      ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
      : [];
    for (let i = 0; i < emails.length; i++) {
      if (String(emails[i][0]).toLowerCase().trim() === email) {
        sheet.getRange(i + 2, 1, 1, row.length).setValues([row]);
        return profileJson_({ success: true, updated: true });
      }
    }
    sheet.appendRow(row);
    return profileJson_({ success: true });
  } finally {
    lock.releaseLock();
  }
}

function getProfile(e) {
  const email = String(e.parameter.email || '').toLowerCase().trim();
  if (!email) return profileJson_(null);
  const sheet = getProfilesSheet_();
  if (sheet.getLastRow() < 2) return profileJson_(null);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, PROFILE_HEADERS.length).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase().trim() === email) {
      let p = null;
      try { p = JSON.parse(rows[i][PROFILE_HEADERS.length - 1]); } catch (err) {}
      return profileJson_(p);
    }
  }
  return profileJson_(null);
}

/* Run this once from the editor to check everything works: it saves a test
   profile, reads it back, then deletes the test row. */
function testProfiles() {
  const testEmail = 'zz-profile-test@example.com';
  const out1 = setProfile({ email: testEmail, name: 'ZZ Test', profile: {
    completedAt: new Date().toISOString(), goal: 'lose',
    answers: { skipsMeals: 'yes', trackedBefore: 'no', weekendsOff: 'yes' },
    ratings: { water: 6, protein: 4, sleep: 3, steps: 7, fv: 5, exercise: 8, alcohol: 6 },
    targets: { kcal: 1500, protein: 140, carbs: 125, fat: 50, tdee: 1880 },
    body: { sex: 'f', age: 35, heightCm: 165, weightKg: 69.9 },
    about: { work: 'Teacher', challenge: 'Evening snacking' } } }).getContent();
  Logger.log('save -> ' + out1);
  const back = getProfile({ parameter: { email: testEmail } }).getContent();
  Logger.log('read back -> ' + back.slice(0, 120) + '…');
  const sheet = getProfilesSheet_();
  const rows = sheet.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][0]).toLowerCase() === testEmail) { sheet.deleteRow(i + 1); Logger.log('Test row cleaned up.'); }
  }
  Logger.log(back.indexOf('"goal":"lose"') > -1 ? 'PASS' : 'FAIL — check the doGet/doPost lines');
}