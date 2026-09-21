import test from 'node:test';
import assert from 'node:assert/strict';
import { getWeekUnits, computeExcusedFor, buildExcusedMap, validateSelectedUnits, exceptionUnitLabel } from '../src/lib/exceptions.ts';
import { calculateWeekSettlement } from '../src/lib/settlement.ts';
import type { ExceptionRequest, WorkoutCheck } from '../src/types.ts';

const check = (unitIndex?: number): WorkoutCheck => ({ timestamp: '2026-09-21T12:00:00Z', ...(unitIndex === undefined ? {} : { unitIndex }) });
const request = (overrides: Partial<ExceptionRequest> = {}): ExceptionRequest => ({
  id: '2026-W39:alice:0', sessionCode: 'ABC234', weekKey: '2026-W39', requester: 'alice',
  requesterDisplayName: 'Alice', slot: 0, kind: 'single', unitIndices: [2, 3],
  status: 'pending', reasonCode: 'krank', createdAt: '2026-09-21T13:00:00Z', ...overrides,
});
const statuses = (units: ReturnType<typeof getWeekUnits>) => units.map(u => u.status);

test('four planned, two trained: units three/four become excused only after approval', () => {
  const checks = [check(), check()];
  const pending = request();
  assert.deepEqual(statuses(getWeekUnits(4, checks, [pending], 'alice')), ['done', 'done', 'pending', 'pending']);
  assert.equal(computeExcusedFor([pending], 'alice', 4, 2, checks), 0);
  const approved = request({ status: 'approved' });
  assert.deepEqual(statuses(getWeekUnits(4, checks, [approved], 'alice')), ['done', 'done', 'excused', 'excused']);
  assert.equal(computeExcusedFor([approved], 'alice', 4, 2, checks), 2);
  assert.equal(checks.length, 2); // an excuse never fabricates a training entry
  const result = calculateWeekSettlement('2026-W39', [
    { user: 'alice', displayName: 'Alice', goal: 4, completed: 2, excused: 2, penaltyCents: 500 },
    { user: 'bob', displayName: 'Bob', goal: 3, completed: 3, penaltyCents: 500 },
  ]);
  assert.equal(result.memberBreakdown[0].debtCents, 0);
  assert.equal(result.memberBreakdown[0].isReceiver, false);
  assert.equal(result.memberBreakdown[0].completed, 2);
});
test('one excused unit leaves the other open and chargeable', () => {
  const requests = [request({ status: 'approved', unitIndices: [3] })];
  assert.deepEqual(statuses(getWeekUnits(4, [check(), check()], requests, 'alice')), ['done', 'done', 'open', 'excused']);
  const result = calculateWeekSettlement('2026-W39', [
    { user: 'alice', displayName: 'Alice', goal: 4, completed: 2, excused: 1, penaltyCents: 500 },
    { user: 'bob', displayName: 'Bob', goal: 1, completed: 1, penaltyCents: 500 },
  ]);
  assert.equal(result.entries[0].amountCents, 500);
});
test('selection works for every supported positive goal, including more than seven units', () => {
  for (let goal = 1; goal <= 14; goal++) {
    const units = getWeekUnits(goal, [], [], 'alice');
    const selected = validateSelectedUnits(Array.from({ length: goal }, (_, i) => i), units);
    const approved = request({ status: 'approved', unitIndices: selected });
    assert.equal(computeExcusedFor([approved], 'alice', goal, 0, []), goal);
  }
  assert.throws(() => validateSelectedUnits([], []));
});
test('rejection releases the exact units for a new request', () => {
  const units = getWeekUnits(4, [check(), check()], [request({ status: 'rejected' })], 'alice');
  assert.deepEqual(validateSelectedUnits([3, 2, 3], units), [2, 3]);
  assert.equal(computeExcusedFor([request({ status: 'rejected' })], 'alice', 4, 2), 0);
});
test('completed, pending, approved and invalid indices cannot be selected', () => {
  const units = getWeekUnits(5, [check()], [request({ unitIndices: [1] }), request({ id: 'other', unitIndices: [3], status: 'approved' })], 'alice');
  for (const index of [-1, 0, 1, 3, 5, 1.5, NaN]) assert.throws(() => validateSelectedUnits([index], units));
  assert.deepEqual(validateSelectedUnits([2, 4], units), [2, 4]);
});
test('explicit units stay in place when training after an excuse and when undoing another check', () => {
  const requests = [request({ status: 'approved', unitIndices: [2] })];
  const checks = [check(0), check(1), check(3)];
  assert.deepEqual(statuses(getWeekUnits(4, checks, requests, 'alice')), ['done', 'done', 'excused', 'done']);
  assert.deepEqual(statuses(getWeekUnits(4, checks.slice(1), requests, 'alice')), ['open', 'done', 'excused', 'done']);
});
test('training while approval is pending does not transfer that excuse to another unit', () => {
  const approved = request({ status: 'approved', unitIndices: [2] });
  const checks = [check(0), check(1), check(2)];
  assert.deepEqual(statuses(getWeekUnits(4, checks, [approved], 'alice')), ['done', 'done', 'done', 'open']);
  assert.equal(computeExcusedFor([approved], 'alice', 4, 3, checks), 0);
});
test('duplicate and overlapping approved requests never double-credit a unit', () => {
  const one = request({ status: 'approved', unitIndices: [2, 2, 3] });
  assert.equal(computeExcusedFor([one, { ...one, id: 'duplicate' }], 'alice', 4, 2), 2);
});
test('legacy single and whole-week requests keep working alongside exact selections', () => {
  const legacy = request({ unitIndices: undefined, slot: 19, status: 'approved' });
  assert.deepEqual(statuses(getWeekUnits(4, [check(), check()], [legacy], 'alice')), ['done', 'done', 'excused', 'open']);
  const wholeWeek = request({ kind: 'week', unitIndices: undefined, status: 'approved' });
  assert.equal(computeExcusedFor([wholeWeek, legacy], 'alice', 4, 2), 2);
});
test('other members and a new week without its own requests are unaffected', () => {
  const requests = [request({ status: 'approved' })];
  assert.deepEqual(buildExcusedMap(requests, { alice: { goal: 4, checks: [check(), check()] }, bob: { goal: 4, checks: [] } }), { alice: 2, bob: 0 });
  assert.deepEqual(statuses(getWeekUnits(4, [], [], 'alice')), ['open', 'open', 'open', 'open']);
  assert.equal(exceptionUnitLabel(request()), 'Einheiten 3, 4');
  assert.equal(exceptionUnitLabel(request({ unitIndices: [3] })), 'Einheit 4');
});
