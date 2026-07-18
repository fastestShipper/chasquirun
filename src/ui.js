// UI layer for Chasqui Run. Builds every DOM node inside the #ui root and
// exposes the exact API from ARCHITECTURE.md. All styling lives in
// css/style.css. No external assets; every icon is inline SVG.
//
// cb contract: { onPlay, onResume, onRestart, onMenu, onMute, onQuality }.
// The HUD pause button calls cb.onPause when the integrator provides it
// (optional, not part of the written contract, guarded with a check).

const NARROW_SPACE = ' '; // narrow no-break space for digit grouping
const COUNTDOWN_STEP_MS = 760; // per number: 3, 2, 1
const COUNTDOWN_GO_HOLD_MS = 950; // how long "CORRE" stays before fading
const TOAST_HOLD_MS = 2600;

// Group an integer with narrow spaces: 1234 -> "1 234".
function fmtInt(n) {
  n = n > 0 ? Math.floor(n) : 0;
  const s = String(n);
  const len = s.length;
  if (len <= 3) return s;
  const head = ((len - 1) % 3) + 1;
  let out = s.slice(0, head);
  for (let i = head; i < len; i += 3) out += NARROW_SPACE + s.slice(i, i + 3);
  return out;
}

function fmtMeters(n) {
  return fmtInt(n) + NARROW_SPACE + 'm';
}

// ---------------------------------------------------------------------------
// Inline SVG builders (called once at construction time only)
// ---------------------------------------------------------------------------

// Chakana, the Andean stepped cross, with a punched center circle.
function chakanaSVG(cls) {
  return (
    '<svg class="' + cls + '" viewBox="0 0 100 100" aria-hidden="true">' +
    '<path fill-rule="evenodd" fill="currentColor" d="M35 5 H65 V20 H80 V35 ' +
    'H95 V65 H80 V80 H65 V95 H35 V80 H20 V65 H5 V35 H20 V20 H35 Z ' +
    'M50 41 a9 9 0 1 0 0.01 0 Z"/></svg>'
  );
}

// Inti sun disc with triangular rays and a serene face.
function sunSVG(cls, face) {
  let rays = '';
  for (let i = 0; i < 12; i++) {
    const a = i * 30;
    rays +=
      '<polygon points="50,2 45,15 55,15" transform="rotate(' +
      a + ' 50 50)"/>';
  }
  const faceMarks = face
    ? '<circle cx="42" cy="45" r="3.4" fill="rgba(70,40,8,0.55)"/>' +
      '<circle cx="58" cy="45" r="3.4" fill="rgba(70,40,8,0.55)"/>' +
      '<path d="M41 57 q9 8 18 0" fill="none" stroke="rgba(70,40,8,0.5)" ' +
      'stroke-width="3" stroke-linecap="round"/>'
    : '';
  return (
    '<svg class="' + cls + '" viewBox="0 0 100 100" aria-hidden="true">' +
    '<g fill="currentColor">' + rays + '<circle cx="50" cy="50" r="25"/></g>' +
    '<circle cx="50" cy="50" r="25" fill="none" ' +
    'stroke="rgba(70,40,8,0.35)" stroke-width="2.5"/>' + faceMarks + '</svg>'
  );
}

// Wayra wind: two gust lines with curled ends.
function windSVG(cls) {
  return (
    '<svg class="' + cls + '" viewBox="0 0 100 100" aria-hidden="true">' +
    '<g fill="none" stroke="currentColor" stroke-width="9" ' +
    'stroke-linecap="round">' +
    '<path d="M10 40 h47 a12 12 0 1 0 -12 -12"/>' +
    '<path d="M10 62 h58 a12 12 0 1 1 -12 12"/>' +
    '</g></svg>'
  );
}

// Quri magnet: classic horseshoe with pale pole tips.
function magnetSVG(cls) {
  return (
    '<svg class="' + cls + '" viewBox="0 0 100 100" aria-hidden="true">' +
    '<path fill="currentColor" d="M30 14 v38 a20 20 0 0 0 40 0 v-38 h-16 ' +
    'v38 a4 4 0 0 1 -8 0 v-38 Z"/>' +
    '<rect x="30" y="14" width="16" height="12" fill="#f2ead6"/>' +
    '<rect x="54" y="14" width="16" height="12" fill="#f2ead6"/></svg>'
  );
}

