export const DEFINITION_VERSION = 1;
const TOUCH_WINDOW_SECONDS = 8;

export class Statistics {
  constructor() {
    this.touches = [];
    this.players = new Map();
    this.goals = [];
  }

  ensure(sessionId) {
    if (!this.players.has(sessionId)) this.players.set(sessionId, { touches: 0, goals: 0, assists: 0, ownGoals: 0, activeSeconds: 0, afkSeconds: 0 });
    return this.players.get(sessionId);
  }

  kick(sessionId, team, timeSeconds) {
    if (![1, 2].includes(team)) return;
    this.ensure(sessionId).touches++;
    this.touches = this.touches.filter(t => timeSeconds - t.timeSeconds <= TOUCH_WINDOW_SECONDS);
    this.touches.push({ sessionId, team, timeSeconds });
    if (this.touches.length > 16) this.touches.shift();
  }

  reset() { this.touches = []; }

  goal(team, timeSeconds) {
    const chain = this.touches.filter(t => timeSeconds - t.timeSeconds <= TOUCH_WINDOW_SECONDS && timeSeconds >= t.timeSeconds);
    const last = chain.at(-1);
    const result = { team, scorer: null, assist: null, ownGoal: false, confidence: 'low', definitionVersion: DEFINITION_VERSION };
    if (last) {
      result.scorer = last.sessionId;
      result.ownGoal = last.team !== team;
      result.confidence = 'medium';
      const stats = this.ensure(last.sessionId);
      if (result.ownGoal) stats.ownGoals++;
      else stats.goals++;
      if (!result.ownGoal) {
        const prev = chain.slice(0, -1).reverse().find(t => t.sessionId !== last.sessionId);
        if (prev?.team === team) {
          result.assist = prev.sessionId;
          this.ensure(prev.sessionId).assists++;
        }
      }
    }
    this.goals.push(result);
    this.reset();
    return result;
  }

  snapshot() { return { players: Object.fromEntries(this.players), goals: this.goals, definitionVersion: DEFINITION_VERSION }; }
}
