import test from 'node:test';
import assert from 'node:assert/strict';
import { planTeams } from '../src/domain/balance.js';
import { Statistics } from '../src/domain/statistics.js';
import { RateLimiter, parseCommand, cleanText } from '../src/domain/chat.js';

test('team plan assigns each selected player once and queues overflow', () => {
  const players = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, identityId: `p${i}`, waitingSince: i }));
  const ratings = Object.fromEntries(players.map((p, i) => [p.identityId, 900 + i * 10]));
  const plan = planTeams(players, 4, ratings);
  assert.equal(plan.red.length, 4);
  assert.equal(plan.blue.length, 4);
  assert.equal(plan.queue.length, 22);
  assert.deepEqual(new Set([...plan.red, ...plan.blue, ...plan.queue].map(p => p.id)).size, 30);
  assert.deepEqual(planTeams(players, 4, ratings), plan);
});

test('team size and uniqueness invariants hold from empty room to 30 players', () => {
  for (let count = 0; count <= 30; count++) {
    const players = Array.from({ length: count }, (_, id) => ({ id, identityId: `p${id}`, waitingSince: id }));
    const plan = planTeams(players, 5);
    assert.ok(Math.abs(plan.red.length - plan.blue.length) <= 1);
    assert.ok(plan.red.length <= 5 && plan.blue.length <= 5);
    assert.equal(new Set([...plan.red, ...plan.blue, ...plan.queue].map(p => p.id)).size, count);
  }
});

test('goal attribution expires and resets touch history', () => {
  const stats = new Statistics();
  stats.kick('a', 1, 1);
  stats.kick('b', 1, 2);
  assert.deepEqual(stats.goal(1, 3), { team: 1, scorer: 'b', assist: 'a', ownGoal: false, confidence: 'medium', definitionVersion: 1 });
  assert.equal(stats.goal(2, 4).scorer, null);
  stats.kick('c', 1, 5);
  assert.equal(stats.goal(2, 6).ownGoal, true);
  stats.kick('d', 2, 8);
  assert.equal(stats.goal(2, 20).scorer, null);
});

test('chat parser hides commands and limiter uses monotonic time', () => {
  assert.deepEqual(parseCommand('!STATUS'), { name: 'status', args: [] });
  assert.equal(parseCommand('hello'), null);
  assert.equal(cleanText('@everyone\nhi'), 'everyone hi');
  let now = 0;
  const limiter = new RateLimiter({ capacity: 1, refillMs: 1000, clock: () => now });
  assert.equal(limiter.take('p'), true);
  assert.equal(limiter.take('p'), false);
  now = 1000;
  assert.equal(limiter.take('p'), true);
});