// Andes silhouette for the best-distance chip.
function mountainSVG(cls) {
  return (
    '<svg class="' + cls + '" viewBox="0 0 100 100" aria-hidden="true">' +
    '<path fill="currentColor" d="M6 80 L38 26 L54 52 L67 36 L94 80 Z"/>' +
    '<path fill="#f2ead6" d="M32 36 L38 26 L44 36 L40 34 L38 38 L36 33 Z"/>' +
    '</svg>'
  );
}

// Speaker with waves plus a red slash shown while muted.
function speakerSVG(cls) {
  return (
    '<svg class="' + cls + '" viewBox="0 0 100 100" aria-hidden="true">' +
    '<path fill="currentColor" d="M18 38 h15 l19 -16 v56 l-19 -16 h-15 Z"/>' +
    '<g class="spk-waves" fill="none" stroke="currentColor" stroke-width="7" ' +
    'stroke-linecap="round">' +
    '<path d="M62 39 a14 14 0 0 1 0 22"/>' +
    '<path d="M71 30 a26 26 0 0 1 0 40"/></g>' +
    '<line class="spk-slash" x1="24" y1="78" x2="80" y2="22" ' +
    'stroke-width="9" stroke-linecap="round"/></svg>'
  );
}

function pauseSVG(cls) {
  return (
    '<svg class="' + cls + '" viewBox="0 0 100 100" aria-hidden="true">' +
    '<g fill="currentColor"><rect x="28" y="24" width="15" height="52" rx="5"/>' +
    '<rect x="57" y="24" width="15" height="52" rx="5"/></g></svg>'
  );
}

// Four decorative chakana corners for a panel or screen.
function cornerSet() {
  return (
    '<i class="ch-corner ch-tl">' + chakanaSVG('ch-svg') + '</i>' +
    '<i class="ch-corner ch-tr">' + chakanaSVG('ch-svg') + '</i>' +
    '<i class="ch-corner ch-bl">' + chakanaSVG('ch-svg') + '</i>' +
    '<i class="ch-corner ch-br">' + chakanaSVG('ch-svg') + '</i>'
  );
}

// ---------------------------------------------------------------------------
// UI class
// ---------------------------------------------------------------------------

export class UI {
  constructor(root, cb) {
    this.root = root;
    this.cb = cb || {};
    this._muted = false;
    this._quality = 'high';

    // HUD caches so updateHUD only touches the DOM on real changes.
    this._lastDist = -1;
    this._lastCoins = -1;
    this._lastMult = -1;

    this._cdTimers = [];
    this._toastTimer = 0;

    this._buildDOM();
    this._cacheRefs();
    this._bindEvents();
  }

  // ------------------------------------------------------------------ DOM --

