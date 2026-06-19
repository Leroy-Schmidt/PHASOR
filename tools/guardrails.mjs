// PHASOR process guardrails (operator robustness checks, ROADMAP). Run before
// claiming any subgoal/milestone green — and wired as a git pre-commit hook
// (see .githooks/pre-commit; activate with `git config core.hooksPath .githooks`).
// Exits non-zero on any violation.
//
//   #4  test discipline — fail=0, skipped=0, todo=0, and test count never drops
//       below MIN_TESTS (a vanished gate is a silent regression).
//   #5  golden numbers  — enforced by test/golden.test.mjs, which runs in the
//       suite below; #4 therefore covers it.
//   #3  tolerance tripwire — blocks if an EXISTING tolerance line is changed or
//       removed (a `-` line in test/ or src/ matching a tolerance pattern).
//       Adding a brand-new gate with new tolerances is fine (only `+` lines);
//       loosening or deleting an existing one is the cardinal sin and stops here.
//       Override only with Operator sign-off: GUARDRAILS_ALLOW_TOL_CHANGE=1.
import { spawnSync } from 'node:child_process';

const MIN_TESTS = 103; // raise when you add gates; LOWERING needs Operator sign-off

let failures = 0;
const fail = (m) => { console.error('  ✗ ' + m); failures++; };
const ok = (m) => console.log('  ✓ ' + m);

// ---- #4 test discipline -------------------------------------------------
console.log('[guardrails] #4 test discipline');
const res = spawnSync('node', ['--test'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = ((res.stdout || '') + (res.stderr || '')).replace(/\r/g, '');
const num = (kw) => {
  const m = out.match(new RegExp('^\\u2139 ' + kw + ' (\\d+)$', 'm'));
  return m ? Number(m[1]) : NaN;
};
const tests = num('tests');
const pass = num('pass');
const failed = num('fail');
const skipped = num('skipped');
const todo = num('todo');
if ([tests, failed, skipped, todo].some(Number.isNaN)) {
  fail('could not parse `node --test` summary (is the runner output as expected?)');
} else {
  if (failed > 0) fail(`${failed} failing test(s)`);
  if (skipped > 0) fail(`${skipped} skipped test(s) — gates must not be skipped`);
  if (todo > 0) fail(`${todo} todo test(s) — gates must not be marked todo`);
  if (tests < MIN_TESTS) fail(`test count ${tests} < baseline ${MIN_TESTS} — was a gate removed?`);
  if (failed === 0 && skipped === 0 && todo === 0 && tests >= MIN_TESTS) {
    ok(`tests ${tests}, pass ${pass}, fail 0, skipped 0, todo 0 (>= ${MIN_TESTS})`);
  }
}

// ---- #3 tolerance tripwire ---------------------------------------------
console.log('[guardrails] #3 tolerance tripwire');
const diff = spawnSync('git', ['diff', 'HEAD', '--', 'test', 'src'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
const TOL = /1e-\d|\btol\b|rtol|\brelRes\b|tolerance/i;
const removed = diff.replace(/\r/g, '').split('\n')
  .filter((l) => l.startsWith('-') && !l.startsWith('---') && TOL.test(l));
if (removed.length === 0) {
  ok('no existing tolerance lines changed or removed');
} else if (process.env.GUARDRAILS_ALLOW_TOL_CHANGE) {
  ok(`tolerance change ACKNOWLEDGED via GUARDRAILS_ALLOW_TOL_CHANGE (${removed.length} line(s))`);
} else {
  fail(`${removed.length} existing tolerance line(s) changed/removed — deliberate?`);
  console.error('    A tolerance that "needed" loosening usually means the change is wrong,');
  console.error('    not the test. With Operator sign-off, re-run: GUARDRAILS_ALLOW_TOL_CHANGE=1');
  for (const l of removed) console.error('      ' + l.trim());
}

console.log(failures ? `\n[guardrails] FAIL (${failures})` : '\n[guardrails] OK');
process.exit(failures ? 1 : 0);
