'use strict';
// Workflow journal (<run>/journal.jsonl) -> one slot per `key` (SPEC 5.2 step 1).
// Lines: launched, started{key,agentId,label,phase}, result{key,agentId,result}, failed{key,agentId}. No timestamps, no end marker.
// `key` identifies the slot (labels are not unique). A repeated `started` for the same key is a retry or a restart after a
// resume: the latest attempt wins, and an outcome line only counts when its agentId is the slot's CURRENT agent
// (a stalled earlier attempt must never finish the slot).

const RESULT_TEXT_MAX = 400;   // only a preview is kept: result lines can be 129 KB each
const LABEL_MAX = 200, PHASE_MAX = 100, KEY_MAX = 200;   // journal text is untrusted: bounded before anything else looks at it
// An agent id becomes part of a file name (agent-<id>.jsonl inside the run directory): letters, digits, "_" and "-" only (real
// ids are hex-like), so a hostile journal cannot point the tailer at another file with "../", a drive letter or a separator.
const SAFE_ID = /^[\w-]{1,64}$/;

/**
 * @param {string} text  whole journal; a torn last line (writer mid-append) and garbage lines are skipped
 * @returns {{slots:{key:string,id:string,label:string,phase:string|null,attempts:number,state:'running'|'done'|'failed',resultText:string|null}[], phasesSeen:string[]}}
 */
function parseJournal(text) {
  const byKey = new Map();
  const byId = new Map();          // agentId -> slot; fallback when an outcome line has no usable key
  const phasesSeen = [];
  const seenPhase = new Set();
  if (typeof text !== 'string' || !text) return { slots: [], phasesSeen };
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'started') {
      if (typeof e.agentId !== 'string' || !SAFE_ID.test(e.agentId)) continue;
      const key = typeof e.key === 'string' && e.key ? e.key.slice(0, KEY_MAX) : 'id:' + e.agentId;
      let s = byKey.get(key);
      if (!s) { s = { key, id: e.agentId, label: '', phase: null, attempts: 0, state: 'running', resultText: null }; byKey.set(key, s); }
      s.id = e.agentId;
      s.label = typeof e.label === 'string' ? e.label.slice(0, LABEL_MAX) : s.label;
      s.phase = typeof e.phase === 'string' && e.phase ? e.phase.slice(0, PHASE_MAX) : null;
      s.attempts++;
      s.state = 'running';
      s.resultText = null;
      byId.set(e.agentId, s);
      if (s.phase && !seenPhase.has(s.phase)) { seenPhase.add(s.phase); phasesSeen.push(s.phase); }
    } else if (e.type === 'result' || e.type === 'failed') {
      const s = (typeof e.key === 'string' && byKey.get(e.key.slice(0, KEY_MAX))) || byId.get(e.agentId);
      if (!s || s.id !== e.agentId) continue;                // outcome of a superseded attempt
      s.state = e.type === 'result' ? 'done' : 'failed';
      s.resultText = e.type === 'result' && typeof e.result === 'string' ? e.result.slice(0, RESULT_TEXT_MAX) : null;
    }
  }
  return { slots: [...byKey.values()], phasesSeen };
}

module.exports = { parseJournal, SAFE_ID };