  _buildDOM() {
    const html =
      // ------------------------------------------------------ title screen
      '<div class="screen scr-title">' +
      cornerSet() +
      '<div class="title-inner">' +
      '<h1 class="logo t-anim d1">CHASQUI RUN</h1>' +
      '<div class="subtitle-row t-anim d2">' +
      '<i class="sub-rule"></i>' +
      '<p class="subtitle">Guineo, el mensajero del Inca</p>' +
      '<i class="sub-rule"></i>' +
      '</div>' +
      '<div class="chips t-anim d3">' +
      '<div class="chip">' + mountainSVG('chip-ico') +
      '<span class="chip-txt"><span class="chip-label">Mejor marca</span>' +
      '<span class="chip-value j-best">0' + NARROW_SPACE + 'm</span></span>' +
      '</div>' +
      '<div class="chip">' + sunSVG('chip-ico chip-sun', false) +
      '<span class="chip-txt"><span class="chip-label">Soles</span>' +
      '<span class="chip-value j-coins">0</span></span>' +
      '</div>' +
      '</div>' +
      '<button class="btn btn-primary btn-play t-anim d4" type="button">' +
      'CORRER</button>' +
      '<p class="hint t-anim d5">' + chakanaSVG('hint-ch') +
      '<span>Flechas o WASD para moverte. Shift: nitro. Desliza en móvil.</span></p>' +
      '<div class="toggles t-anim d5">' +
      '<button class="tgl j-mute" type="button" aria-label="Sonido">' +
      speakerSVG('tgl-ico') + '<span class="tgl-label">Sonido</span></button>' +
      '<button class="tgl j-quality" type="button" aria-label="Calidad">' +
      mountainSVG('tgl-ico') +
      '<span class="tgl-label j-quality-label">Calidad alta</span></button>' +
      '</div>' +
      '<div class="title-board t-anim d6 j-title-board">' +
      '<div class="hs-title">Mejores chasquis</div>' +
      '<ol class="hs-rows j-tb-rows"></ol>' +
      '</div>' +
      '</div>' +
      '</div>' +
      // ---------------------------------------------------------------- HUD
      '<div class="hud">' +
      '<button class="hud-pause j-pause" type="button" aria-label="Pausa">' +
      pauseSVG('hud-pause-ico') + '</button>' +
      '<div class="hud-dist-wrap"><div class="hud-panel hud-dist-panel">' +
      '<span class="hud-dist j-dist">0' + NARROW_SPACE + 'm</span>' +
      '<span class="hud-mult j-mult">x2</span>' +
      '</div></div>' +
      '<div class="hud-panel hud-coins">' + sunSVG('hud-sun', true) +
      '<span class="hud-coins-val j-hud-coins">0</span></div>' +
      '<div class="hud-pills">' +
      this._pillHTML('inti', sunSVG('pill-ico', false)) +
      this._pillHTML('wayra', windSVG('pill-ico')) +
      this._pillHTML('quri', magnetSVG('pill-ico')) +
      '</div>' +
      '<button class="hud-nitro j-nitro" type="button" aria-label="Nitro">' +
      '<span class="nitro-ring"></span>' +
      windSVG('nitro-ico') +
      '<span class="nitro-label">NITRO</span>' +
      '</button>' +
      '</div>' +
      // -------------------------------------------------------------- toast
      '<div class="toast j-toast" role="status"></div>' +
      // ------------------------------------------------------------ flashes
      '<div class="flash flash-damage j-flash-damage"></div>' +
      '<div class="flash flash-gold j-flash-gold"></div>' +
      // ---------------------------------------------------------- countdown
      '<div class="screen scr-cd"><div class="cd-num j-cd-num">3</div></div>' +
      // -------------------------------------------------------------- pause
      '<div class="screen scr-modal scr-pause">' +
      '<div class="panel">' + cornerSet() +
      '<h2 class="panel-title">Pausa</h2>' +
      '<div class="panel-sep">' + chakanaSVG('sep-ch') + '</div>' +
      '<div class="btn-col">' +
      '<button class="btn btn-primary j-resume" type="button">Reanudar</button>' +
      '<button class="btn btn-ghost j-restart-p" type="button">Reiniciar</button>' +
      '<button class="btn btn-ghost j-menu-p" type="button">Menú</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      // ---------------------------------------------------------- game over
      '<div class="screen scr-modal scr-over">' +
      '<div class="panel">' + cornerSet() +
      '<div class="ribbon j-ribbon"><span>¡Nuevo récord!</span></div>' +
      '<h2 class="panel-title">Fin del camino</h2>' +
      '<div class="panel-sep">' + chakanaSVG('sep-ch') + '</div>' +
      '<div class="stats">' +
      '<div class="stat"><span class="stat-label">Distancia</span>' +
      '<span class="stat-value j-go-dist">0' + NARROW_SPACE + 'm</span></div>' +
      '<div class="stat"><span class="stat-label">Soles ganados</span>' +
      '<span class="stat-value stat-gold j-go-coins">0</span></div>' +
      '<div class="stat"><span class="stat-label">Mejor marca</span>' +
      '<span class="stat-value j-go-best">0' + NARROW_SPACE + 'm</span></div>' +
      '</div>' +
      // Arcade hi-score: 4-letter tag entry + shared global table.
      '<div class="hiscore j-hiscore">' +
      '<div class="hs-entry j-hs-entry">' +
      '<div class="hs-title">¡Entre los mejores chasquis!</div>' +
      '<div class="hs-slots j-hs-slots"></div>' +
      '<button class="btn btn-primary hs-save j-hs-save" type="button">Grabar</button>' +
      '</div>' +
      '<div class="hs-table j-hs-table">' +
      '<div class="hs-title j-hs-table-title">Mejores chasquis</div>' +
      '<ol class="hs-rows j-hs-rows"></ol>' +
      '</div>' +
      '</div>' +
      '<div class="btn-col">' +
      '<button class="btn btn-primary j-retry" type="button">Reintentar</button>' +
      '<button class="btn btn-ghost j-menu-o" type="button">Menú</button>' +
      '</div>' +
      '</div>' +
      '</div>';

    this.root.innerHTML = html;
  }

