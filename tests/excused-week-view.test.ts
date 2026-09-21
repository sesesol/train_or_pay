import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThisWeekView } from '../src/components/ThisWeekView.tsx';
import { getBerlinISOWeek, getNextBerlinISOWeek } from '../src/lib/time.ts';
import type { ExceptionRequest } from '../src/types.ts';

const now = new Date();
const week = getBerlinISOWeek(now);
const request: ExceptionRequest = { id: 'request', slot: 0, kind: 'single', unitIndices: [2, 3], weekKey: week, sessionCode: 'ABC234', requester: 'alice', requesterDisplayName: 'Alice', status: 'approved', createdAt: now.toISOString() };
const data = { goal: 4, checks: [{ timestamp: now.toISOString() }, { timestamp: now.toISOString() }], penaltyCentsSnapshot: 500 };
function render(requests: ExceptionRequest[], user = 'alice') {
  return renderToStaticMarkup(React.createElement(ThisWeekView, {
    currentWeekKey: week, nextWeekKey: getNextBerlinISOWeek(now), usernameLower: user,
    currentUser: { id: user, displayName: user, pinHash: null, createdAt: now.toISOString(), sessions: ['ABC234'] },
    session: { code: 'ABC234', name: 'Friends', adminUser: 'alice', createdAt: now.toISOString(), settings: { allowMultiplePerDay: true }, members: ['alice', 'bob'].map(user => ({ user, displayName: user, joinedAt: now.toISOString(), penaltyCents: 500, active: true })) },
    myCurrentWeekData: data, myNextWeekData: null, allMembersCurrentWeek: { alice: data, bob: data },
    weekExceptions: requests, excusedByUser: { alice: requests.some(r => r.status === 'approved') ? 2 : 0 },
    onUpdateMyWeekData: async () => {}, onRequestException: async () => {}, onDecideException: async () => {}, onError: () => {}, onSuccess: () => {},
  }));
}
test('current week shows exact approved units separately from completed workouts', () => {
  const html = render([request]);
  assert.match(html, /aria-label="Einheit 1 von 4, erledigt"/);
  assert.match(html, /aria-label="Einheit 2 von 4, erledigt"/);
  assert.match(html, /aria-label="Einheit 3 von 4, entschuldigt"/);
  assert.match(html, /aria-label="Einheit 4 von 4, entschuldigt"/);
  assert.doesNotMatch(html, /id="approve-exception-request"/);
});
test('open week offers selection, and only partner sees approval controls with exact unit numbers', () => {
  assert.match(render([]), /Einheiten entschuldigen/);
  const pending = { ...request, status: 'pending' as const };
  assert.doesNotMatch(render([pending]), /id="approve-exception-request"/);
  const partner = render([pending], 'bob');
  assert.match(partner, /Einheiten 3, 4/);
  assert.match(partner, /id="approve-exception-request"/);
});
