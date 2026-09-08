// Read-only production acceptance query. Runs INSIDE the container via
// `fly ssh console`. It only SELECTs; it never triggers a Slot.
// Usage: node /tmp/accept.js <YYYY-MM-DD>
const Database = require('/opt/pixivflow/node_modules/better-sqlite3');
const date = process.argv[2] || new Date().toISOString().slice(0, 10);

const pf = new Database('/app/data/pixivflow/pixivflow.db', { readonly: true });
console.log('\n--- PixivFlow Slot ledger (occurrence_date=' + date + ') ---');
let slots = [];
try {
  slots = pf.prepare(
    "select id,schedule_id,occurrence_at,status,trigger_source from schedule_slots where occurrence_at like ? order by schedule_id"
  ).all(date + '%');
} catch (e) { console.log('slots ERR', e.message); }

const expectedTargets = { 'bot1-daily': 2, 'bot2-daily': 2 };
let problems = 0;
for (const sid of Object.keys(expectedTargets)) {
  const s = slots.filter(x => x.schedule_id === sid);
  const tag = s.length === 1 ? 'OK' : (s.length === 0 ? 'MISSING' : 'DUP(x' + s.length + ')');
  if (s.length !== 1) problems++;
  console.log('  schedule ' + sid + ': slots=' + s.length + '  [ ' + tag + ' ]');
  for (const slot of s) {
    let items = [];
    try {
      items = pf.prepare(
        "select target_id,work_id,status,attempt_count,last_error from schedule_slot_items where slot_id=? order by target_id"
      ).all(slot.id);
    } catch (e) { console.log('    items ERR', e.message); }
    console.log('   slot ' + slot.id + ' status=' + slot.status + ' trigger=' + slot.trigger_source +
      ' items=' + items.length + '/' + expectedTargets[sid]);
    if (items.length !== expectedTargets[sid]) { console.log('      !! target count mismatch'); problems++; }
    for (const it of items) {
      const lock = it.work_id ? ('locked:' + String(it.work_id).slice(0, 10)) : 'NO_WORK(no_candidate?)';
      const err = it.last_error ? (' err=' + String(it.last_error).slice(0, 50)) : '';
      console.log('      - ' + String(it.target_id).padEnd(22) + String(it.status).padEnd(11) +
        ' attempts=' + it.attempt_count + ' ' + lock + err);
    }
    const dup = pf.prepare(
      "select target_id,count(*) c from schedule_slot_items where slot_id=? group by target_id having c>1"
    ).all(slot.id);
    if (dup.length) { console.log('      !! DUPLICATE (slot,target): ' + JSON.stringify(dup)); problems++; }
  }
}
let catchup = { n: 0 };
try { catchup = pf.prepare("select count(*) n from schedule_slots where trigger_source='catchup' and occurrence_at like ?").get(date + '%'); } catch (e) {}
console.log('  catchup-triggered slots today: ' + (catchup.n || 0) + ' (expect 0)');
if ((catchup.n || 0) > 0) problems++;
pf.close();

for (const bot of ['bot1', 'bot2']) {
  let db;
  try { db = new Database('/app/data/' + bot + '/submissions.db', { readonly: true }); }
  catch (e) { console.log('\n--- ' + bot + ' TelePost DB: not found ---'); continue; }
  console.log('\n--- TelePost ' + bot + ' pending_reviews (latest 6) ---');
  let rows = [];
  try {
    rows = db.prepare(
      "select status,target_id,source_label,source_ref,scheduled_at,created_at from pending_reviews order by rowid desc limit 6"
    ).all();
  } catch (e) { console.log('  ERR', e.message); }
  for (const r of rows) {
    console.log('  ' + String(r.status).padEnd(10) + ' tgt=' + String(r.target_id || '-').padEnd(22) +
      ' label=' + String(r.source_label || '-').slice(0, 30).padEnd(30) +
      ' ref=' + String(r.source_ref || '-').slice(0, 22) +
      ' sched=' + String(r.scheduled_at || '-').slice(0, 16));
  }
  db.close();
}
console.log('\nRESULT: ' + (problems === 0 ? 'ALL CHECKS OK' : problems + ' PROBLEM(S) — review above'));