  _pillHTML(kind, iconHTML) {
    return (
      '<div class="pill pill-' + kind + ' j-pill-' + kind + '">' + iconHTML +
      '<div class="pill-bar"><div class="pill-fill j-fill-' + kind +
      '"></div></div></div>'
    );
  }

  _cacheRefs() {
    const $ = (sel) => this.root.querySelector(sel);
    this.els = {
      title: $('.scr-title'),
      best: $('.j-best'),
      coins: $('.j-coins'),
      playBtn: $('.btn-play'),
      muteBtn: $('.j-mute'),
      qualityBtn: $('.j-quality'),
      qualityLabel: $('.j-quality-label'),

      hud: $('.hud'),
      pauseBtn: $('.j-pause'),
      dist: $('.j-dist'),
      mult: $('.j-mult'),
      hudCoins: $('.j-hud-coins'),
      nitroBtn: $('.j-nitro'),

      toast: $('.j-toast'),
      flashDamage: $('.j-flash-damage'),
      flashGold: $('.j-flash-gold'),

      cd: $('.scr-cd'),
      cdNum: $('.j-cd-num'),

      pause: $('.scr-pause'),
      resumeBtn: $('.j-resume'),
      restartPBtn: $('.j-restart-p'),
      menuPBtn: $('.j-menu-p'),

      over: $('.scr-over'),
      ribbon: $('.j-ribbon'),
      goDist: $('.j-go-dist'),
      goCoins: $('.j-go-coins'),
      goBest: $('.j-go-best'),
      retryBtn: $('.j-retry'),
      menuOBtn: $('.j-menu-o'),

      titleBoard: $('.j-title-board'),
      tbRows: $('.j-tb-rows'),
      hiscore: $('.j-hiscore'),
      hsEntry: $('.j-hs-entry'),
      hsSlots: $('.j-hs-slots'),
      hsSave: $('.j-hs-save'),
      hsTable: $('.j-hs-table'),
      hsTableTitle: $('.j-hs-table-title'),
      hsRows: $('.j-hs-rows'),
    };

    // Powerup pill state records, fixed set, zero allocation in updateHUD.
    this._pills = {
      inti: this._pillRec($('.j-pill-inti'), $('.j-fill-inti')),
      wayra: this._pillRec($('.j-pill-wayra'), $('.j-fill-wayra')),
      quri: this._pillRec($('.j-pill-quri'), $('.j-fill-quri')),
    };
    this._pillList = [this._pills.inti, this._pills.wayra, this._pills.quri];
    this._nitroState = '';
    this._nitroQ = -1;
  }

  _pillRec(el, fill) {
    return { el, fill, active: false, seen: false, lastQ: -1 };
  }

  _bindEvents() {
    const cb = this.cb;
    this._bind(this.els.playBtn, () => cb.onPlay && cb.onPlay());
    this._bind(this.els.resumeBtn, () => cb.onResume && cb.onResume());
    this._bind(this.els.restartPBtn, () => cb.onRestart && cb.onRestart());
    this._bind(this.els.retryBtn, () => cb.onRestart && cb.onRestart());
    this._bind(this.els.menuPBtn, () => cb.onMenu && cb.onMenu());
    this._bind(this.els.menuOBtn, () => cb.onMenu && cb.onMenu());
    this._bind(this.els.pauseBtn, () => cb.onPause && cb.onPause());
    this._bind(this.els.nitroBtn, () => cb.onNitro && cb.onNitro());
    this._bind(this.els.muteBtn, () => {
      this.setMuted(!this._muted);
      if (cb.onMute) cb.onMute(this._muted);
    });
    this._bind(this.els.qualityBtn, () => {
      this.setQuality(this._quality === 'high' ? 'low' : 'high');
      if (cb.onQuality) cb.onQuality(this._quality);
    });
  }

