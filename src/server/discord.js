import { readFile } from 'node:fs/promises';
import { cleanText } from '../domain/chat.js';

export function createPublisher(store, config, fetchImpl = fetch) {
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const item = Object.values(store.state.outbox).find(x => x.status === 'pending' && x.nextAt <= Date.now());
      if (!item) return;
      await store.update(state => { state.outbox[item.key].status = 'sending'; state.outbox[item.key].attempts++; });
      const match = store.state.matches[item.matchId];
      const teams = [1, 2].map(team => match.players.filter(player => player.team === team).map(player => cleanText(player.name, 24)).slice(0, 15).join(', ') || 'sem jogadores');
      const totalTouches = Object.values(match.statistics?.players ?? {}).reduce((sum, stats) => sum + (stats.touches ?? 0), 0);
      const content = `Partida ${cleanText(match.matchId, 80)}: vermelho ${match.scores.red} x ${match.scores.blue} azul. Fim: ${match.reason}. Duração: ${Math.round(match.scores.time)}s.\nVermelho: ${teams[0]}\nAzul: ${teams[1]}\nToques observados: ${totalTouches}. Gols/assistências individuais são estimativas (v${match.statistics?.definitionVersion ?? 1}).`.slice(0, 1800);
      const payload = { content, allowed_mentions: { parse: [] } };
      let body;
      let headers;
      if (match.replay?.status === 'saved' && match.replay.size <= config.uploadMaxBytes) {
        body = new FormData();
        body.set('payload_json', JSON.stringify(payload));
        body.set('files[0]', new Blob([await readFile(match.replay.file)]), `${item.matchId}.hbr2`);
      } else {
        if (match.replay?.status === 'saved') payload.content += ' Replay acima do limite de upload.';
        body = JSON.stringify(payload);
        headers = { 'content-type': 'application/json' };
      }
      let response;
      try { response = await fetchImpl(`${config.webhook}?wait=true`, { method: 'POST', body, headers, signal: AbortSignal.timeout(15_000) }); }
      catch (error) {
        // The request may have reached Discord. A human must reconcile this item.
        await store.update(state => { state.outbox[item.key].status = 'uncertain'; state.outbox[item.key].lastError = error.name; });
        return;
      }
      if (response.ok) {
        const result = await response.json();
        await store.update(state => { state.outbox[item.key].status = 'sent'; state.outbox[item.key].messageId = String(result.id ?? ''); });
      } else if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await store.update(state => {
          const pending = state.outbox[item.key];
          pending.status = 'pending';
          pending.nextAt = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(300_000, 1000 * 2 ** pending.attempts)) + Math.floor(Math.random() * 500);
          pending.lastError = `HTTP ${response.status}`;
        });
      } else await store.update(state => { state.outbox[item.key].status = response.status >= 500 ? 'uncertain' : 'failed'; state.outbox[item.key].lastError = `HTTP ${response.status}`; });
    } finally { busy = false; }
  }
  return { tick };
}
