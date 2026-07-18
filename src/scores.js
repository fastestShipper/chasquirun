// Global hi-score client. Talks to the same-origin API (nginx proxies
// /chasquirun/api/ to the score service); falls back to a localStorage board
// when offline or served locally, so the game never depends on the network.

const API = 'api/scores';
const LOCAL_KEY = 'chasqui.board';
const TAG_KEY = 'chasqui.tag';
const TOP_N = 10;

function localBoard() {
  try {
    const b = JSON.parse(localStorage.getItem(LOCAL_KEY));
    return Array.isArray(b) ? b : [];
  } catch {
    return [];
  }
}

function saveLocal(board) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(board.slice(0, TOP_N)));
  } catch { /* storage unavailable */ }
}

async function api(method, body) {
  const res = await fetch(API, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('api ' + res.status);
  return res.json();
}

export const Scores = {
  get lastTag() {
    try {
      const t = localStorage.getItem(TAG_KEY);
      return t && /^[A-Z0-9]{4}$/.test(t) ? t : 'AAAA';
    } catch {
      return 'AAAA';
    }
  },

  set lastTag(t) {
    try { localStorage.setItem(TAG_KEY, t); } catch { /* fine */ }
  },

  // -> {scores, source: 'global' | 'local'}
  async top() {
    try {
      const { scores } = await api('GET');
      return { scores, source: 'global' };
    } catch {
      return { scores: localBoard(), source: 'local' };
    }
  },

  qualifies(scores, dist) {
    if (dist < 30) return false;
    if (scores.length < TOP_N) return true;
    return dist > scores[TOP_N - 1].dist;
  },

  // -> {rank, scores, source}
  async submit(name, dist) {
    try {
      const { rank, scores } = await api('POST', { name, dist: Math.floor(dist) });
      return { rank, scores, source: 'global' };
    } catch {
      const board = localBoard();
      const entry = { name, dist: Math.floor(dist) };
      board.push(entry);
      board.sort((a, b) => b.dist - a.dist);
      const rank = board.indexOf(entry) + 1;
      saveLocal(board);
      return { rank, scores: board.slice(0, TOP_N), source: 'local' };
    }
  },
};