  // Buttons must never keep keyboard focus away from the game.
  _bind(el, fn) {
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
      el.blur();
    });
  }

  _show(el) {
    el.classList.add('is-visible');
  }

  _hide(el) {
    el.classList.remove('is-visible');
  }

  // ---------------------------------------------------------------- title --

  showTitle(data) {
    this._clearCountdown();
    const best = data && data.best ? data.best : 0;
    const coins = data && data.coins ? data.coins : 0;
    this.els.best.textContent = fmtMeters(best);
    this.els.coins.textContent = fmtInt(coins);
    this._show(this.els.title);
  }

  hideTitle() {
    this._hide(this.els.title);
  }

  // ------------------------------------------------------------------ HUD --

  showHUD() {
    this._show(this.els.hud);
  }

  hideHUD() {
    this._hide(this.els.hud);
  }

  // Called every frame. Touches the DOM only when a displayed value changed.
  updateHUD(s) {
    if (!s) return;
    const els = this.els;

    const d = s.dist > 0 ? Math.floor(s.dist) : 0;
    if (d !== this._lastDist) {
      this._lastDist = d;
      els.dist.textContent = fmtMeters(d);
    }

    const c = s.coins > 0 ? Math.floor(s.coins) : 0;
    if (c !== this._lastCoins) {
      this._lastCoins = c;
      els.hudCoins.textContent = fmtInt(c);
    }

    const m = s.mult > 0 ? Math.round(s.mult) : 0;
    if (m !== this._lastMult) {
      this._lastMult = m;
      if (m > 1) {
        els.mult.textContent = 'x' + m;
        els.mult.classList.add('on');
      } else {
        els.mult.classList.remove('on');
      }
    }

    // Powerup pills: fixed elements, quantized fill updates.
    const pills = this._pillList;
    for (let i = 0; i < 3; i++) pills[i].seen = false;
    const list = s.powerups;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        const p = this._pills[entry.kind];
        if (!p) continue;
        p.seen = true;
        if (!p.active) {
          p.active = true;
          p.el.classList.add('on');
        }
        let t = entry.t01;
        if (!(t > 0)) t = 0;
        else if (t > 1) t = 1;
        const q = (t * 128) | 0;
        if (q !== p.lastQ) {
          p.lastQ = q;
          p.fill.style.transform = 'scaleX(' + q / 128 + ')';
        }
      }
    }
    for (let i = 0; i < 3; i++) {
      const p = pills[i];
      if (p.active && !p.seen) {
        p.active = false;
        p.lastQ = -1;
        p.el.classList.remove('on');
      }
    }

    if (s.nitro) this.setNitro(s.nitro.state, s.nitro.t01);
  }

  // Nitro button: 'ready' | 'active' | 'cooldown', t01 = charge/drain 0..1.
  setNitro(state, t01) {
    const btn = this.els.nitroBtn;
    if (!btn) return;
    if (state !== this._nitroState) {
      this._nitroState = state;
      btn.classList.toggle('is-ready', state === 'ready');
      btn.classList.toggle('is-active', state === 'active');
      btn.classList.toggle('is-cooldown', state === 'cooldown');
    }
    let t = t01;
    if (!(t > 0)) t = 0;
    else if (t > 1) t = 1;
    const q = (t * 128) | 0;
    if (q !== this._nitroQ) {
      this._nitroQ = q;
      btn.style.setProperty('--nitro-p', (q / 128 * 360).toFixed(1) + 'deg');
    }
  }

  // ------------------------------------------------------------ countdown --

  // Shows 3, 2, 1, CORRE. done() fires exactly when CORRE appears, which is
  // when main starts the run and audio blows the pututu.
  countdown(done) {
    this._clearCountdown();
    const cd = this.els.cd;
    const num = this.els.cdNum;
    this._show(cd);

    let step = 3;
    const tick = () => {
      const go = step === 0;
      num.textContent = go ? '¡CORRE, GUINEO!' : String(step);
      num.classList.toggle('is-go', go);
      num.classList.remove('pop');
      void num.offsetWidth; // restart the pop animation
      num.classList.add('pop');
      if (go) {
        if (typeof done === 'function') done();
        this._cdTimers.push(
          setTimeout(() => {
            this._hide(cd);
            num.classList.remove('pop', 'is-go');
          }, COUNTDOWN_GO_HOLD_MS)
        );
        return;
      }
      step--;
      this._cdTimers.push(setTimeout(tick, COUNTDOWN_STEP_MS));
    };
    tick();
  }

  // ------------------------------------------------------------- hi-score --

  // Arcade 4-letter tag entry. onConfirm(tag) fires once on Grabar/Enter.
  showScoreEntry(prefill, onConfirm) {
    this.hideScoreEntry();
    const el = this.els;
    el.hiscore.classList.add('is-visible');
    el.hsEntry.classList.add('on');
    el.hsTable.classList.remove('on');

    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const tag = (prefill && /^[A-Z0-9]{4}$/.test(prefill) ? prefill : 'AAAA').split('');
    let cursor = 0;
    let done = false;

    el.hsSlots.innerHTML = tag.map((ch, i) =>
      '<div class="hs-slot j-hs-slot" data-i="' + i + '">' +
      '<button class="hs-arrow hs-up" type="button" aria-label="Subir">▲</button>' +
      '<span class="hs-letter">' + ch + '</span>' +
      '<button class="hs-arrow hs-down" type="button" aria-label="Bajar">▼</button>' +
      '</div>'
    ).join('');

    const slots = [...el.hsSlots.querySelectorAll('.j-hs-slot')];
    const paint = () => {
      for (let i = 0; i < 4; i++) {
        slots[i].querySelector('.hs-letter').textContent = tag[i];
        slots[i].classList.toggle('active', i === cursor);
      }
    };
    const cycle = (dir) => {
      const idx = (CHARS.indexOf(tag[cursor]) + dir + CHARS.length) % CHARS.length;
      tag[cursor] = CHARS[idx];
      paint();
    };
    const confirm = () => {
      if (done) return;
      done = true;
      const name = tag.join('');
      this.hideScoreEntry();
      onConfirm(name);
    };

    slots.forEach((slot, i) => {
      slot.querySelector('.hs-letter').addEventListener('click', () => { cursor = i; paint(); });
      slot.querySelector('.hs-up').addEventListener('click', (e) => {
        e.preventDefault(); cursor = i; cycle(1); e.currentTarget.blur();
      });
      slot.querySelector('.hs-down').addEventListener('click', (e) => {
        e.preventDefault(); cursor = i; cycle(-1); e.currentTarget.blur();
      });
    });
    el.hsSave.onclick = (e) => { e.preventDefault(); e.currentTarget.blur(); confirm(); };

    this._hsKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirm(); return; }
      if (e.code === 'ArrowLeft') { cursor = (cursor + 3) % 4; paint(); }
      else if (e.code === 'ArrowRight') { cursor = (cursor + 1) % 4; paint(); }
      else if (e.code === 'ArrowUp') cycle(1);
      else if (e.code === 'ArrowDown') cycle(-1);
      else if (e.key === 'Backspace') { cursor = (cursor + 3) % 4; tag[cursor] = 'A'; paint(); }
      else if (/^[a-zA-Z0-9]$/.test(e.key)) {
        tag[cursor] = e.key.toUpperCase();
        cursor = Math.min(3, cursor + 1);
        paint();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', this._hsKey, true);
    paint();
  }

  hideScoreEntry() {
    if (this._hsKey) {
      window.removeEventListener('keydown', this._hsKey, true);
      this._hsKey = null;
    }
    this.els.hsEntry.classList.remove('on');
  }

  // Compact top-5 on the title screen.
  showTitleScores(scores, source) {
    const rows = scores.slice(0, 5).map((s, i) =>
      '<li class="hs-row">' +
      '<span class="hs-rank">' + (i + 1) + '</span>' +
      '<span class="hs-name">' + String(s.name).replace(/[^A-Z0-9]/g, '') + '</span>' +
      '<span class="hs-dist">' + Math.floor(s.dist) + NARROW_SPACE + 'm</span>' +
      '</li>'
    ).join('');
    this.els.tbRows.innerHTML = rows ||
      '<li class="hs-row hs-empty">' +
      (source === 'local' ? 'Sin marcas todavía' : 'Sé el primero') + '</li>';
  }

  // scores: [{name, dist}], youRank: 1-based or 0, source: 'global' | 'local'
  showScoreTable(scores, youRank, source) {
    const el = this.els;
    el.hiscore.classList.add('is-visible');
    el.hsTable.classList.add('on');
    el.hsTableTitle.textContent =
      source === 'local' ? 'Mejores chasquis (local)' : 'Mejores chasquis';
    el.hsRows.innerHTML = scores.slice(0, 10).map((s, i) =>
      '<li class="hs-row' + (i + 1 === youRank ? ' you' : '') + '">' +
      '<span class="hs-rank">' + (i + 1) + '</span>' +
      '<span class="hs-name">' + String(s.name).replace(/[^A-Z0-9]/g, '') + '</span>' +
      '<span class="hs-dist">' + Math.floor(s.dist) + NARROW_SPACE + 'm</span>' +
      '</li>'
    ).join('') || '<li class="hs-row hs-empty">Sé el primero</li>';
  }

  hideScores() {
    this.hideScoreEntry();
    this.els.hiscore.classList.remove('is-visible');
    this.els.hsTable.classList.remove('on');
  }

  // Public: abort a running countdown (e.g. the tab was hidden mid-count).
  cancelCountdown() {
    this._clearCountdown();
  }

  _clearCountdown() {
    for (let i = 0; i < this._cdTimers.length; i++) {
      clearTimeout(this._cdTimers[i]);
    }
    this._cdTimers.length = 0;
    this._hide(this.els.cd);
    this.els.cdNum.classList.remove('pop', 'is-go');
  }

  // ------------------------------------------------------------ game over --

  showGameOver(data) {
    const d = data || {};
    this.els.goDist.textContent = fmtMeters(d.dist || 0);
    this.els.goCoins.textContent = fmtInt(d.coins || 0);
    this.els.goBest.textContent = fmtMeters(d.best || 0);
    this.els.ribbon.classList.toggle('show', !!d.isRecord);
    this._show(this.els.over);
  }

  hideGameOver() {
    this._hide(this.els.over);
    this.hideScores();
  }

  // ---------------------------------------------------------------- pause --

  showPause() {
    this._show(this.els.pause);
  }

  hidePause() {
    this._hide(this.els.pause);
  }

  // ---------------------------------------------------------------- toast --

  toast(text) {
    const t = this.els.toast;
    t.textContent = text;
    t.classList.remove('show');
    void t.offsetWidth; // restart the transition
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), TOAST_HOLD_MS);
  }

  // -------------------------------------------------------------- flashes --

  flashDamage() {
    this._replay(this.els.flashDamage);
  }

  flashGold() {
    this._replay(this.els.flashGold);
  }

  _replay(el) {
    el.classList.remove('run');
    void el.offsetWidth;
    el.classList.add('run');
  }

  // -------------------------------------------------------------- toggles --

  // Reflect state only; does NOT invoke cb (used by main at boot from save).
  setMuted(m) {
    this._muted = !!m;
    this.els.muteBtn.classList.toggle('is-muted', this._muted);
  }

  // Accepts 'high' | 'low' (booleans tolerated: true means 'high').
  setQuality(q) {
    if (q === true) q = 'high';
    else if (q === false) q = 'low';
    this._quality = q === 'low' ? 'low' : 'high';
    const high = this._quality === 'high';
    this.els.qualityBtn.classList.toggle('is-low', !high);
    this.els.qualityLabel.textContent = high ? 'Calidad alta' : 'Calidad baja';
  }
}
