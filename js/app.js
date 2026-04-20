/* ══════════════════════════════════════════════
   RealVerdict · app.js
   Fixes: input validation, schema-safe hash decode,
   modal helper, NJ-neutral defaults, calcCore split,
   step count reduced to 3 (address merged into step 1),
   advanced metrics visible by default.
   ══════════════════════════════════════════════ */

import {
  STATES, MARKET_DEFAULTS, RATES, DEF, SCREENING_PRESETS, SPX_ANNUAL,
  RATE_SLIDER_MAX, SAVED_KEY, LAST_WIZARD_STEP, ADDR_STATE_FULL,
} from './constants.js';
import {
  clamp,
  calcCore as calcCorePure,
  sanitizeState as sanitizeStatePure,
  calcMortgage as calcMortgagePure,
  getPropTaxRate as propTaxRateForState,
  estimateUnitRent,
} from './math.js';

let heroMetricsTimer = null;
/** AbortController for hero metrics listeners (keys, swipe, wheel). */
let heroMetricsAbort = null;
let landingStoryIdx = 0;
/** Window resize / visualViewport — landing carousel size sync (ResizeObserver removed: flex feedback loops). */
let landingWinResizeHandler = null;
/** Throttled scroll — story step ↔ preview (replaces IntersectionObserver thrash). */
let landingStoryScrollHandler = null;

function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

function throttle(fn, ms) {
  let last = 0;
  return function (...args) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - last < ms) return;
    last = now;
    fn.apply(this, args);
  };
}

/* ── App state ── */
let S = structuredClone(DEF);
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'S', {
    get() { return S; },
    set(v) { S = v; },
    enumerable: true,
    configurable: true,
  });
}
let stepDir = 1, tf1 = 10, dashR = null, liveOv = {};
let stressRateDelta = 2, stressVacPct = 20, stressRentPct = 10;
let screeningMode = 'balanced';
let heroScrollCleanup = null;
let barAtBottom = false;

/* ── Helpers ── */
const $ = id => document.getElementById(id);
const fmtN = n => Math.round(Math.abs(n)).toLocaleString();
const fmtC = (n, always = false) => (n < 0 || always ? '-' : '+') + ' $' + fmtN(Math.abs(n));
const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';
const clrFor = (v, lo, hi) => v >= hi ? 'var(--accent)' : v >= lo ? 'var(--yellow)' : 'var(--red)';
const lerp = (a, b, t) => a + (b - a) * t;
const fmtK = v => Math.abs(v) >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + fmtN(Math.round(v / 1000)) + 'k';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function makeDebounce(ms = 180) {
  let t = null;
  return fn => { clearTimeout(t); t = setTimeout(fn, ms); };
}
const deLiveDebounce = makeDebounce(160);

let modalPrevFocus = null;
let modalKeyHandler = null;

/** Focus trap + Escape; restores focus to the opener on close. */
function closeModal(id) {
  const el = typeof id === 'string' ? $(id) : id;
  if (!el) return;
  el.classList.remove('open');
  if (modalKeyHandler) {
    document.removeEventListener('keydown', modalKeyHandler, true);
    modalKeyHandler = null;
  }
  if (modalPrevFocus && typeof modalPrevFocus.focus === 'function') {
    try { modalPrevFocus.focus(); } catch (_) {}
  }
  modalPrevFocus = null;
}

function openModal(id) {
  const el = $(id);
  if (!el) return;
  document.querySelectorAll('.mover.open').forEach(m => {
    if (m !== el) closeModal(m.id);
  });
  modalPrevFocus = document.activeElement;
  el.classList.add('open');
  const modal = el.querySelector('.modal');
  requestAnimationFrame(() => {
    const foc = modal?.querySelector(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (foc) foc.focus();
  });

  modalKeyHandler = (e) => {
    if (!el.classList.contains('open')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal(el.id);
      return;
    }
    if (e.key !== 'Tab' || !modal) return;
    const nodes = [...modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter(n => n.offsetParent !== null || n === document.activeElement);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else if (document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  };
  document.addEventListener('keydown', modalKeyHandler, true);
}

/** Strip all modal backdrops — use when changing root screen so `.mover.open` cannot block clicks. */
function dismissAllModalOverlays() {
  document.querySelectorAll('.mover').forEach(m => m.classList.remove('open'));
  if (modalKeyHandler) {
    document.removeEventListener('keydown', modalKeyHandler, true);
    modalKeyHandler = null;
  }
  modalPrevFocus = null;
}

function getDataAsOf() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function getPropTaxRate() {
  return propTaxRateForState((S.addr && S.addr.state) || '');
}

function highlightNumbers(s) {
  if (!s) return '';
  const escaped = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/(\$[\d,]+(?:\.\d+)?(?:\/(?:mo|yr|year|month))?|\d+(?:\.\d+)?\s?%|\d+(?:\.\d+)?\s?[x×])/g,
    '<span class="vadv-num">$1</span>');
}

/* ── FRED live rate ── */
function fetchMortgageRate(key) {
  if (!key || typeof key !== 'string' || key.length < 8) return;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=MORTGAGE30US&api_key=${encodeURIComponent(key)}&limit=1&sort_order=desc&file_type=json`;
  fetch(url)
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      if (!d || !Array.isArray(d.observations)) return;
      const obs = d.observations[0];
      const v = parseFloat(obs && obs.value);
      const dt = obs && obs.date;
      if (!v || !isFinite(v) || v < 2 || v > 20) return;
      MARKET_DEFAULTS.MORTGAGE_30Y_FRM = v;
      if (!S.price) S.rate = v;
      const ind = $('rateInd');
      if (ind) { ind.textContent = '⚡ Live · ' + (dt ? dt.slice(0, 10) : ''); ind.classList.add('live'); }
      try { localStorage.setItem('rv_rate_cache', JSON.stringify({ v, dt, fetched: Date.now() })); } catch (_) {}
    })
    .catch(() => {});
}

function promptFredKey() {
  const k = localStorage.getItem('rv_fred_key') || '';
  const inp = $('fredKeyInp');
  if (inp) inp.value = k;
  openModal('fredModal');
}

function saveFredKey() {
  const inp = $('fredKeyInp');
  const k = (inp ? inp.value : '').trim();
  closeModal('fredModal');
  if (!k) return;
  try { localStorage.setItem('rv_fred_key', k); } catch (_) {}
  fetchMortgageRate(k);
}

/* ── Theme ── */
function toggleTheme() {
  const d = isDark();
  const t = d ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('rv_theme', t); } catch (_) {}
  $('togL').classList.toggle('on', !d);
  $('togD').classList.toggle('on', d);
  redrawCharts();
}

/** Reset and replay intro entrance (home button + first visit stagger). */
function resetOpeningEntrance() {
  ['ohero', 'octa', 'openPreview'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.classList.remove('in');
    el.style.removeProperty('opacity');
    el.style.removeProperty('transform');
  });
  const hr = $('openRecent') && $('openRecent').querySelector('.home-recent');
  if (hr) {
    hr.classList.remove('in');
    hr.style.removeProperty('opacity');
    hr.style.removeProperty('transform');
  }
}

function runOpeningEntrance(staggered) {
  const addAll = () => {
    const h = $('ohero'); if (h) h.classList.add('in');
    const c = $('octa'); if (c) c.classList.add('in');
    const p = $('openPreview'); if (p) p.classList.add('in');
    const hr = $('openRecent') && $('openRecent').querySelector('.home-recent');
    if (hr) hr.classList.add('in');
  };
  if (!staggered) { addAll(); return; }
  setTimeout(() => { const e = $('ohero'); if (e) e.classList.add('in'); }, 20);
  setTimeout(() => { const e = $('octa'); if (e) e.classList.add('in'); }, 140);
  setTimeout(() => { const e = $('openPreview'); if (e) e.classList.add('in'); }, 420);
  setTimeout(() => {
    const hr = $('openRecent') && $('openRecent').querySelector('.home-recent');
    if (hr) hr.classList.add('in');
  }, 1100);
}

function stopLandingDemoRotator() {
  if (heroMetricsAbort) {
    heroMetricsAbort.abort();
    heroMetricsAbort = null;
  }
  if (heroMetricsTimer) {
    clearInterval(heroMetricsTimer);
    heroMetricsTimer = null;
  }
  if (landingWinResizeHandler) {
    window.removeEventListener('resize', landingWinResizeHandler);
    try {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', landingWinResizeHandler);
      }
    } catch (_) {}
    landingWinResizeHandler = null;
  }
  if (landingStoryScrollHandler) {
    window.removeEventListener('scroll', landingStoryScrollHandler);
    landingStoryScrollHandler = null;
  }
}

/** Sticky story section preview — separate index so hero auto-rotate does not fight scroll steps. */
function landingApplyStorySlide(idx) {
  if (idx === landingStoryIdx) return;
  landingStoryIdx = idx;
  const vp2 = $('openStoryViewport');
  const track2 = $('openStoryTrack');
  const dots2 = $('openStoryDots');
  if (vp2 && track2) {
    const h2 = vp2.clientHeight;
    if (h2) track2.style.transform = `translate3d(0, -${idx * h2}px, 0)`;
    if (dots2) dots2.querySelectorAll('.open-scroll-dot').forEach((d, i) => d.classList.toggle('is-active', i === idx));
  }
}

const HERO_METRICS_INTERVAL_MS = 9600;

/** Auto-rotating hero metrics (no ResizeObserver; panels cross-fade). */
function initHeroMetricsRotator() {
  heroMetricsAbort?.abort();
  heroMetricsAbort = new AbortController();
  const { signal } = heroMetricsAbort;

  const root = document.querySelector('#openPreview.open-hero-viz');
  const dotsWrap = $('openHeroMetricsDots');
  const capEl = $('openHeroMetricsCaption');
  const stepEl = $('openHeroMetricsStep');
  const panels = root ? root.querySelectorAll('[data-hero-panel]') : [];
  if (!panels.length) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const total = panels.length;
  function setStep(n) {
    if (stepEl) stepEl.textContent = `${n + 1} / ${total}`;
  }

  let heroMetricsIdx = 0;
  const captions = [...panels].map(p => p.getAttribute('data-caption') || '');

  function restartAutoTimer() {
    if (reduced) return;
    if (heroMetricsTimer) clearInterval(heroMetricsTimer);
    heroMetricsTimer = setInterval(() => goHeroMetrics(heroMetricsIdx + 1), HERO_METRICS_INTERVAL_MS);
  }

  function goHeroMetrics(i) {
    const n = ((i % panels.length) + panels.length) % panels.length;
    heroMetricsIdx = n;
    panels.forEach((p, j) => p.classList.toggle('is-active', j === n));
    if (dotsWrap) {
      dotsWrap.querySelectorAll('.open-hero-viz-dot').forEach((d, j) => {
        d.classList.toggle('is-active', j === n);
        d.setAttribute('aria-selected', j === n ? 'true' : 'false');
      });
    }
    if (capEl) capEl.textContent = captions[n] || '';
    setStep(n);
  }

  function manualGo(delta) {
    goHeroMetrics(heroMetricsIdx + delta);
    restartAutoTimer();
  }

  if (dotsWrap) {
    dotsWrap.innerHTML = [...panels]
      .map(
        (_, i) =>
          `<button type="button" class="open-hero-viz-dot${i === 0 ? ' is-active' : ''}" role="tab" aria-selected="${i === 0 ? 'true' : 'false'}" aria-label="Show: ${esc(captions[i] || `View ${i + 1}`)}"></button>`
      )
      .join('');
    dotsWrap.querySelectorAll('.open-hero-viz-dot').forEach((btn, i) => {
      btn.addEventListener(
        'click',
        () => {
          goHeroMetrics(i);
          restartAutoTimer();
        },
        { signal }
      );
    });
  }

  function openingIsActive() {
    const op = document.getElementById('opening');
    return !!(op && op.classList.contains('active'));
  }

  window.addEventListener(
    'keydown',
    e => {
      if (!openingIsActive()) return;
      if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        manualGo(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        manualGo(1);
      }
    },
    { signal }
  );

  if (root) {
    let touchStartX = 0;
    let touchStartY = 0;
    root.addEventListener(
      'touchstart',
      ev => {
        const t = ev.touches[0];
        if (!t) return;
        touchStartX = t.screenX;
        touchStartY = t.screenY;
      },
      { signal, passive: true }
    );
    root.addEventListener(
      'touchend',
      ev => {
        const dx = ev.changedTouches[0].screenX - touchStartX;
        const dy = ev.changedTouches[0].screenY - touchStartY;
        if (Math.abs(dx) < Math.abs(dy)) return;
        if (Math.abs(dx) < 56) return;
        if (dx < 0) manualGo(1);
        else manualGo(-1);
      },
      { signal, passive: true }
    );

    root.addEventListener(
      'wheel',
      ev => {
        if (Math.abs(ev.deltaX) < Math.abs(ev.deltaY)) return;
        if (Math.abs(ev.deltaX) < 28) return;
        ev.preventDefault();
        manualGo(ev.deltaX > 0 ? 1 : -1);
      },
      { signal, passive: false }
    );
  }

  if (capEl) capEl.textContent = captions[0] || '';
  setStep(0);
  goHeroMetrics(0);

  if (!reduced) {
    heroMetricsTimer = setInterval(() => goHeroMetrics(heroMetricsIdx + 1), HERO_METRICS_INTERVAL_MS);
  }
}

function initLandingDemoRotator() {
  stopLandingDemoRotator();
  initHeroMetricsRotator();

  // Story walkthrough — sticky viewport + scroll-spy (no hero carousel IDs required)
  const vp2 = $('openStoryViewport');
  const track2 = $('openStoryTrack');
  const dots2 = $('openStoryDots');
  let lastStoryVpH = -1;
  let slides2 = null;
  if (vp2 && track2 && dots2) {
    slides2 = track2.querySelectorAll('.open-scroll-slide');
    dots2.innerHTML = [...slides2].map((_, i) => `<span class="open-scroll-dot${i === 0 ? ' is-active' : ''}"></span>`).join('');
    function syncHeight2() {
      const h2 = Math.round(vp2.clientHeight);
      if (!h2) return;
      if (h2 === lastStoryVpH) return;
      lastStoryVpH = h2;
      slides2.forEach(s => { s.style.height = `${h2}px`; });
      track2.style.transform = `translate3d(0, -${landingStoryIdx * h2}px, 0)`;
    }
    const debouncedStorySync = debounce(() => {
      lastStoryVpH = -1;
      syncHeight2();
    }, 120);
    syncHeight2();
    landingWinResizeHandler = () => debouncedStorySync();
    window.addEventListener('resize', landingWinResizeHandler, { passive: true });
    try {
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', landingWinResizeHandler, { passive: true });
      }
    } catch (_) {}
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        lastStoryVpH = -1;
        syncHeight2();
      });
    });
  }

  const stepsRoot = $('openStorySteps');
  let lastStoryPick = -999;
  function syncStoryStepFromScroll() {
    const op = $('opening');
    if (!op || !op.classList.contains('active')) return;
    if (!stepsRoot) return;
    const vh = window.innerHeight || 800;
    const storySec = stepsRoot.closest('.open-story');
    const bounds = storySec ? storySec.getBoundingClientRect() : stepsRoot.getBoundingClientRect();
    if (bounds.bottom < 160 || bounds.top > vh - 80) return;
    const steps = [...stepsRoot.querySelectorAll('.open-story-step')];
    if (!steps.length) return;
    const targetY = vh * 0.38;
    let best = null;
    let bestDist = Infinity;
    for (const s of steps) {
      const r = s.getBoundingClientRect();
      if (r.bottom < 80 || r.top > vh - 80) continue;
      const cy = (r.top + r.bottom) / 2;
      const d = Math.abs(cy - targetY);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    if (!best) return;
    const n = parseInt(best.getAttribute('data-slide') || '0', 10);
    if (Number.isNaN(n) || n === lastStoryPick) return;
    lastStoryPick = n;
    steps.forEach(s => s.classList.toggle('is-active', s === best));
    landingApplyStorySlide(n);
  }
  if (stepsRoot && slides2 && slides2.length) {
    landingStoryScrollHandler = throttle(syncStoryStepFromScroll, 150);
    window.addEventListener('scroll', landingStoryScrollHandler, { passive: true });
    requestAnimationFrame(() => syncStoryStepFromScroll());
  }
}

/* ── Boot ──
   ES modules are deferred; `DOMContentLoaded` may already have fired when this runs.
   Always run init immediately if the document is past the loading phase. */
function bootRealVerdict() {
  if (bootRealVerdict._done) return;
  bootRealVerdict._done = true;

  try {
    const savedTheme = localStorage.getItem('rv_theme');
    if (savedTheme) {
      document.documentElement.setAttribute('data-theme', savedTheme);
      $('togL').classList.toggle('on', savedTheme === 'light');
      $('togD').classList.toggle('on', savedTheme === 'dark');
    }
  } catch (_) {}

  try {
    const sm = localStorage.getItem('rv_screening_v1');
    if (sm && SCREENING_PRESETS[sm]) screeningMode = sm;
  } catch (_) {}

  if (tryDecodeHash()) { showResults(); return; }

  renderHomeRecent();

  try {
    initLandingDemoRotator();
  } catch (_) {}

  try {
    if (sessionStorage.getItem('rv_seen_open')) { runOpeningEntrance(false); }
    else {
      runOpeningEntrance(true);
      sessionStorage.setItem('rv_seen_open', '1');
    }
  } catch (_) { runOpeningEntrance(false); }

  [['saveNameInp', saveAnalysisConfirm], ['fredKeyInp', saveFredKey]].forEach(([id, fn]) => {
    const el = $(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') fn(); });
  });

  document.querySelectorAll('.mover').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); });
  });

  try {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  } catch (_) {}

  try {
    const fredKey = localStorage.getItem('rv_fred_key');
    if (fredKey) fetchMortgageRate(fredKey);
  } catch (_) {}
}
bootRealVerdict._done = false;

/* ── Expose handlers on window before boot so inline onclick/oninput attrs are always callable. ──
   Function declarations are hoisted in ESM scope, so this is safe even though some functions
   are defined later in the file. */
Object.assign(window, {
  goHome,
  toggleTheme,
  startWizard,
  closeModal,
  openModal,
  saveAnalysisPrompt,
  saveAnalysisConfirm,
  doPrint,
  runCompare,
  saveFredKey,
  goBack,
  loadSavedAnalysis,
  promptFredKey,
  showTip,
  tryStep0Continue,
  selUnit,
  setPeriod,
  prevStep,
  nextStep,
  tryStep1Continue,
  autoFill,
  showResults,
  setPeriodExp,
  updateRent,
  updExpInp,
  adjStep,
  scrollToPart,
  openPdf,
  openCompare,
  deLive,
  stressLive,
  whatIfLive,
  syncDP,
  syncRT,
  zipLookup,
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootRealVerdict);
} else {
  bootRealVerdict();
}

/* ── Home recent ── */
function renderHomeRecent() {
  const el = $('openRecent');
  if (!el) return;
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (_) {}
  if (!arr.length) { el.innerHTML = ''; return; }
  const recent = [...arr].reverse().slice(0, 3);
  el.innerHTML = `<div class="home-recent">
    <div class="home-recent-hd">Continue where you left off</div>
    <div class="home-recent-list">
      ${recent.map(e => `<button class="home-recent-item" onclick="loadSavedAnalysis(${e.id})">
        <span class="home-recent-name">${esc(e.name || 'Unnamed')}</span>
        <span class="home-recent-meta">${new Date(e.created).toLocaleDateString()}</span>
      </button>`).join('')}
    </div>
  </div>`;
}

/* ── Home / Reset ── */
function updateCompactHero(R, verdict, color, cfC) {
  const bar = $('rvCompactBar');
  if (bar) {
    bar.style.setProperty('--vc', color);
    bar.style.borderBottomColor = `color-mix(in srgb, ${color} 20%, var(--border))`;
  }
  const sv   = $('cpVerdict'); if (sv)   { sv.textContent = verdict; sv.style.color = color; }
  const scf  = $('cpCF');      if (scf)  { scf.textContent = (R.cf >= 0 ? '+$' : '−$') + fmtN(Math.abs(R.cf)) + '/mo'; scf.style.color = cfC; }
  const scap = $('cpCap');     if (scap) { const c = clrFor(R.capRate, 5, 8); scap.textContent = R.capRate.toFixed(1) + '%'; scap.style.color = c; }
  const scoc = $('cpCoc');     if (scoc) { const c = clrFor(R.coc, 5, 10); scoc.textContent = R.coc.toFixed(1) + '%'; scoc.style.color = c; }
  const sds  = $('cpDscr');    if (sds)  { const c = R.dscr >= 1.25 ? 'var(--accent)' : R.dscr >= 1.0 ? 'var(--yellow)' : 'var(--red)'; sds.textContent = R.dscr.toFixed(2) + '×'; sds.style.color = c; }
  const sirr = $('cpIrr');     if (sirr) { const c = clrFor(R.irr10, 8, 12); sirr.textContent = R.irr10 > 0 ? R.irr10.toFixed(1) + '%' : '< 0%'; sirr.style.color = c; }
}

function goHome() {
  document.documentElement.classList.remove('rv-results-active');
  if (heroScrollCleanup) { heroScrollCleanup(); heroScrollCleanup = null; }
  const bar = $('rvCompactBar'); if (bar) bar.classList.remove('rv-cb--on');
  barAtBottom = false; const bar2 = $('rvCompactBar'); if (bar2) bar2.classList.remove('rv-cb--at-bottom', 'rv-cb--switching');
  S = structuredClone(DEF);
  tf1 = 10; dashR = null; liveOv = {};
  stressRateDelta = 2; stressVacPct = 20; stressRentPct = 10;
  if (ltChartInst) { ltChartInst.destroy(); ltChartInst = null; }
  delete document.documentElement.dataset.verdict;
  try { history.replaceState(null, '', window.location.pathname); } catch (_) {}
  showScreen('opening');
  resetOpeningEntrance();
  renderHomeRecent();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => runOpeningEntrance(true));
  });
}

function showScreen(id) {
  hideCFT();
  dismissAllModalOverlays();
  stopLandingDemoRotator();
  ['opening', 'wizard'].forEach(s => {
    const el = $(s);
    if (el) { el.classList.remove('active'); el.style.display = 'none'; }
  });
  const res = $('results');
  if (res) { res.classList.remove('active'); res.style.display = 'none'; }

  document.documentElement.classList.toggle('rv-results-active', id === 'results');

  if (id === 'results') {
    res.style.display = 'block';
    requestAnimationFrame(() => requestAnimationFrame(() => res.classList.add('active')));
    window.scrollTo({ top: 0, behavior: 'instant' });
  } else {
    const el = $(id);
    if (el) { el.style.display = 'flex'; requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('active'))); }
    if (id === 'opening') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { try { initLandingDemoRotator(); } catch (_) {} });
      });
    }
  }
}

function startWizard() {
  stopLandingDemoRotator();
  S.step = 0; stepDir = 1;
  const op = $('opening');
  if (op && op.classList.contains('active')) {
    op.classList.add('leaving');
    setTimeout(() => { op.classList.remove('leaving'); renderStep(false); showScreen('wizard'); }, 240);
  } else {
    renderStep(false); showScreen('wizard');
  }
}

/* ── Progress ── */
function renderProg() {
  const n = LAST_WIZARD_STEP + 1;
  let h = '';
  for (let i = 0; i < n; i++) {
    if (i > 0) h += `<div class="pl${i <= S.step ? ' done' : ''}"></div>`;
    h += `<div class="pd${i === S.step ? ' active' : i < S.step ? ' done' : ''}"></div>`;
  }
  $('prog').innerHTML = h;
}

/* ── Tooltip ── */
function tip(id, text) {
  return `<span class="qw"><button type="button" class="qb" aria-label="Explain ${id}" onclick="showTip(event,'${id}')">?</button><div class="ttip" id="tip_${id}">${text}</div></span>`;
}
function showTip(e, id) {
  e.stopPropagation();
  const el = $(`tip_${id}`);
  if (!el) return;
  const was = el.classList.contains('show');
  document.querySelectorAll('.ttip').forEach(t => t.classList.remove('show'));
  if (was) return;
  const br = e.currentTarget.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  const tw = Math.min(320, W - 24);
  el.style.width = tw + 'px';
  let left = br.left - tw / 2 + 7;
  if (left < 8) left = 8;
  if (left + tw > W - 8) left = W - tw - 8;
  el.style.left = left + 'px';
  el.classList.add('show');
  requestAnimationFrame(() => {
    const eh = el.offsetHeight || 120;
    let top = br.bottom + 8;
    if (top + eh > H - 10) top = Math.max(8, br.top - eh - 8);
    el.style.top = top + 'px';
  });
  setTimeout(() => document.addEventListener('click', function h() {
    el.classList.remove('show'); document.removeEventListener('click', h);
  }), 40);
}

/* ── Step transitions ── */
function renderStep(animate = true) {
  renderProg();
  const wb = $('wb');
  if (animate && wb.children.length) {
    const outCls = stepDir > 0 ? 'sol' : 'sor';
    wb.classList.add(outCls);
    setTimeout(() => {
      wb.classList.remove(outCls);
      wb.innerHTML = buildStep();
      bindStep();
      wb.style.opacity = '0';
      wb.style.transform = stepDir > 0 ? 'translateX(26px)' : 'translateX(-26px)';
      requestAnimationFrame(() => {
        wb.style.transition = 'opacity .27s ease,transform .27s ease';
        wb.style.opacity = '1';
        wb.style.transform = 'none';
        setTimeout(() => wb.style.transition = '', 300);
      });
    }, 200);
  } else {
    wb.innerHTML = buildStep();
    bindStep();
  }
}

function buildStep() {
  if (S.step === 0) return step0();
  if (S.step === 1) return step1();
  return step2();
}
function nextStep() { stepDir = 1; S.step++; renderStep(); }
function prevStep() { stepDir = -1; S.step--; renderStep(); }

/* ══ STEP 0 — Property details + address (merged) ══ */
function dpColor(v) { return v >= 20 ? 'var(--accent)' : v >= 10 ? 'var(--yellow)' : v >= 5 ? 'var(--orange)' : 'var(--red)'; }
function rateColor(v) { return v <= 6.5 ? 'var(--accent)' : v <= 8.5 ? 'var(--yellow)' : 'var(--red)'; }

function step0() {
  const ps = S.price > 10000;
  const stateOpts = `<option value=""${!S.addr.state ? ' selected' : ''}>State</option>` +
    STATES.map(s => `<option value="${s}"${(S.addr && S.addr.state === s) ? ' selected' : ''}>${s}</option>`).join('');
  return `
  <div class="shint">Step 1 of 3</div>
  <div class="stitle">Property details</div>
  <div class="rf s" id="rf0">
    <div class="price-hero${ps ? ' sm' : ''}" id="ph">
      <div class="prow"><span class="psym">$</span><input type="text" id="pp" class="${ps ? 'sm' : ''}" placeholder="000,000" value="${S.price ? fmtN(S.price) : ''}" inputmode="numeric"></div>
      <div class="plabel">Purchase price</div>
    </div>
  </div>
  <div class="rf${ps ? ' s' : ''}" id="rf1">
    <div class="fl" style="margin-bottom:8px">Property type</div>
    <div class="ugrid" id="ugrid">${unitCards()}</div>
  </div>
  <div class="rf${ps ? ' s' : ''}" id="rf2">
    <div class="cardg">
      <div class="fl" style="margin-bottom:11px">Down payment</div>
      <div class="sv"><div class="v" id="dpV">${S.downPct}%</div><div class="vs" id="dpD">$${fmtN(S.price * S.downPct / 100)}</div></div>
      <div class="strk"><div class="strk-bg"></div><div class="strk-fill" id="dpFill"></div><input type="range" id="dpS" min="3" max="50" value="${S.downPct}" oninput="S.downPct=+this.value;syncDP()"></div>
    </div>
  </div>
  <div class="rf${ps ? ' s' : ''}" id="rf3">
    <div class="cardg">
      <div class="rate-ind-wrap">
        <div class="fl">Interest rate</div>
        <span id="rateInd" class="rate-ind" onclick="promptFredKey()" title="Click to set a free FRED API key for live rates">⚡ Get live rate</span>
      </div>
      <div class="sv"><div class="v" id="rtV">${S.rate.toFixed(2)}%</div><div class="vs">30-yr fixed</div></div>
      <div class="strk"><div class="strk-bg"></div><div class="strk-fill" id="rtFill"></div><input type="range" id="rtS" min="4" max="12" step="0.25" value="${S.rate}" oninput="S.rate=+this.value;syncRT()"></div>
    </div>
  </div>
  <div class="rf${ps ? ' s' : ''}" id="rf5">
    <details class="addr-opt" id="addrOptDetails">
      <summary class="addr-opt-sum">
        <span class="addr-opt-ico" aria-hidden="true">📍</span>
        <span class="addr-opt-txt">Add location <em>optional</em></span>
        <span class="addr-opt-sub">Refines tax hint &amp; PDF label — skip if you want</span>
      </summary>
      <div class="addr-card addr-card--compact">
        <div class="addr-grid">
          <input class="ainp addr-inp-full" id="aStreet" placeholder="Street" value="${S.addr.street}" autocomplete="street-address" oninput="S.addr.street=this.value">
          <input class="ainp" id="aCity" placeholder="City" value="${S.addr.city}" autocomplete="address-level2" oninput="S.addr.city=this.value">
          <select class="ainp" id="aState" oninput="S.addr.state=this.value">${stateOpts}</select>
          <input class="ainp addr-zip" id="aZip" placeholder="ZIP" value="${S.addr.zip}" autocomplete="postal-code" inputmode="numeric" oninput="S.addr.zip=this.value">
        </div>
      </div>
    </details>
  </div>
  <div class="rf${ps ? ' s' : ''}" id="rf4">
    <div id="step0Hint" style="display:none;text-align:center;font-size:.75rem;color:var(--red);margin-bottom:8px">Enter a purchase price to continue</div>
    <div class="navbtns">
      <button class="btn btn-p" onclick="tryStep0Continue()">Continue →</button>
    </div>
  </div>`;
}

function unitCards() {
  return [1, 2, 3, 4].map(u => `<div class="uc${S.units === u ? ' sel' : ''}" onclick="selUnit(${u})">
    <div class="ui">${['🏠', '🏘', '🏢', '🏬'][u - 1]}</div>
    <span>${['Single', 'Duplex', 'Triplex', 'Quad'][u - 1]}</span>
  </div>`).join('');
}

function selUnit(u) { S.units = u; S.rents = []; const g = $('ugrid'); if (g) g.innerHTML = unitCards(); }

function setFill(id, pct, color) {
  const el = $(id);
  if (!el) return;
  el.style.cssText = `width:${clamp(pct, 0, 100)}%;background:${color};position:absolute;left:0;height:5px;top:50%;transform:translateY(-50%);border-radius:5px;pointer-events:none;transition:none`;
}
function setThumb(id, color) {
  let st = document.getElementById('_ts_' + id);
  if (!st) { st = document.createElement('style'); st.id = '_ts_' + id; document.head.appendChild(st); }
  st.textContent = `#${id}::-webkit-slider-thumb{border-color:${color}!important}#${id}::-moz-range-thumb{border-color:${color}!important}`;
}
function syncDP() {
  const v = S.downPct, c = dpColor(v);
  setFill('dpFill', (v - 3) / 47 * 100, c); setThumb('dpS', c);
  const p = $('dpV'); if (p) p.textContent = v + '%';
  const d = $('dpD'); if (d) d.textContent = S.price ? '$' + fmtN(S.price * v / 100) : '-';
}
function syncRT() {
  const v = S.rate, c = rateColor(v);
  setFill('rtFill', (v - 4) / 8 * 100, c); setThumb('rtS', c);
  const rv = $('rtV'); if (rv) rv.textContent = v.toFixed(2) + '%';
}
function revealSeq(ids, gap) {
  ids.forEach((id, i) => setTimeout(() => { const el = $(id); if (el && !el.classList.contains('s')) el.classList.add('s'); }, i * gap));
}

function tryStep0Continue() {
  if (!S.price || S.price < 10000) {
    const h = $('step0Hint'); if (h) h.style.display = 'block'; return;
  }
  nextStep();
}

/* ══ STEP 1 — Income ══ */
const estRent = i => estimateUnitRent(S.price, i);

function grossColor(gmo) {
  const r = S.price ? (gmo * 12 / S.price * 100) : 0;
  return r >= 6 ? 'var(--accent)' : r >= 4 ? 'var(--yellow)' : 'var(--red)';
}
function grossLabel(gmo) {
  const r = S.price ? (gmo * 12 / S.price * 100) : 0;
  return r >= 6 ? 'Strong vs. price' : r >= 4.5 ? 'OK — confirm rents' : r >= 3 ? 'Thin' : 'Low';
}

function step1() {
  if (!S.rents.length || S.rents.length !== S.units) {
    S.rents = [];
    for (let i = 0; i < S.units; i++) S.rents.push(estRent(i));
  }
  const gross = S.rents.reduce((a, b) => a + b, 0);
  const gc = grossColor(gross);
  const isMo = S.period === 'mo';
  const multi = S.units > 1;
  let fields = '';
  for (let i = 0; i < S.units; i++) {
    const disp = isMo ? S.rents[i] : Math.round(S.rents[i] * 12);
    const rowLab = multi ? `Unit ${i + 1}` : 'Monthly rent';
    fields += `<div class="rentv2-row">
      <div class="rentv2-lab"><span class="rentv2-lab-txt">${rowLab}</span></div>
      <div class="rentv2-amt">
        <span class="rentv2-sym">$</span>
        <input type="number" class="rentv2-input is-auto" id="r_${i}" value="${disp}"
          step="${isMo ? 50 : 600}" min="0"
          oninput="updateRent(${i},this)" inputmode="numeric" aria-label="${rowLab}">
        <span class="rentv2-per">${isMo ? '/mo' : '/yr'}</span>
      </div>
    </div>`;
  }
  return `
  <div class="shint">Step 2 of 3</div>
  <div class="stitle">Expected rent</div>
  <div class="rentv2-card">
    <div class="rentv2-toolbar">
      <div class="ppill">
        <div class="ppo${S.period === 'mo' ? ' on' : ''}" onclick="setPeriod('mo')">Monthly</div>
        <div class="ppo${S.period === 'yr' ? ' on' : ''}" onclick="setPeriod('yr')">Annual</div>
      </div>
    </div>
    <div class="rentv2-rows">${fields}</div>
    <div class="rentv2-total">
      <div class="rentv2-total-l">
        <div class="rentv2-total-hd">Total gross rent</div>
        <div class="rentv2-total-hint" id="gSub" style="color:${gc}">${grossLabel(gross)}</div>
      </div>
      <div class="rentv2-total-r">
        <div class="rentv2-total-big" id="gNum" style="color:${gc}">$${fmtN(gross * 12)}<span class="rentv2-total-per">/yr</span></div>
        <div class="rentv2-meter"><div class="rentv2-meter-fill" id="mFill" style="width:${Math.min(100, gross / (2500 * S.units) * 100)}%;background:${gc}"></div></div>
      </div>
    </div>
  </div>
  <p class="autofill-note"><span class="autofill-dot"></span>Blue-highlighted values are auto-filled estimates — edit any to override.</p>
  <div id="rentWarn" class="rentv2-warn" style="display:none">
    <span>All rents are $0 — continue anyway?</span>
    <button onclick="this.parentElement.style.display='none'" aria-label="Dismiss">✕</button>
  </div>
  <div class="navbtns">
    <button class="btn btn-g" onclick="prevStep()">← Back</button>
    <button class="btn btn-p" onclick="tryStep1Continue()">Continue →</button>
  </div>`;
}

function setPeriod(p) {
  const isMo = S.period === 'mo', isNewMo = p === 'mo';
  if (isMo === isNewMo) return;
  S.period = p;
  for (let i = 0; i < S.units; i++) {
    const el = $(`r_${i}`); if (!el) continue;
    el.value = isNewMo ? Math.round(+el.value / 12) : Math.round(+el.value * 12);
  }
  renderStep(false);
}

function updateRent(i, el) {
  const val = typeof el === 'object' && el && 'value' in el ? el.value : el;
  if (typeof el === 'object' && el && el.classList) {
    el.classList.remove('is-auto'); el.classList.add('is-user');
  }
  S.rents[i] = S.period === 'mo' ? (+val || 0) : Math.round((+val || 0) / 12);
  const gross = S.rents.reduce((a, b) => a + b, 0);
  const gc = grossColor(gross);
  const gn = $('gNum'); if (gn) { gn.style.color = gc; gn.innerHTML = `$${fmtN(gross * 12)}<span class="rentv2-total-per">/yr</span>`; }
  const gs = $('gSub'); if (gs) { gs.style.color = gc; gs.textContent = grossLabel(gross); }
  const mf = $('mFill'); if (mf) { mf.style.width = Math.min(100, gross / (2500 * S.units) * 100) + '%'; mf.style.background = gc; }
}

function tryStep1Continue() {
  const allZero = S.rents.every(r => !r);
  if (allZero) { const w = $('rentWarn'); if (w && w.style.display === 'none') { w.style.display = 'flex'; return; } }
  nextStep();
}

/* ══ STEP 2 — Expenses ══ */
function autoFill() {
  if (!S.price) return;
  const ptr = getPropTaxRate();
  if (!S.taxes)       S.taxes       = Math.round(S.price * ptr / 12);
  if (!S.insurance)   S.insurance   = Math.round(S.price * RATES.INSURANCE / 12);
  if (!S.maintenance) S.maintenance = Math.round(S.price * RATES.MAINTENANCE / 12);
  const g = S.rents.reduce((a, b) => a + b, 0) || estRent(0) * S.units;
  if (!S.vacancy)   S.vacancy   = Math.round(g * RATES.VACANCY);
  if (!S.management) S.management = Math.round(g * RATES.MANAGEMENT);
}

function step2() {
  autoFill();
  const mort = calcMortgage();
  const isMo = S.period === 'mo';
  const f = v => isMo ? Math.round(v) : Math.round(v * 12);
  const tot = mort + S.taxes + S.insurance + S.maintenance + S.vacancy + S.management + S.otherExp;

  function mkLine(key, label) {
    const v = S[key] || 0, disp = f(v);
    return `<div class="cfl cfl-edit">
      <div class="cfl-label"><span class="cfl-lab-row">${label}</span></div>
      <div class="cfl-amt-editable">
        <input class="est-amt-input cfl-inp is-auto" type="number" id="ei_${key}"
          value="${disp}" min="0" step="${isMo ? 10 : 120}"
          oninput="updExpInp('${key}',this,${isMo})">
      </div>
    </div>`;
  }

  return `
  <div class="shint">Step 3 of 3</div>
  <div class="stitle">Expenses</div>
  <div class="receipt rcp-bill rcp-unified rcp-one-receipt">
    <div class="rcp-toolbar-ledger rcp-toolbar-min">
      <div class="ppill">
        <div class="ppo${S.period === 'mo' ? ' on' : ''}" onclick="setPeriodExp('mo')">Monthly</div>
        <div class="ppo${S.period === 'yr' ? ' on' : ''}" onclick="setPeriodExp('yr')">Annual</div>
      </div>
    </div>
    <div class="cf-stmt rcp-cf-block rcp-flow-unified">
      <div class="cfl cfl-mort cfl-mort-row">
        <div class="cfl-label">Mortgage P&amp;I</div>
        <div class="cfl-val cfl-val-mort cfl-amt-like" id="expMort">$${fmtN(f(mort))}</div>
      </div>
      ${mkLine('taxes', 'Property tax')}
      ${mkLine('insurance', 'Insurance')}
      ${mkLine('maintenance', 'Maintenance')}
      ${mkLine('vacancy', 'Vacancy')}
      ${mkLine('management', 'Management')}
      ${mkLine('otherExp', 'Other')}
    </div>
    <div class="rcp-total">
      <div>
        <div class="rcp-total-label">Total ${isMo ? 'monthly' : 'annual'}</div>
      </div>
      <div style="text-align:right">
        <div class="rcp-total-v" id="expTot">$${fmtN(f(tot))}</div>
        <div class="rcp-total-yr" id="expTotAlt">${isMo ? '$' + fmtN(Math.round(tot * 12)) + ' /yr' : '$' + fmtN(Math.round(tot)) + ' /mo'}</div>
      </div>
    </div>
  </div>
  <p class="autofill-note"><span class="autofill-dot"></span>Blue-highlighted values are auto-filled estimates — edit any to override.</p>
  <div class="navbtns" style="margin-top:8px">
    <button class="btn btn-g" onclick="prevStep()">← Back</button>
    <button class="btn btn-p" onclick="showResults()">See results →</button>
  </div>`;
}

function setPeriodExp(p) { S.period = p; renderStep(false); }

function updExpInp(key, el, isMo) {
  const val = typeof el === 'object' && el && 'value' in el ? el.value : el;
  S[key] = isMo ? (+val || 0) : Math.round((+val || 0) / 12);
  if (typeof el === 'object' && el && el.classList) { el.classList.remove('is-auto'); el.classList.add('is-user'); }
  syncExpTotal();
}

function syncExpTotal() {
  const mort = calcMortgage();
  const isMo = S.period === 'mo';
  const f = v => isMo ? Math.round(v) : Math.round(v * 12);
  const tot = mort + S.taxes + S.insurance + S.maintenance + S.vacancy + S.management + S.otherExp;
  const et = $('expTot'); if (et) et.textContent = '$' + fmtN(f(tot));
  const ea = $('expTotAlt'); if (ea) ea.textContent = isMo ? '$' + fmtN(Math.round(tot * 12)) + ' /yr' : '$' + fmtN(Math.round(tot)) + ' /mo';
  const mEl = $('expMort'); if (mEl) mEl.textContent = '$' + fmtN(f(mort));
  ['taxes', 'insurance', 'maintenance', 'vacancy', 'management', 'otherExp'].forEach(k => {
    const inp = $(`ei_${k}`); if (inp) inp.value = f(S[k] || 0);
  });
}

/* ── Bind ── */
function bindStep() {
  if (S.step === 0) {
    const ppEl = $('pp');
    if (ppEl) {
      ppEl.addEventListener('input', () => {
        let v = ppEl.value.replace(/[^0-9]/g, '');
        S.price = +v;
        ppEl.value = v ? fmtN(+v) : '';
        if (S.price > 50000) {
          const ph = $('ph'); if (ph && !ph.classList.contains('sm')) { ph.classList.add('sm'); ppEl.classList.add('sm'); }
          revealSeq(['rf1', 'rf2', 'rf3', 'rf5', 'rf4'], 120);
        }
        ppEl.classList.toggle('lg', ppEl.value.length > 9);
        const h = $('step0Hint'); if (h && S.price > 0) h.style.display = 'none';
        syncDP(); syncRT();
      });
    }
    syncDP(); syncRT();
    const dp = $('dpS'); if (dp) dp.addEventListener('input', () => { S.downPct = +dp.value; syncDP(); });
    const rs = $('rtS'); if (rs) rs.addEventListener('input', () => { S.rate = +rs.value; syncRT(); });

    // ZIP autofill
    const z = $('aZip');
    if (z) z.addEventListener('blur', () => { if (/^\d{5}$/.test(z.value.trim())) zipLookup(z.value.trim()); });
    const ad = $('addrOptDetails');
    if (ad && S.addr && (S.addr.street || S.addr.city || (S.addr.zip && String(S.addr.zip).trim()))) ad.open = true;

  } else if (S.step === 1) {
    for (let i = 0; i < S.units; i++) {
      const el = $(`r_${i}`); if (!el) continue;
      el.addEventListener('keydown', e => {
        const step = S.period === 'mo' ? 50 : 600;
        if (e.key === 'ArrowUp') { e.preventDefault(); el.value = +el.value + step; updateRent(i, el); }
        if (e.key === 'ArrowDown') { e.preventDefault(); el.value = Math.max(0, +el.value - step); updateRent(i, el); }
      });
    }
  }
}

/* ── ZIP lookup ── */
function zipLookup(zip) {
  fetch(`https://api.zippopotam.us/us/${zip}`)
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      if (!d) return;
      const st = d.places && d.places[0] && d.places[0]['state abbreviation'];
      const city = d.places && d.places[0] && d.places[0]['place name'];
      if (st && STATES.includes(st)) {
        const sel = $('aState'); if (sel) { sel.value = st; S.addr.state = st; }
        const ci = $('aCity'); if (ci && !ci.value && city) { ci.value = city; S.addr.city = city; }
      }
    }).catch(() => {});
}

/* ══════════════════════════════════════════════
   FINANCIAL CALCULATIONS — see js/math.js (pure) + thin wrappers
   ══════════════════════════════════════════════ */

function calcMortgage(price, downPct, rate) {
  return calcMortgagePure(price ?? S.price, downPct ?? S.downPct, rate ?? S.rate);
}

function sanitizeState(raw) {
  return sanitizeStatePure(raw);
}

function calcCore(ov = {}) {
  return calcCorePure(S, ov);
}

/* ── Verdict ── */
function verdictAndAdvice(R, mode) {
  const P = SCREENING_PRESETS[mode || screeningMode] || SCREENING_PRESETS.balanced;
  const { strong, good, border } = P.tiers;
  const { coc, capRate, cf, irr10, dscr, grm, ber, price } = R;
  let verdict, color, summary, bullets, action;

  if (coc >= strong.minCoc && capRate >= strong.minCap && dscr >= strong.minDscr) {
    verdict = 'Strong Buy'; color = 'var(--accent)';
    summary = 'On these inputs, the headline metrics line up with a strong buy on our default thresholds.';
    bullets = [
      `Cashflow: <span class="vadv-num">${cf >= 0 ? '+' : '-'}$${fmtN(Math.abs(cf))}/mo</span> — modeled net after P&amp;I and operating expenses`,
      `Cap rate: <span class="vadv-num">${capRate.toFixed(1)}%</span> — vs <span class="vadv-num">${strong.minCap}%</span> floor for “Strong” in this model`,
      `Debt coverage: <span class="vadv-num">${dscr.toFixed(2)}×</span> — vs <span class="vadv-num">${strong.minDscr}×</span> in this model`,
      `10-yr IRR (modeled): <span class="vadv-num">${irr10.toFixed(1)}%</span> — illustrative; not a forecast`,
    ];
    action = 'Next: confirm rents/comps, inspect the asset, and validate financing — this tool does not replace diligence.';
  } else if (coc >= good.minCoc && capRate >= good.minCap) {
    verdict = 'Good Deal'; color = 'var(--accent)';
    summary = 'Passes the “good” band on our default thresholds — worth a serious second look.';
    bullets = [
      `Cashflow: <span class="vadv-num">${cf >= 0 ? '+' : '-'}$${fmtN(Math.abs(cf))}/mo</span> — ${cf >= 0 ? 'positive in the model' : 'near breakeven'}`,
      `Cap rate: <span class="vadv-num">${capRate.toFixed(1)}%</span> — meets the <span class="vadv-num">${good.minCap}%</span> “good” threshold in this model`,
      `Debt coverage: <span class="vadv-num">${dscr.toFixed(2)}×</span> — ${dscr >= 1.1 ? 'reasonable cushion' : 'tight — stress-test below'}`,
      'Equity paydown and appreciation can help — if your assumptions hold',
    ];
    action = 'Verify market rent and capex; then decide if the return fits your goals.';
  } else if (coc >= border.minCoc && capRate >= border.minCap) {
    verdict = 'Borderline'; color = 'var(--yellow)';
    summary = 'Mixed signals — fine for a first pass, not enough to commit on numbers alone.';
    bullets = [
      `Cashflow: <span class="vadv-num">${cf >= 0 ? '+' : '-'}$${fmtN(Math.abs(cf))}/mo</span> — ${cf >= 0 ? 'thin' : 'negative in the model'}`,
      `Cap rate: <span class="vadv-num">${capRate.toFixed(1)}%</span> — below the <span class="vadv-num">${good.minCap}%</span> “good” threshold in this model`,
      grm > 15 ? `GRM: <span class="vadv-num">${grm.toFixed(1)}×</span> — high price per dollar of rent`
               : `CoC: <span class="vadv-num">${coc.toFixed(1)}%</span> — weak vs typical equity return targets`,
      `A <span class="vadv-num">$${fmtN(Math.round(price * .05))}</span> price change moves the picture — try the sliders`,
    ];
    action = 'Negotiate price or find rent upside before relying on this deal.';
  } else if (coc >= 0) {
    verdict = 'Weak Deal'; color = 'var(--yellow)';
    summary = 'The modeled returns look weak at this price and income.';
    bullets = [
      `Cashflow: <span class="vadv-num">${cf < 0 ? '-' : '+'}$${fmtN(Math.abs(cf))}/mo</span> — ${cf < 0 ? 'negative in the model' : 'barely positive'}`,
      `Cap rate: <span class="vadv-num">${capRate.toFixed(1)}%</span> — below the “borderline” band in this model`,
      `Debt coverage: <span class="vadv-num">${dscr.toFixed(2)}×</span> — ${dscr < 1.1 ? 'thin' : 'still not enough yield'}`,
      'Unless you have a specific value-add plan, the math is hard to defend',
    ];
    action = 'Needs a better price, higher rent, or lower costs — or pass.';
  } else {
    verdict = 'Pass'; color = 'var(--red)';
    summary = 'Negative cash-on-cash in the model — hard to justify at these inputs.';
    bullets = [
      `Cashflow: <span class="vadv-num">-$${fmtN(Math.abs(cf))}/mo</span> — <span class="vadv-num">$${fmtN(Math.abs(cf) * 12)}/yr</span> out of pocket at modeled expenses`,
      `Cap rate: <span class="vadv-num">${capRate.toFixed(1)}%</span>${capRate < 3 ? ' — very low vs typical targets' : ''}`,
      ber > 100 ? 'Modeled break-even occupancy is unrealistic — expenses dominate gross'
                : `Operating expenses eat <span class="vadv-num">${ber.toFixed(0)}%</span> of gross in the model`,
      'Numbers are only as good as your inputs — fix any bad assumptions and re-run',
    ];
    action = 'Pass unless you have a concrete value-add thesis the model does not capture.';
  }

  const advice = `${summary} ${bullets.map(b => b.replace(/<[^>]*>/g, '')).join('; ')}. ${action}`;
  const summaryHtml = `<p class="va-summary verdict-lede">${summary}</p>`;
  const detailHtml = `<ul class="va-bullets">${bullets.map(b => `<li>${b}</li>`).join('')}</ul><p class="va-action">${action}</p>`;
  const adviceHtml = summaryHtml + detailHtml;
  return { verdict, color, advice, adviceHtml, summaryHtml, detailHtml, screeningLabel: P.label };
}

function setScreeningMode(mode) {
  if (!SCREENING_PRESETS[mode]) return;
  screeningMode = mode;
  try { localStorage.setItem('rv_screening_v1', mode); } catch (_) {}
  const R = dashR || calcCore(liveOvWithApp());
  const { verdict, color, advice, adviceHtml, summaryHtml, detailHtml } = verdictAndAdvice(R);
  const cfC = R.cf >= 0 ? 'var(--accent)' : 'var(--red)';
  const rd = Math.min(RATE_SLIDER_MAX - R.rate, stressRateDelta);
  const stress = [
    { t: `Rates +${rd % 1 === 0 ? rd : rd.toFixed(2)}%`, type: 'rate', val: rd, cf: stressCF('rate', rd, R) },
    { t: `Vacancy ${stressVacPct}%`, type: 'vac', val: stressVacPct, cf: stressCF('vac', stressVacPct, R) },
    { t: `Rents −${stressRentPct}%`, type: 'rent', val: stressRentPct, cf: stressCF('rent', stressRentPct / 100, R) },
  ];
  const eq1 = equitySched(tf1, liveOvWithApp());
  encodeState();
  populateDash(R, true, cfC, stress, eq1, { verdict, color, advice, adviceHtml, summaryHtml, detailHtml });
  flashDashRecalc();
  whatIfLive();
}

/* ── Stress ── */
function stressSeverity(type, val) {
  if (type === 'rate')  { if (val <= 0.5) return ['Mild','var(--accent)']; if (val <= 1.5) return ['Moderate','var(--yellow)']; if (val <= 2.5) return ['Notable','var(--orange)']; return ['Severe','var(--red)']; }
  if (type === 'vac')   { if (val <= 8)   return ['Normal','var(--accent)']; if (val <= 15) return ['Elevated','var(--yellow)']; if (val <= 30) return ['High','var(--orange)']; return ['Extreme','var(--red)']; }
  if (type === 'rent')  { if (val <= 5)   return ['Minor','var(--accent)']; if (val <= 10) return ['Moderate','var(--yellow)']; if (val <= 20) return ['Significant','var(--orange)']; return ['Major','var(--red)']; }
  return ['—', 'var(--muted)'];
}

function stressCF(type, val, R) {
  const r = R || dashR || calcCore();
  if (type === 'rate') { const sr = Math.min(RATE_SLIDER_MAX, r.rate + val); const nm = calcMortgage(r.price, r.dp, sr); return r.gross - (r.totalExp - r.mort + nm); }
  if (type === 'vac')  return r.gross - r.totalExp - (r.gross * val / 100 - r.vac);
  if (type === 'rent') return r.gross * (1 - val) - r.totalExp;
  return 0;
}

/* ── Equity schedule ── */
function equitySched(yrs, ov = {}) {
  const price  = ov.price ?? S.price;
  const dp     = ov.dp    ?? S.downPct;
  const rate   = ov.rate  ?? S.rate;
  const appPct = ov.appreciation ?? S.appreciation ?? 3;
  const appM   = 1 + appPct / 100;
  const loan   = price * (1 - dp / 100);
  const mr     = rate / 100 / 12;
  const M      = calcMortgage(price, dp, rate);
  const g      = (ov.rents ?? S.rents).reduce((a, b) => a + b, 0) || estRent(0) * S.units;
  const mo     = ov.opExp != null ? ov.opExp
    : (S.taxes || 0) + (S.insurance || 0) + (S.maintenance || 0) + (S.vacancy || 0) + (S.management || 0) + (S.otherExp || 0);
  let bal = loan;
  const pts = [];
  const down0 = price * dp / 100;
  for (let yr = 0; yr <= yrs; yr++) {
    const appVal = price * Math.pow(appM, yr);
    const equity = appVal - bal;
    const cumCF  = (g - (mo + M)) * 12 * yr;
    const spxG   = down0 * Math.pow(SPX_ANNUAL, yr) - down0;
    pts.push({ yr, equity: Math.round(equity), profit: Math.round(equity - down0 + cumCF), cumCF: Math.round(cumCF), spxGain: Math.round(spxG), propValue: Math.round(appVal), down: Math.round(down0) });
    for (let m = 0; m < 12; m++) { const int = bal * mr; bal = Math.max(0, bal - (M - int)); }
  }
  return pts;
}

/* ── Count-up animation ── */
function countUp(el, target, dur, pre = '', suf = '') {
  if (!el) return;
  const s0 = performance.now();
  (function fr(now) {
    const p = Math.min(1, (now - s0) / dur);
    const val = Math.round(lerp(0, Math.abs(target), p));
    el.textContent = (target < 0 ? '-' : '') + pre + fmtN(val) + suf;
    if (p < 1) requestAnimationFrame(fr);
  })(performance.now());
}

/* ══════════════════════════════════════════════
   RESULTS DASHBOARD
   ══════════════════════════════════════════════ */
function showResults() {
  showScreen('results');
  autoFill();
  dashR = calcCore();
  renderDash(dashR, false);
  encodeState();
}

function encodeState() {
  try {
    const data = {
      price: S.price, units: S.units, downPct: S.downPct, rate: S.rate, rents: S.rents,
      taxes: S.taxes, insurance: S.insurance, maintenance: S.maintenance,
      vacancy: S.vacancy, management: S.management, otherExp: S.otherExp || 0,
      appreciation: S.appreciation ?? 3, addr: S.addr || {}, period: S.period || 'mo',
      stress: { d: stressRateDelta, v: stressVacPct, r: stressRentPct },
      screeningMode,
    };
    history.replaceState(null, '', window.location.pathname + '#' + btoa(JSON.stringify(data)));
  } catch (_) {}
}

function tryDecodeHash() {
  try {
    const hash = window.location.hash.slice(1);
    if (!hash) return false;
    const raw = JSON.parse(atob(hash));
    if (raw.screeningMode && SCREENING_PRESETS[raw.screeningMode]) screeningMode = raw.screeningMode;
    const safe = sanitizeState(raw);
    if (!safe) return false;
    Object.assign(S, safe);
    if (raw.stress && typeof raw.stress === 'object') {
      stressRateDelta = clamp(+raw.stress.d || 2, 0, 4);
      stressVacPct    = clamp(+raw.stress.v || 20, 0, 50);
      stressRentPct   = clamp(+raw.stress.r || 10, 0, 40);
    }
    return true;
  } catch (_) { return false; }
}

function addrStr() {
  const a = S.addr || {};
  const parts = [a.street, [a.city, a.state].filter(Boolean).join(', '), a.zip, a.country && a.country !== 'United States' ? a.country : ''].filter(Boolean);
  return parts.join(' · ') || null;
}

function addrStrDash() {
  const a = S.addr || {};
  const st = (a.state || '').toUpperCase();
  const hasStreet = !!(a.street && a.street.trim());
  const hasCity   = !!(a.city && a.city.trim());
  const hasZip    = !!(a.zip && a.zip.trim());
  const extCountry = a.country && a.country !== 'United States' ? a.country.trim() : '';
  if (!hasStreet && !hasCity && !hasZip && !extCountry) return null;
  const midBits = [];
  if (hasCity) midBits.push(a.city.trim());
  if (st && hasCity) midBits.push(st);
  const out = [hasStreet ? a.street.trim() : '', midBits.join(', '), hasZip ? a.zip.trim() : '', extCountry]
    .filter(Boolean).join(' · ').replace(/\s+/g, ' ').trim();
  if (!out || /^[A-Z]{2}$/i.test(out)) return null;
  const full = ADDR_STATE_FULL[st];
  if (full && out.toLowerCase() === full.toLowerCase()) return null;
  return out;
}

/* ── Render results dashboard ── */
function renderDash(R, isUpdate) {
  const { verdict, color, advice, adviceHtml, summaryHtml, detailHtml } = verdictAndAdvice(R);
  const cfC = R.cf >= 0 ? 'var(--accent)' : 'var(--red)';
  const appTip = S.appreciation ?? 3;
  const eq1 = equitySched(tf1);
  const rd = Math.min(RATE_SLIDER_MAX - R.rate, stressRateDelta);
  const stress = [
    { t: `Rates +${rd % 1 === 0 ? rd : rd.toFixed(2)}%`, type: 'rate', val: rd,              cf: stressCF('rate', rd, R) },
    { t: `Vacancy ${stressVacPct}%`,                       type: 'vac',  val: stressVacPct,   cf: stressCF('vac', stressVacPct, R) },
    { t: `Rents −${stressRentPct}%`,                       type: 'rent', val: stressRentPct,  cf: stressCF('rent', stressRentPct / 100, R) },
  ];
  const avgRent   = S.rents.length ? Math.round(S.rents.reduce((a, b) => a + b, 0) / S.rents.length) : estRent(0);
  const addr      = addrStrDash();
  const stAbbr    = (S.addr && S.addr.state) || '';
  const stFull    = ADDR_STATE_FULL[stAbbr] || (stAbbr ? stAbbr : 'U.S.');
  const unitLab   = S.units === 1 ? 'Single-family' : S.units + '-unit';
  const whatIfMax = Math.max(5000, Math.round(R.price * 0.15 / 2500) * 2500);

  if (!isUpdate) {
    $('results').innerHTML = `
    <div class="pdf-doc" id="pdfDoc"></div>
    <div class="rv-shell dash" id="dashRoot">

      <!-- ══════════════════════════════════════════════════════════════
           OVERVIEW — compact data-first hero band
           Everything a pro needs at a glance: verdict, CF, 6 key metrics
           ══════════════════════════════════════════════════════════════ -->
      <section class="rv-part rv-part--hero" id="rvPart1" aria-label="Results summary">
        <div class="rv-hero-glow" id="vHeroBg"></div>
        <div class="rv-hero-inner">

          <!-- Top bar: property context + quick actions -->
          <div class="rv-hero-top">
            <div class="rv-hero-kicker">${stFull} rental <span class="rv-hero-kicker-dot">·</span> ${getDataAsOf()}</div>
            <div class="rv-hero-nav-acts">
              <button class="act-btn" onclick="goBack()">Edit inputs</button>
              <button class="act-btn" onclick="goHome()">New</button>
              <button class="act-btn" onclick="saveAnalysisPrompt()">Save</button>
              <button class="act-btn pr" onclick="openPdf()">PDF</button>
            </div>
          </div>

          <!-- Identity: verdict pill · price · type + address -->
          <div class="rv-hero-ident">
            <span class="rv-hero-verdict-pill" id="vLabel" style="color:${color};border-color:${color}">${verdict}</span>
            <span class="rv-hero-price">$${fmtN(R.price)}</span>
            <span class="rv-hero-meta">${unitLab}${addr ? '<span class="rv-hero-dot">·</span>' + esc(addr) : ''}</span>
          </div>

          <!-- Main data zone: CF headline (left) + 6-metric grid (right) -->
          <div class="rv-hero-main">

            <div class="rv-hero-cf-zone">
              <div class="rv-hero-cf-num" id="dcCF" style="color:${cfC}">$0</div>
              <div class="rv-hero-cf-label">net / mo</div>
              <div class="rv-hero-cf-row">
                <span class="rv-hero-cf-row-l">Annual</span>
                <span class="rv-hero-cf-row-v" id="dcACF" style="color:${cfC}">—</span>
              </div>
              <div class="rv-hero-cf-row">
                <span class="rv-hero-cf-row-l">Break-even occ.</span>
                <span class="rv-hero-cf-row-v" id="heroBer">—</span>
              </div>
              <span id="kpiAnnCF" hidden>—</span>
            </div>

            <div class="rv-hero-metrics-zone">
              <div class="rv-hm-cell">
                <span class="rv-hm-l">Cap rate</span>
                <span class="rv-hm-v" id="kpiCapV">—</span>
              </div>
              <div class="rv-hm-cell">
                <span class="rv-hm-l">Cash-on-cash</span>
                <span class="rv-hm-v" id="kpiCocV">—</span>
              </div>
              <div class="rv-hm-cell">
                <span class="rv-hm-l">DSCR</span>
                <span class="rv-hm-v" id="dcDscr">—</span>
              </div>
              <div class="rv-hm-cell">
                <span class="rv-hm-l">10-yr IRR</span>
                <span class="rv-hm-v" id="dcIrr">—</span>
              </div>
              <div class="rv-hm-cell">
                <span class="rv-hm-l">NOI / yr</span>
                <span class="rv-hm-v" id="dcNoi">—</span>
              </div>
              <div class="rv-hm-cell">
                <span class="rv-hm-l">Equity × (10yr)</span>
                <span class="rv-hm-v" id="kpiEqMult">—</span>
              </div>
            </div>

          </div>

          <!-- Acquisition bar: thin secondary strip -->
          <div class="rv-hero-acq-bar">
            <div class="rv-acq-cell"><span class="rv-acq-l">Down payment</span><span class="rv-acq-v" id="kpiDown">—</span></div>
            <div class="rv-acq-cell"><span class="rv-acq-l">Loan</span><span class="rv-acq-v" id="kpiLoan">—</span></div>
            <div class="rv-acq-cell"><span class="rv-acq-l">LTV</span><span class="rv-acq-v" id="kpiLtv">—</span></div>
            <div class="rv-acq-cell"><span class="rv-acq-l">GRM</span><span class="rv-acq-v" id="kpiGrm">—</span></div>
          </div>

          <!-- One-line summary -->
          <div class="rv-hero-lede" id="vLede">${summaryHtml}</div>

        </div>
      </section>

      <!-- ══════════════════════════════════════════════════════════════
           ANALYSIS — income statement + deal variables, side by side
           Change any input and all metrics update live on the same screen
           ══════════════════════════════════════════════════════════════ -->
      <section class="rv-part rv-part--play" id="rvPart2" aria-label="Adjust the deal">
        <div class="rv-play-inner">
          <div class="rv-play-head">
            <h2 class="rv-play-title">Adjust the deal</h2>
            <p class="rv-play-sub">Change any number and all metrics update instantly — no page switching.</p>
          </div>
          <div class="rv-play-panels">

            <div class="rv-panel rv-panel--bkd">
              <div class="rv-panel-hd">Monthly income statement <span class="rv-panel-hd-sub">edit any line</span></div>
              <div class="rv-bkd">
                <div class="rv-bkd-row rv-bkd-row--income">
                  <span class="rv-bkd-lbl">Gross rent</span>
                  <div class="rv-bkd-val"><span class="rv-bkd-sign rv-bkd-sign--pos">+</span><span class="rv-bkd-pre">$</span><span class="rv-bkd-auto" id="bkd_gross">${fmtN(R.gross)}</span><span class="rv-bkd-per">/mo</span></div>
                </div>
                <div class="rv-bkd-sep"></div>
                <div class="rv-bkd-row">
                  <span class="rv-bkd-lbl">Mortgage P&amp;I</span>
                  <div class="rv-bkd-val"><span class="rv-bkd-sign rv-bkd-sign--neg">−</span><span class="rv-bkd-pre">$</span><span class="rv-bkd-auto" id="bkd_mort">${fmtN(Math.round(R.mort))}</span><span class="rv-bkd-per">/mo</span></div>
                </div>
                <div class="rv-bkd-row rv-bkd-row--edit">
                  <span class="rv-bkd-lbl">Property tax</span>
                  <div class="rv-bkd-val"><span class="rv-bkd-sign rv-bkd-sign--neg">−</span><span class="rv-bkd-pre">$</span><input type="number" class="rv-bkd-inp" id="de_tx" min="0" max="50000" step="50" value="${Math.round(R.tx)}" oninput="deLive()"><span class="rv-bkd-per">/mo</span></div>
                </div>
                <div class="rv-bkd-row rv-bkd-row--edit">
                  <span class="rv-bkd-lbl">Insurance</span>
                  <div class="rv-bkd-val"><span class="rv-bkd-sign rv-bkd-sign--neg">−</span><span class="rv-bkd-pre">$</span><input type="number" class="rv-bkd-inp" id="de_ins" min="0" max="10000" step="25" value="${Math.round(R.ins)}" oninput="deLive()"><span class="rv-bkd-per">/mo</span></div>
                </div>
                <div class="rv-bkd-row rv-bkd-row--edit">
                  <span class="rv-bkd-lbl">Maintenance</span>
                  <div class="rv-bkd-val"><span class="rv-bkd-sign rv-bkd-sign--neg">−</span><span class="rv-bkd-pre">$</span><input type="number" class="rv-bkd-inp" id="de_mnt" min="0" max="10000" step="25" value="${Math.round(R.mnt)}" oninput="deLive()"><span class="rv-bkd-per">/mo</span></div>
                </div>
                <div class="rv-bkd-row rv-bkd-row--edit">
                  <span class="rv-bkd-lbl">Vacancy</span>
                  <div class="rv-bkd-val"><span class="rv-bkd-sign rv-bkd-sign--neg">−</span><span class="rv-bkd-pre">$</span><input type="number" class="rv-bkd-inp" id="de_vac" min="0" max="10000" step="25" value="${Math.round(R.vac)}" oninput="deLive()"><span class="rv-bkd-per">/mo</span></div>
                </div>
                <div class="rv-bkd-row rv-bkd-row--edit">
                  <span class="rv-bkd-lbl">Management</span>
                  <div class="rv-bkd-val"><span class="rv-bkd-sign rv-bkd-sign--neg">−</span><span class="rv-bkd-pre">$</span><input type="number" class="rv-bkd-inp" id="de_mgmt" min="0" max="10000" step="25" value="${Math.round(R.mgmt)}" oninput="deLive()"><span class="rv-bkd-per">/mo</span></div>
                </div>
                <div class="rv-bkd-row rv-bkd-row--edit">
                  <span class="rv-bkd-lbl">Other</span>
                  <div class="rv-bkd-val"><span class="rv-bkd-sign rv-bkd-sign--neg">−</span><span class="rv-bkd-pre">$</span><input type="number" class="rv-bkd-inp" id="de_oth" min="0" max="10000" step="10" value="${Math.round(R.oth)}" oninput="deLive()"><span class="rv-bkd-per">/mo</span></div>
                </div>
                <div class="rv-bkd-sep rv-bkd-sep--total"></div>
                <div class="rv-bkd-row rv-bkd-row--total">
                  <span class="rv-bkd-lbl">Net cashflow</span>
                  <div class="rv-bkd-val rv-bkd-val--cf" style="color:${cfC}">
                    <span class="rv-bkd-sign" id="bkd_cf_sign" style="color:${cfC}">${R.cf >= 0 ? '+' : '−'}</span>
                    <span class="rv-bkd-pre" style="color:${cfC}">$</span>
                    <span id="bkd_cf_val" style="color:${cfC}">${fmtN(Math.abs(R.cf))}</span>
                    <span class="rv-bkd-per">/mo</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="rv-panel rv-panel--vars">
              <div class="rv-panel-hd">Deal variables</div>
              <div class="rv-adjs">
                <div class="rv-a">
                  <span class="rv-a-name">Purchase price</span>
                  <div class="rv-a-ctrl">
                    <button class="rv-a-btn" onclick="adjStep('de_p',-5000)" aria-label="Decrease">−</button>
                    <div class="rv-a-num"><span class="rv-a-pre">$</span><input type="number" class="rv-a-inp" id="de_p" min="10000" max="9999000" step="5000" value="${R.price}" oninput="deLive()"></div>
                    <button class="rv-a-btn" onclick="adjStep('de_p',5000)" aria-label="Increase">+</button>
                  </div>
                </div>
                <div class="rv-a">
                  <span class="rv-a-name">Rent / unit</span>
                  <div class="rv-a-ctrl">
                    <button class="rv-a-btn" onclick="adjStep('de_r',-50)" aria-label="Decrease">−</button>
                    <div class="rv-a-num"><span class="rv-a-pre">$</span><input type="number" class="rv-a-inp" id="de_r" min="200" max="50000" step="50" value="${avgRent}" oninput="deLive()"></div>
                    <button class="rv-a-btn" onclick="adjStep('de_r',50)" aria-label="Increase">+</button>
                  </div>
                </div>
                <div class="rv-a">
                  <span class="rv-a-name">Down payment</span>
                  <div class="rv-a-ctrl">
                    <button class="rv-a-btn" onclick="adjStep('de_d',-5)" aria-label="Decrease">−</button>
                    <div class="rv-a-num"><input type="number" class="rv-a-inp rv-a-inp--pct" id="de_d" min="3" max="100" step="1" value="${S.downPct}" oninput="deLive()"><span class="rv-a-suf">%</span></div>
                    <button class="rv-a-btn" onclick="adjStep('de_d',5)" aria-label="Increase">+</button>
                  </div>
                </div>
                <div class="rv-a">
                  <span class="rv-a-name">Interest rate</span>
                  <div class="rv-a-ctrl">
                    <button class="rv-a-btn" onclick="adjStep('de_rt',-0.25)" aria-label="Decrease">−</button>
                    <div class="rv-a-num"><input type="number" class="rv-a-inp rv-a-inp--pct" id="de_rt" min="1" max="20" step="0.25" value="${S.rate.toFixed(2)}" oninput="deLive()"><span class="rv-a-suf">%</span></div>
                    <button class="rv-a-btn" onclick="adjStep('de_rt',0.25)" aria-label="Increase">+</button>
                  </div>
                </div>
                <div class="rv-a">
                  <span class="rv-a-name">Vacancy rate</span>
                  <div class="rv-a-ctrl">
                    <button class="rv-a-btn" onclick="adjStep('de_vacpct',-1)" aria-label="Decrease">−</button>
                    <div class="rv-a-num"><input type="number" class="rv-a-inp rv-a-inp--pct" id="de_vacpct" min="0" max="50" step="1" value="${R.gross > 0 ? Math.round(R.vac / R.gross * 100) : 8}" oninput="deLive()"><span class="rv-a-suf">%</span></div>
                    <button class="rv-a-btn" onclick="adjStep('de_vacpct',1)" aria-label="Increase">+</button>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </section>

      <!-- ═══ CHAPTER 3: OUTLOOK — the plain-English verdict, recommendation, and 10-yr outlook ═══ -->
      <section class="rv-part rv-part--deep rv-part--outlook" id="rvPart3" aria-label="Recommendation">
        <div class="rv-deep-inner">
          <div class="rv-deep-head rv-anim" data-delay="1">
            <div class="rv-chapter-mark"><span class="rv-chapter-num">03</span><span class="rv-chapter-rule"></span><span class="rv-chapter-name">Outlook</span></div>
            <h2 class="rv-deep-title">The take</h2>
            <p class="rv-deep-sub">Plain-English recommendation — what this deal actually looks like, and what to do next.</p>
          </div>

          <div class="rv-outlook-grid">

            <div class="rv-outlook-main">
              <div class="rv-outlook-verdict">
                <span class="rv-outlook-pill" id="outlookVerdict" style="color:${color};border-color:${color}">${verdict}</span>
                <p class="rv-outlook-summary" id="outlookSummary"></p>
              </div>

              <div class="rv-outlook-section">
                <div class="rv-outlook-lab">Why this verdict</div>
                <div class="rv-outlook-bullets" id="outlookBullets"></div>
              </div>

              <div class="rv-outlook-section rv-outlook-section--action">
                <div class="rv-outlook-lab">Your next step</div>
                <p class="rv-outlook-action" id="outlookAction"></p>
              </div>
            </div>

            <div class="rv-outlook-side">
              <div class="rv-outlook-card">
                <div class="rv-kcard-hd">Risk snapshot</div>
                <div class="rv-outlook-risks">
                  <div class="rv-risk-row"><span class="rv-risk-lab">Rate <span class="rv-risk-s">+2%</span></span><span class="rv-risk-v" id="riskR">—</span></div>
                  <div class="rv-risk-row"><span class="rv-risk-lab">Vacancy <span class="rv-risk-s">20%</span></span><span class="rv-risk-v" id="riskV">—</span></div>
                  <div class="rv-risk-row"><span class="rv-risk-lab">Rent <span class="rv-risk-s">−10%</span></span><span class="rv-risk-v" id="riskP">—</span></div>
                </div>
                <p class="rv-outlook-footnote">Auto-calculated downside in each scenario.</p>
              </div>

              <div class="rv-outlook-card rv-outlook-card--chart">
                <div class="rv-outlook-card-top">
                  <div class="rv-kcard-hd">10-year outlook</div>
                  <label class="rv-assume rv-assume--compact"><input type="number" class="rv-assume-inp" id="de_app" min="-5" max="20" step="0.25" value="${appTip.toFixed(2)}" oninput="deLive()"><span class="rv-assume-suf">%/yr</span></label>
                </div>
                <div class="rv-chart-shell rv-chart-shell--mini"><canvas id="ltChart" class="chart-canvas" aria-label="Property vs S&P 500"></canvas></div>
                <div class="rv-lt-compare">
                  <div class="rv-lt-cel"><div class="rv-lt-cnl" id="cnL1">Property</div><div class="rv-lt-cnv" id="cnV1">—</div></div>
                  <div class="rv-lt-cel"><div class="rv-lt-cnl" id="cnL2">S&amp;P 500</div><div class="rv-lt-cnv" id="cnV2">—</div></div>
                </div>
                <p class="rv-lt-snap" id="ltEqSnap"></p>
                <ul class="lt-legend lt-legend--compact" id="eqChartLegend" hidden></ul>
                <div id="tfR1" hidden></div>
                <span id="stressG" hidden></span>
                <span id="advInner" hidden></span>
                <span id="stSd" hidden></span><span id="stSv" hidden></span><span id="stSr" hidden></span>
                <span id="stVd" hidden></span><span id="stVv" hidden></span><span id="stVr" hidden></span>
              </div>
            </div>

          </div>

          <p class="dash-footnote"><span class="dash-foot-muted">Educational model · projections only · not investment advice · ${getDataAsOf()}</span></p>
        </div>
      </section>

    </div>`;

    buildTF('tfR1', tf1, v => {
      tf1 = v;
      const ov = liveOvWithApp();
      const eq = equitySched(v, ov);
      refreshLongTermPanel(eq, dashR || calcCore());
    });
    staggerIn();
    syncDashSliders(R, avgRent);

    // Part navigation + compact bar
    initHeroMorph();
    initPartEntrance();
    bindPartHintKeyboard();
  }

  setTimeout(() => populateDash(R, isUpdate, cfC, stress, eq1, { verdict, color, advice, adviceHtml, summaryHtml, detailHtml }), isUpdate ? 0 : 100);
}

/* ── Bar dual-position helper ── */
function setBarPosition(toBottom) {
  if (toBottom === barAtBottom) return;
  barAtBottom = toBottom;
  const bar = document.getElementById('rvCompactBar');
  if (!bar) return;
  const isVisible = bar.classList.contains('rv-cb--on');
  if (!isVisible) {
    bar.classList.toggle('rv-cb--at-bottom', toBottom);
    return;
  }
  // Cross-fade: hide → swap class → show
  bar.classList.add('rv-cb--switching');
  setTimeout(() => {
    bar.classList.toggle('rv-cb--at-bottom', toBottom);
    requestAnimationFrame(() => bar.classList.remove('rv-cb--switching'));
  }, 250);
}

/* ── Compact bar + side rail: always visible on results, track active chapter ── */
function initHeroMorph() {
  if (heroScrollCleanup) { heroScrollCleanup(); heroScrollCleanup = null; }

  const bar  = document.getElementById('rvCompactBar');
  const rail = document.getElementById('rvRail');
  if (!bar) return;

  // Bar is always on while results are shown — consistent position at the top.
  bar.classList.add('rv-cb--on');
  bar.classList.remove('rv-cb--at-bottom', 'rv-cb--switching');
  bar.setAttribute('aria-hidden', 'false');
  barAtBottom = false;
  if (rail) { rail.classList.add('rv-rail--on'); rail.setAttribute('aria-hidden', 'false'); }

  const parts = [1, 2, 3].map(n => document.getElementById('rvPart' + n)).filter(Boolean);
  const railSegs = rail ? rail.querySelectorAll('.rv-rail-seg') : [];
  const railFills = rail ? rail.querySelectorAll('.rv-rail-fill') : [];

  // ── Rail fill loop ──────────────────────────────────────────────────────────
  // Continuous rAF — only drives the thin fill bars. No CSS transition on the
  // fill element, so it tracks scroll 1:1 at 60fps with zero jitter.
  // Section entry animation is completely separate (fires after scroll settles).
  let rafId = 0;
  let lastScrollY = window.scrollY;

  const getActive = () => {
    const vc = window.innerHeight * 0.45;
    let active = 0;
    for (let i = 0; i < parts.length; i++) {
      const t = parts[i].getBoundingClientRect().top;
      if (t <= vc) active = i;
      else break;
    }
    return active;
  };

  const loop = () => {
    rafId = requestAnimationFrame(loop);
    const sy = window.scrollY;
    if (sy === lastScrollY && !loop._force) return;
    lastScrollY = sy;
    loop._force = false;
    if (!parts.length) return;
    const vc = window.innerHeight * 0.45;
    const active = getActive();
    parts.forEach((p, i) => {
      const r = p.getBoundingClientRect();
      let pct;
      if (i < active) pct = 1;
      else if (i > active) pct = 0;
      else pct = Math.min(1, Math.max(0, (vc - r.top) / Math.max(1, r.height)));
      if (railFills[i]) railFills[i].style.transform = `scaleY(${pct.toFixed(4)})`;
    });
    railSegs.forEach((b, i) => {
      b.classList.toggle('is-active', i === active);
      b.classList.toggle('is-done', i < active);
    });
  };
  const onResize = () => { loop._force = true; };
  window.addEventListener('resize', onResize, { passive: true });
  loop._force = true;
  loop();

  // ── Section entry animation ──────────────────────────────────────────────
  // Fires ONLY after the scroll fully settles — never mid-scroll.
  // Uses the native `scrollend` event (Chromium 114+, Firefox 109+) with a
  // debounced timeout as fallback for other browsers.
  let lastAnimated = -1;
  const onSettle = () => {
    const active = getActive();
    if (active === lastAnimated) return;
    lastAnimated = active;
    parts.forEach((p, i) => {
      p.classList.toggle('rv-active', i === active);
      if (i === active) {
        p.classList.remove('rv-entering');
        void p.offsetWidth;               // force reflow so animation restarts cleanly
        p.classList.add('rv-entering');
      }
    });
  };
  // scrollend fires after snap completes — perfect timing
  window.addEventListener('scrollend', onSettle, { passive: true });
  // Fallback: debounce for browsers without scrollend
  let scrollEndTimer;
  const onScrollFallback = () => { clearTimeout(scrollEndTimer); scrollEndTimer = setTimeout(onSettle, 200); };
  window.addEventListener('scroll', onScrollFallback, { passive: true });
  // Fire once on init so the first section animates in
  setTimeout(onSettle, 80);

  heroScrollCleanup = () => {
    cancelAnimationFrame(rafId);
    clearTimeout(scrollEndTimer);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scrollend', onSettle);
    window.removeEventListener('scroll', onScrollFallback);
    if (rail) { rail.classList.remove('rv-rail--on'); rail.setAttribute('aria-hidden', 'true'); }
  };
}

/* ── Part entrance animations ── */
function initPartEntrance() {
  const targets = document.querySelectorAll('.rv-part--play .rv-play-inner, .rv-part--deep .rv-deep-inner');
  if (!targets.length) return;
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('rv-entered'); obs.unobserve(e.target); } });
  }, { threshold: 0.08 });
  targets.forEach(t => obs.observe(t));
}

/** Enter / Space on scroll hints (role=button + tabindex=0). */
function bindPartHintKeyboard() {
  document.querySelectorAll('.rv-part-hint[role="button"][tabindex="0"]').forEach(el => {
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.click();
      }
    });
  });
}

/* ── Adjuster stepper ── */
function adjStep(id, delta) {
  const inp = $(id); if (!inp) return;
  const v = parseFloat(inp.value) || 0;
  const lo = parseFloat(inp.min), hi = parseFloat(inp.max);
  inp.value = parseFloat(Math.min(hi, Math.max(lo, v + delta)).toFixed(4));
  inp.dispatchEvent(new Event('input'));
}

/* ── Scroll to part ── */
function scrollToPart(n) {
  const part = document.getElementById('rvPart' + n);
  if (!part) return;
  // Bar is always on while results are shown, so offset by hdr (54) + bar (~56) = 110.
  const top = part.getBoundingClientRect().top + window.scrollY - 110;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function populateDash(R, isUpdate, cfC, stress, eq1, { verdict, color, advice, adviceHtml, summaryHtml, detailHtml }) {
  const dur = isUpdate ? 0 : 800;

  // Verdict + theme
  const vMap = { 'Strong Buy': 'strong', 'Good Deal': 'good', 'Borderline': 'borderline', 'Weak Deal': 'weak', 'Pass': 'walk' };
  const vKey = vMap[verdict] || 'neutral';
  document.documentElement.dataset.verdict = vKey;
  const dashRoot = document.getElementById('dashRoot');
  if (dashRoot) dashRoot.dataset.verdict = vKey;

  const vGlow = $('vHeroBg');
  if (vGlow) vGlow.style.background = `radial-gradient(ellipse 90% 55% at 50% 0%, color-mix(in srgb, ${color} 22%, transparent) 0%, transparent 72%)`;
  const vl = $('vLabel'); if (vl) { vl.textContent = verdict; vl.style.color = color; }
  const vLede = $('vLede');
  if (vLede && summaryHtml) vLede.innerHTML = summaryHtml;
  else if (vLede) vLede.innerHTML = `<p class="va-summary verdict-lede">${esc(advice.split('.')[0])}.</p>`;

  // Cashflow hero
  const dcCF = $('dcCF');
  if (dcCF) { dcCF.style.color = cfC; isUpdate ? (dcCF.textContent = (R.cf >= 0 ? '+$' : '-$') + fmtN(Math.abs(R.cf))) : countUp(dcCF, R.cf, dur, '$', ''); }
  const cfInd = $('cfFlowInd');
  if (cfInd) {
    const pos = R.cf >= 0;
    cfInd.className = 'cf-flow-indicator ' + (pos ? 'cf-flow-indicator--pos' : 'cf-flow-indicator--neg');
    cfInd.setAttribute('aria-label', pos ? 'Cashflow positive' : 'Cashflow negative');
  }
  const dcACF = $('dcACF');
  if (dcACF) { dcACF.style.color = cfC; dcACF.textContent = (R.annualCF >= 0 ? '+$' : '-$') + fmtN(Math.abs(Math.round(R.annualCF))) + '/yr'; }

  // Yield strip
  const kc = $('kpiCapV'); if (kc) { const c = clrFor(R.capRate, 5, 8); kc.style.color = c; kc.textContent = R.capRate.toFixed(1) + '%'; }
  const kcc = $('kpiCocV'); if (kcc) { const c = clrFor(R.coc, 5, 10); kcc.style.color = c; kcc.textContent = R.coc.toFixed(1) + '%'; }
  const dcNoi = $('dcNoi'); if (dcNoi) {
    dcNoi.textContent = '$' + fmtN(Math.round(R.noi));
    dcNoi.style.color = R.noi < 0 ? 'var(--red)' : clrFor(R.capRate, 5, 8);
  }
  const dcIrr = $('dcIrr'); if (dcIrr) { const c = clrFor(R.irr10, 8, 12); dcIrr.textContent = R.irr10 > 0 ? R.irr10.toFixed(1) + '%' : '< 0%'; dcIrr.style.color = c; }
  const dcDscr = $('dcDscr'); if (dcDscr) { const c = R.dscr >= 1.25 ? 'var(--accent)' : R.dscr >= 1.0 ? 'var(--yellow)' : 'var(--red)'; dcDscr.textContent = R.dscr.toFixed(2) + '×'; dcDscr.style.color = c; }

  // Secondary hero metrics
  const kAnnCF = $('kpiAnnCF');
  if (kAnnCF) { kAnnCF.textContent = (R.annualCF >= 0 ? '+' : '-') + '$' + fmtN(Math.abs(Math.round(R.annualCF))) + '/yr'; kAnnCF.style.color = cfC; }
  const kDown = $('kpiDown');
  if (kDown) kDown.textContent = '$' + fmtN(Math.round(R.down));
  const kLoan = $('kpiLoan');
  if (kLoan) kLoan.textContent = fmtK(R.loan);
  const kEqMult = $('kpiEqMult');
  if (kEqMult) { kEqMult.textContent = R.eqMult > 0 ? R.eqMult.toFixed(2) + '×' : '—'; kEqMult.style.color = R.eqMult >= 2 ? 'var(--accent)' : R.eqMult >= 1 ? 'var(--yellow)' : 'var(--red)'; }

  // KPI strip extended
  const kGrm = $('kpiGrm');
  if (kGrm) { kGrm.textContent = R.grm.toFixed(1) + '×'; kGrm.style.color = R.grm <= 10 ? 'var(--accent)' : R.grm <= 15 ? 'var(--yellow)' : 'var(--red)'; }
  const kLtv = $('kpiLtv');
  if (kLtv) { kLtv.textContent = R.ltv.toFixed(1) + '%'; kLtv.style.color = R.ltv <= 75 ? 'var(--accent)' : R.ltv <= 85 ? 'var(--yellow)' : 'var(--red)'; }

  // Income statement
  const cfStmt = $('cfStmt');
  if (cfStmt) {
    const g = R.gross || 1;
    const mortW = Math.min(100, R.mort / g * 100).toFixed(1);
    const opW   = Math.min(100 - parseFloat(mortW), (R.opExp || 0) / g * 100).toFixed(1);
    const netW  = Math.max(0, 100 - parseFloat(mortW) - parseFloat(opW)).toFixed(1);
    const bar = `<div class="income-bar" title="Mortgage ${mortW}% · Op. expenses ${opW}% · Net ${netW}%">
      <div class="income-bar-seg income-bar-mort" style="width:${mortW}%"></div>
      <div class="income-bar-seg income-bar-opex" style="width:${opW}%"></div>
      <div class="income-bar-seg income-bar-net" style="width:${netW}%;background:${cfC};opacity:${R.cf >= 0 ? .85 : .5}"></div>
    </div>`;
    const lines = [
      { label: 'Gross rent income', val: R.gross,  sign: '+', color: 'var(--accent)' },
      { label: 'Mortgage P&I',      val: R.mort,   sign: '−', color: 'var(--muted)' },
      { label: 'Property tax',       val: R.tx,     sign: '−', color: 'var(--muted)' },
      { label: 'Insurance',          val: R.ins,    sign: '−', color: 'var(--muted)' },
      { label: 'Maintenance',        val: R.mnt,    sign: '−', color: 'var(--muted)' },
      { label: 'Vacancy',            val: R.vac,    sign: '−', color: 'var(--muted)' },
      { label: 'Management',         val: R.mgmt,   sign: '−', color: 'var(--muted)' },
      ...(R.oth > 0 ? [{ label: 'Other', val: R.oth, sign: '−', color: 'var(--muted)' }] : []),
    ].filter(x => x.val > 0);
    cfStmt.innerHTML = bar
      + lines.map(x => `<div class="cfl"><div class="cfl-label">${x.label}</div><div class="cfl-val" style="color:${x.color}">${x.sign} $${fmtN(x.val)}/mo</div></div>`).join('')
      + `<div class="cfl total"><div class="cfl-label">Net cashflow</div><div class="cfl-val" style="color:${cfC}">${R.cf >= 0 ? '+' : '-'} $${fmtN(Math.abs(R.cf))}/mo</div></div>`;
  }

  // Stress grid (hidden legacy element — still referenced for calc propagation)
  const sg = $('stressG');
  if (sg) sg.innerHTML = stress.map(s => {
    const c = s.cf >= 0 ? 'var(--accent)' : s.cf > -150 ? 'var(--yellow)' : 'var(--red)';
    const [sevLabel, sevColor] = s.type ? stressSeverity(s.type, s.val) : ['—', 'var(--muted)'];
    return `<div class="sc"><div class="st">${s.t}</div><div class="sn" style="color:${c}">${s.cf >= 0 ? '+' : '-'}$${fmtN(Math.abs(s.cf))}/mo</div><span class="stress-sev" style="color:${sevColor}">${sevLabel}</span><div class="si" style="background:${c}"></div></div>`;
  }).join('');

  // Risk snapshot (Outlook section): auto-calculated downside under 3 fixed scenarios
  const fixedRiskCF = {
    rate:  stressCF('rate', Math.min(RATE_SLIDER_MAX - R.rate, 2), R),
    vac:   stressCF('vac', 20, R),
    rent:  stressCF('rent', 0.10, R),
  };
  const riskColor = v => v >= 0 ? 'var(--accent)' : v > -150 ? 'var(--yellow)' : 'var(--red)';
  const rFmt = v => (v >= 0 ? '+$' : '−$') + fmtN(Math.abs(Math.round(v))) + '/mo';
  const riskR = $('riskR'); if (riskR) { riskR.textContent = rFmt(fixedRiskCF.rate); riskR.style.color = riskColor(fixedRiskCF.rate); }
  const riskV = $('riskV'); if (riskV) { riskV.textContent = rFmt(fixedRiskCF.vac);  riskV.style.color = riskColor(fixedRiskCF.vac);  }
  const riskP = $('riskP'); if (riskP) { riskP.textContent = rFmt(fixedRiskCF.rent); riskP.style.color = riskColor(fixedRiskCF.rent); }

  // Outlook narrative: plain-English verdict, why, and action
  const outV = $('outlookVerdict'); if (outV) { outV.textContent = verdict; outV.style.color = color; outV.style.borderColor = color; }
  const outS = $('outlookSummary'); if (outS && summaryHtml) outS.innerHTML = summaryHtml.replace(/<p[^>]*>|<\/p>/g, '');
  const outB = $('outlookBullets'); if (outB && detailHtml) {
    const m = detailHtml.match(/<ul[^>]*>[\s\S]*?<\/ul>/);
    outB.innerHTML = m ? m[0] : '';
  }
  const outA = $('outlookAction'); if (outA && detailHtml) {
    const m = detailHtml.match(/<p class="va-action"[^>]*>([\s\S]*?)<\/p>/);
    outA.innerHTML = m ? m[1] : '';
  }

  // Break-even in hero
  const bEl = $('heroBer');
  if (bEl) {
    const pct = Math.round(R.ber || 0);
    bEl.textContent = pct + '% occ.';
    bEl.style.color = pct <= 80 ? 'var(--accent)' : pct <= 95 ? 'var(--yellow)' : 'var(--red)';
  }

  // Chart
  setTimeout(() => refreshLongTermPanel(eq1, R), isUpdate ? 10 : 200);

  // Advanced (always visible now)
  populateAdv(R);

  // Sliders
  syncDashSliders(R, S.rents.length ? Math.round(S.rents.reduce((a, b) => a + b, 0) / S.rents.length) : estRent(0));

  // What-if — always visible
  whatIfLive();

  // Breakdown live values
  const bkdGross = $('bkd_gross'); if (bkdGross) bkdGross.textContent = fmtN(R.gross);
  const bkdMort  = $('bkd_mort');  if (bkdMort)  bkdMort.textContent  = fmtN(Math.round(R.mort));
  const bkdCfVal = $('bkd_cf_val'); if (bkdCfVal) { bkdCfVal.textContent = fmtN(Math.abs(R.cf)); bkdCfVal.style.color = cfC; }
  const bkdCfSign = $('bkd_cf_sign'); if (bkdCfSign) { bkdCfSign.textContent = R.cf >= 0 ? '+' : '−'; bkdCfSign.style.color = cfC; }

  // Compact hero bar
  updateCompactHero(R, verdict, color, cfC);
}

/* ── Dash sliders ── */
function syncDashSliders(R, avgRent) {
  const dp  = R.dp    ?? S.downPct;
  const rt  = R.rate  ?? S.rate;
  const ap  = R.appreciation ?? S.appreciation ?? 3;
  setFill('de_dF',   (dp - 3) / 47 * 100,   dpColor(dp));    setThumb('de_d',   dpColor(dp));
  setFill('de_rtF',  (rt - 4) / 8 * 100,    rateColor(rt));  setThumb('de_rt',  rateColor(rt));
  setFill('de_appF', (ap + 2) / 12 * 100,   'var(--accent)'); setThumb('de_app', 'var(--accent)');
  const pp = $('de_p');
  if (pp) { setFill('de_pF', (R.price - +pp.min) / (+pp.max - +pp.min) * 100, 'var(--accent)'); setThumb('de_p', 'var(--accent)'); }
  const pr = $('de_r');
  if (pr) { setFill('de_rF', (+pr.value - +pr.min) / (+pr.max - +pr.min) * 100, 'var(--accent)'); setThumb('de_r', 'var(--accent)'); }
  const av = $('de_appV'); if (av) av.textContent = ap.toFixed(2) + '%';

  syncStressFills();
}

function syncStressFills() {
  /* Stress controls now use stepper inputs, no fill bars to sync.
     setFill/setThumb both noop gracefully when elements are missing. */
}

function liveOvWithApp() {
  const pp = $('de_p'), pr = $('de_r'), pd = $('de_d'), prt = $('de_rt'), da = $('de_app');
  if (!pp) return {};
  const price = +pp.value, rent = +pr.value, dp = +pd.value, rate = +prt.value;
  const appreciation = da ? +da.value : (S.appreciation ?? 3);
  const rents = Array(S.units).fill(rent);
  const R = calcCore({ price, dp, rate, rents, appreciation });
  return { price, dp, rate, rents, opExp: R.opExp, appreciation };
}

function deLive() {
  const pp = $('de_p'), pr = $('de_r'), pd = $('de_d'), prt = $('de_rt'), da = $('de_app');
  if (!pp) return;
  const price = +pp.value, rent = +pr.value, dp = +pd.value, rate = +prt.value;
  const appreciation = da ? +da.value : 3;
  S.appreciation = appreciation;
  // Sync breakdown expense overrides into state
  const txE = $('de_tx'), insE = $('de_ins'), mntE = $('de_mnt');
  const vacE = $('de_vac'), mgmtE = $('de_mgmt'), othE = $('de_oth');
  if (txE)   S.taxes       = +txE.value;
  if (insE)  S.insurance   = +insE.value;
  if (mntE)  S.maintenance = +mntE.value;
  if (vacE)  S.vacancy     = +vacE.value;
  if (mgmtE) S.management  = +mgmtE.value;
  if (othE)  S.otherExp    = +othE.value;
  // Vacancy % control (deal variables panel) — overrides the dollar field and keeps it in sync
  const vacPctE = $('de_vacpct');
  if (vacPctE) {
    const grossRent = rent * S.units;
    S.vacancy = Math.round(grossRent * (+vacPctE.value / 100));
    if (vacE) vacE.value = S.vacancy;
  }

  deLiveDebounce(() => {
    const rents = Array(S.units).fill(rent);
    dashR = calcCore({ price, dp, rate, rents, appreciation });
    liveOv = liveOvWithApp();
    const { verdict, color, advice, adviceHtml, summaryHtml, detailHtml } = verdictAndAdvice(dashR);
    const cfC = dashR.cf >= 0 ? 'var(--accent)' : 'var(--red)';
    const eq1 = equitySched(tf1, liveOv);
    const rd = Math.min(RATE_SLIDER_MAX - dashR.rate, stressRateDelta);
    const stress = [
      { t: `Rates +${rd % 1 === 0 ? rd : rd.toFixed(2)}%`, type: 'rate', val: rd,            cf: stressCF('rate', rd, dashR) },
      { t: `Vacancy ${stressVacPct}%`,                      type: 'vac',  val: stressVacPct,  cf: stressCF('vac', stressVacPct, dashR) },
      { t: `Rents −${stressRentPct}%`,                      type: 'rent', val: stressRentPct, cf: stressCF('rent', stressRentPct / 100, dashR) },
    ];
    encodeState();
    populateDash(dashR, true, cfC, stress, eq1, { verdict, color, advice, adviceHtml, summaryHtml, detailHtml });
    flashDashRecalc();
    whatIfLive();
  });
}

function stressLive() {
  const sd = $('stSd'), sv = $('stSv'), sr = $('stSr');
  if (sd) stressRateDelta = +sd.value;
  if (sv) stressVacPct   = +sv.value;
  if (sr) stressRentPct  = +sr.value;
  const vd = $('stVd'); if (vd) vd.textContent = '+' + stressRateDelta.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1') + '%';
  const vv = $('stVv'); if (vv) vv.textContent = stressVacPct + '%';
  const vr = $('stVr'); if (vr) vr.textContent = stressRentPct + '%';
  syncStressFills();
  const R = dashR || calcCore(liveOvWithApp());
  const rd = Math.min(RATE_SLIDER_MAX - R.rate, stressRateDelta);
  const stress = [
    { t: `Rates +${rd % 1 === 0 ? rd : rd.toFixed(2)}%`, type: 'rate', val: rd,             cf: stressCF('rate', rd, R) },
    { t: `Vacancy ${stressVacPct}%`,                      type: 'vac',  val: stressVacPct,  cf: stressCF('vac', stressVacPct, R) },
    { t: `Rents −${stressRentPct}%`,                      type: 'rent', val: stressRentPct, cf: stressCF('rent', stressRentPct / 100, R) },
  ];
  const cfC = R.cf >= 0 ? 'var(--accent)' : 'var(--red)';
  const eq1 = equitySched(tf1, liveOvWithApp());
  encodeState();
  populateDash(R, true, cfC, stress, eq1, verdictAndAdvice(R));
  flashDashRecalc();
  whatIfLive();
}

function whatIfLive() {
  const w = $('whatIfWrap'), sl = $('whatIfSl'), out = $('whatIfOut'), dv = $('whatIfDiscV');
  if (!w || !sl || !out || w.style.display === 'none') return;
  const disc = +sl.value || 0;
  const max  = +sl.max   || 1;
  if (dv) dv.textContent = '$' + fmtN(disc);
  setFill('whatIfFill', max ? disc / max * 100 : 0, 'var(--yellow)');
  setThumb('whatIfSl', 'var(--yellow)');
  const sc = liveOvWithApp(); if (!sc.price) return;
  const np = Math.max(0, sc.price - disc);
  const R2 = calcCore({ price: np, dp: sc.dp, rate: sc.rate, rents: sc.rents, appreciation: sc.appreciation });
  out.innerHTML = `At −$${fmtN(disc)}: <strong>${R2.cf >= 0 ? '+' : '−'}$${fmtN(Math.abs(R2.cf))}/mo</strong> cashflow · CoC ${R2.coc.toFixed(1)}% · Cap ${R2.capRate.toFixed(1)}% · 10-yr IRR ${Math.max(0, R2.irr10).toFixed(1)}% · DSCR ${R2.dscr.toFixed(2)}×`;
}

function flashDashRecalc() {
  const root = document.querySelector('.dash'); if (!root) return;
  root.classList.remove('dash--recalc'); void root.offsetWidth;
  root.classList.add('dash--recalc');
  clearTimeout(root._recalcT);
  root._recalcT = setTimeout(() => root.classList.remove('dash--recalc'), 720);
}

/* ── Advanced metrics (always visible) ── */
function populateAdv(R) {
  const ai = $('advInner'); if (!ai) return;
  const metrics = [
    { key: 'GRM',   name: 'Gross Rent Multiplier',    val: R.grm.toFixed(1),                 unit: '×', color: R.grm <= 10 ? 'var(--accent)' : R.grm <= 15 ? 'var(--yellow)' : 'var(--red)',
      desc: 'How many years of gross rent to pay off the purchase price. Lower = better — you\'re paying less per dollar of annual income.',
      verdict: R.grm <= 10 ? 'Strong — reasonable multiple for income.' : R.grm <= 15 ? 'Acceptable, but verify rent upside.' : 'High — you\'re paying a premium for income.',
      ranges: [{ c: 'var(--accent)', w: 2, label: '<10×' }, { c: 'var(--yellow)', w: 2, label: '10–15×' }, { c: 'var(--red)', w: 2, label: '15×+' }] },
    { key: 'DSCR',  name: 'Debt Service Coverage',    val: R.dscr.toFixed(2),                unit: '×', color: R.dscr >= 1.25 ? 'var(--accent)' : R.dscr >= 1.0 ? 'var(--yellow)' : 'var(--red)',
      desc: 'How comfortably income covers the mortgage. Lenders require 1.2–1.25× minimum. Below 1.0 = rent doesn\'t cover the debt.',
      verdict: R.dscr >= 1.25 ? `${R.dscr.toFixed(2)}× — comfortable. Lenders will approve this.` : R.dscr >= 1.0 ? `${R.dscr.toFixed(2)}× — borderline. Most lenders want 1.25 minimum.` : `${R.dscr.toFixed(2)}× — rent doesn't fully cover debt service.`,
      ranges: [{ c: 'var(--red)', w: 1, label: '<1.0' }, { c: 'var(--yellow)', w: 1, label: '1.0–1.25' }, { c: 'var(--accent)', w: 2, label: '1.25+' }] },
    { key: 'OER',   name: 'Operating Expense Ratio',  val: R.oer.toFixed(1),                 unit: '%', color: R.oer <= 40 ? 'var(--accent)' : R.oer <= 55 ? 'var(--yellow)' : 'var(--red)',
      desc: '% of gross income going to operating costs (ex-mortgage). Well-run properties run 35–45%.',
      verdict: R.oer <= 40 ? 'Lean — operating costs well-controlled.' : R.oer <= 55 ? 'Moderate — watch maintenance and management.' : 'High — more than half of income consumed before the mortgage.',
      ranges: [{ c: 'var(--accent)', w: 2, label: '<40%' }, { c: 'var(--yellow)', w: 2, label: '40–55%' }, { c: 'var(--red)', w: 2, label: '55%+' }] },
    { key: 'BER',   name: 'Break-even Occupancy',     val: R.ber.toFixed(1),                 unit: '%', color: R.ber <= 80 ? 'var(--accent)' : R.ber <= 92 ? 'var(--yellow)' : 'var(--red)',
      desc: 'Occupancy rate needed to cover all expenses including mortgage. Lower = more vacancy cushion.',
      verdict: R.ber <= 80 ? `You only need ${R.ber.toFixed(0)}% occupancy to break even — good cushion.` : R.ber <= 92 ? `${R.ber.toFixed(0)}% break-even — meaningful vacancy risk.` : `${R.ber.toFixed(0)}% break-even leaves almost no margin for error.`,
      ranges: [{ c: 'var(--accent)', w: 2, label: '<80%' }, { c: 'var(--yellow)', w: 2, label: '80–92%' }, { c: 'var(--red)', w: 2, label: '92%+' }] },
    { key: 'LTV',   name: 'Loan-to-Value',            val: R.ltv.toFixed(1),                 unit: '%', color: R.ltv <= 75 ? 'var(--accent)' : R.ltv <= 85 ? 'var(--yellow)' : 'var(--red)',
      desc: 'Loan as % of property value. Investment lenders typically cap at 75–80%.',
      verdict: R.ltv <= 75 ? `${R.ltv.toFixed(0)}% LTV — solid equity from day one.` : R.ltv <= 85 ? `${R.ltv.toFixed(0)}% LTV — manageable but limited cushion.` : `${R.ltv.toFixed(0)}% LTV — high. May require commercial lender or PMI.`,
      ranges: [{ c: 'var(--accent)', w: 2, label: '<75%' }, { c: 'var(--yellow)', w: 2, label: '75–85%' }, { c: 'var(--red)', w: 2, label: '85%+' }] },
    { key: 'IRR30', name: '30-Year Projected IRR',     val: Math.max(0, R.irr30).toFixed(1), unit: '%', color: clrFor(R.irr30, 8, 12),
      desc: `Annualized return if held 30 years at ${(R.appreciation ?? 3).toFixed(2)}%/yr appreciation, with cashflow and paydown.`,
      verdict: R.irr30 >= 12 ? `${R.irr30.toFixed(1)}% — strong long-term hold.` : R.irr30 >= 8 ? `${R.irr30.toFixed(1)}% — competitive with public markets.` : `${R.irr30.toFixed(1)}% — below S&P 500 historical average.`,
      ranges: [{ c: 'var(--red)', w: 2, label: '<8%' }, { c: 'var(--yellow)', w: 2, label: '8–12%' }, { c: 'var(--accent)', w: 2, label: '12%+' }] },
  ];

  ai.innerHTML = metrics.map(m => `
  <div class="rv-metric-card">
    <div class="rv-mc-top">
      <div class="rv-mc-left">
        <div class="rv-mc-key">${m.key}</div>
        <div class="rv-mc-name">${m.name}</div>
      </div>
      <div class="rv-mc-val" style="color:${m.color}">${m.val}<span class="rv-mc-unit">${m.unit}</span></div>
    </div>
    <div class="rv-mc-verdict" style="color:${m.color};background:color-mix(in srgb,${m.color} 9%,var(--card2))">${m.verdict}</div>
    <div class="rv-mc-bar">${m.ranges.map(r => `<div class="rv-mc-seg" style="background:${r.c};flex:${r.w}"></div>`).join('')}</div>
    <div class="rv-mc-bar-labels">${m.ranges.map(r => `<span>${r.label}</span>`).join('')}</div>
  </div>`).join('');
}

/* ══════════════════════════════════════════════
   CHART — Chart.js property vs S&P 500
   ══════════════════════════════════════════════ */
let ltChartInst = null;

function chartColors() {
  const dark = isDark();
  return {
    propC: dark ? '#22d46a' : '#0db050',
    spxC:  dark ? '#c9a227' : '#b45309',
    gridC: dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.07)',
    txtC:  dark ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.35)',
  };
}

function makeChartTooltip(eq) {
  return function ({ chart, tooltip }) {
    const cftEl = $('cft'); if (!cftEl) return;
    if (tooltip.opacity === 0) { hideCFT(); return; }
    const i = tooltip.dataIndex;
    if (i == null || !eq[i]) return;
    const pt = eq[i];
    const dark = isDark();
    const acC = dark ? '#22d46a' : '#0db050';
    const yyC = dark ? '#f0a000' : '#c47d00';
    const rdC = dark ? '#ff5050' : '#e02020';
    const rows = [
      { l: 'Property', v: (pt.profit >= 0 ? '+' : '−') + '$' + fmtN(Math.abs(pt.profit)), c: pt.profit >= 0 ? acC : rdC },
      { l: 'S&P 500',  v: '+$' + fmtN(pt.spxGain), c: yyC },
    ];
    const tipKey = 'cj-' + i;
    if (chart._tipKey !== tipKey) {
      chart._tipKey = tipKey;
      cftEl.innerHTML = `<div class="cft-fintech cft-fintech--compact"><div class="cft-yr">Year ${pt.yr}</div>${rows.map(r => `<div class="cft-row"><span class="cft-l">${r.l}</span><span class="cft-v" style="color:${r.c}">${r.v}</span></div>`).join('')}</div>`;
    }
    cftEl.style.display = 'block';
    requestAnimationFrame(() => {
      cftEl.classList.add('show');
      const pos = chart.canvas.getBoundingClientRect();
      const cx = tooltip.caretX, cy = tooltip.caretY;
      const vw = window.innerWidth, vh = window.innerHeight;
      const cw = cftEl.offsetWidth || 180, ch = cftEl.offsetHeight || 80;
      let tx = pos.left + cx - cw / 2, ty = pos.top + cy - ch - 14;
      if (ty < 8) ty = pos.top + cy + 14;
      if (tx < 8) tx = 8; if (tx + cw > vw - 8) tx = vw - cw - 8;
      if (ty + ch > vh - 8) ty = Math.max(8, vh - ch - 8);
      cftEl.style.left = tx + 'px'; cftEl.style.top = ty + 'px';
    });
  };
}

function findProfitBreakevenIdx(eq) {
  if (!eq || eq.length < 2 || eq[0].profit >= 0) return null;
  for (let i = 1; i < eq.length; i++) if (eq[i].profit >= 0) return i;
  return null;
}
function findCashRecoveryIdx(eq, down) {
  if (!eq || eq.length < 2 || !down || down <= 0) return null;
  for (let i = 1; i < eq.length; i++) if (eq[i].cumCF >= down) return i;
  return null;
}
function updateEqChartFoot(eq) {
  const leg = $('eqChartLegend'), snap = $('ltEqSnap');
  if (!eq || !eq.length) return;
  const lastYr = eq[eq.length - 1].yr;
  const down   = eq[0].down || 0;
  const pIdx   = findProfitBreakevenIdx(eq);
  const cIdx   = findCashRecoveryIdx(eq, down);
  if (snap) { const pt = eq[eq.length - 1]; snap.textContent = `~$${fmtN(pt.equity)} equity · ~$${fmtN(pt.propValue)} value`; }
  if (leg) {
    const items = [];
    if (eq[0].profit >= 0) items.push('<li><span class="cel-dot cel-profit"></span>Profitable from year 0</li>');
    else if (pIdx != null) items.push(`<li><span class="cel-dot cel-profit"></span>Profit break-even: year ${eq[pIdx].yr}</li>`);
    else items.push(`<li><span class="cel-dot cel-muted"></span>No profit break-even in ${lastYr} yr</li>`);
    if (down > 0) {
      if (cIdx != null) items.push(`<li><span class="cel-dot cel-cash"></span>Down payment recovered: year ${eq[cIdx].yr}</li>`);
      else items.push(`<li><span class="cel-dot cel-muted"></span>Down not recovered in ${lastYr} yr</li>`);
    }
    leg.innerHTML = items.join('');
  }
}

function drawUnifiedLongTermChart(eq, R) {
  const canvas = $('ltChart'); if (!canvas || !eq || eq.length < 2) return;
  const { propC, spxC, gridC, txtC } = chartColors();
  const labels   = eq.map(p => 'Y' + p.yr);
  const propData = eq.map(p => p.profit);
  const spxData  = eq.map(p => p.spxGain);

  const rvChartPlugin = {
    id: 'rvOverlay',
    afterDraw(chart) {
      const { ctx, scales: { x: xAxis, y: yAxis }, chartArea } = chart;
      const eq = chart._eq;
      if (!eq || !chartArea) return;
      const dark = isDark();
      ctx.save();

      // 1. Breakeven line
      const beIdx = findProfitBreakevenIdx(eq);
      if (beIdx != null && beIdx < eq.length) {
        const bx = xAxis.getPixelForIndex(beIdx);
        ctx.beginPath();
        ctx.moveTo(bx, chartArea.top);
        ctx.lineTo(bx, chartArea.bottom);
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = dark ? 'rgba(34,212,106,0.45)' : 'rgba(13,176,80,0.4)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        // Label
        ctx.font = "600 9px 'Inter',system-ui,sans-serif";
        ctx.fillStyle = dark ? 'rgba(34,212,106,0.85)' : 'rgba(13,176,80,0.9)';
        ctx.textAlign = 'center';
        ctx.fillText('Break-even', bx, chartArea.top - 6);
      }

      // 2. Hover crosshair
      const idx = chart._hoverIdx;
      if (idx == null || !chart.data.datasets.length) { ctx.restore(); return; }
      const hx = xAxis.getPixelForIndex(idx);
      // Vertical line
      ctx.beginPath();
      ctx.moveTo(hx, chartArea.top);
      ctx.lineTo(hx, chartArea.bottom);
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      // Dots at each dataset intersection
      chart.data.datasets.forEach((ds, di) => {
        if (idx >= ds.data.length) return;
        const val = ds.data[idx];
        if (val == null) return;
        const hy = yAxis.getPixelForValue(val);
        ctx.beginPath();
        ctx.arc(hx, hy, 4, 0, Math.PI * 2);
        ctx.fillStyle = ds.borderColor || '#fff';
        ctx.fill();
        ctx.strokeStyle = dark ? '#1a1a2a' : '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
      ctx.restore();
    }
  };

  if (ltChartInst) {
    ltChartInst._tipKey = null;
    ltChartInst._hoverIdx = null;
    ltChartInst.data.labels = labels;
    ltChartInst.data.datasets[0].data = propData;
    ltChartInst.data.datasets[0].borderColor = propC;
    ltChartInst.data.datasets[1].data = spxData;
    ltChartInst.data.datasets[1].borderColor = spxC;
    ltChartInst.options.scales.x.grid.color = gridC;
    ltChartInst.options.scales.y.grid.color = gridC;
    ltChartInst.options.scales.x.ticks.color = txtC;
    ltChartInst.options.scales.y.ticks.color = txtC;
    ltChartInst.options.plugins.tooltip.external = makeChartTooltip(eq);
    ltChartInst._eq = eq; ltChartInst._R = R;
    ltChartInst.update('none');
  } else {
    ltChartInst = new Chart(canvas, {
      type: 'line',
      plugins: [rvChartPlugin],
      data: {
        labels,
        datasets: [
          { label: 'Property', data: propData, borderColor: propC, backgroundColor: 'transparent', borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5, tension: 0 },
          { label: 'S&P 500',  data: spxData,  borderColor: spxC, backgroundColor: 'transparent', borderWidth: 2,   pointRadius: 0, pointHoverRadius: 5, borderDash: [6, 4], tension: 0 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 600, easing: 'easeInOutQuart' },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false, external: makeChartTooltip(eq) },
        },
        scales: {
          x: { grid: { color: gridC }, border: { display: false }, ticks: { color: txtC, font: { family: "'Inter',system-ui,sans-serif", size: 9, weight: '500' }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } },
          y: { grid: { color: gridC }, border: { display: false, dash: [4, 4] }, ticks: { color: txtC, font: { family: "'Inter',system-ui,sans-serif", size: 8, weight: '500' }, callback: v => fmtK(v), maxTicksLimit: 5 } },
        },
      },
    });
    ltChartInst._eq = eq; ltChartInst._R = R;

    canvas.addEventListener('mousemove', (e) => {
      if (!ltChartInst) return;
      const rect = canvas.getBoundingClientRect();
      const xScale = ltChartInst.scales.x;
      const relX = e.clientX - rect.left;
      // Find nearest index
      const dataCount = ltChartInst.data.labels.length;
      const idx = Math.round(Math.max(0, Math.min(dataCount - 1, (relX - xScale.left) / (xScale.right - xScale.left) * (dataCount - 1))));
      if (ltChartInst._hoverIdx !== idx) { ltChartInst._hoverIdx = idx; ltChartInst.draw(); }
    });
    canvas.addEventListener('mouseleave', () => {
      if (ltChartInst) { ltChartInst._hoverIdx = null; ltChartInst._tipKey = null; ltChartInst.draw(); hideCFT(); }
    });
  }
  updateEqChartFoot(eq);
}

function hideCFT() {
  const el = $('cft'); if (!el) return;
  el.classList.remove('show');
  setTimeout(() => { if (el && !el.classList.contains('show')) el.style.display = 'none'; }, 130);
}

function refreshLongTermPanel(eq, R) {
  if (!eq || !eq.length) return;
  drawUnifiedLongTermChart(eq, R || calcCore());
  updateSpxNums(eq);
}

function updateSpxNums(eq) {
  if (!eq) return;
  const last = eq[eq.length - 1], pw = last.profit > last.spxGain;
  const v1 = $('cnV1'); if (v1) { v1.textContent = (last.profit >= 0 ? '+' : '-') + '$' + fmtN(Math.abs(last.profit)); v1.style.color = pw ? 'var(--accent)' : 'var(--red)'; }
  const v2 = $('cnV2'); if (v2) { v2.textContent = '+$' + fmtN(last.spxGain); v2.style.color = !pw ? 'var(--accent)' : 'var(--text)'; }
}

function buildTF(rowId, active, cb) {
  const el = $(rowId); if (!el) return;
  [5, 10, 20, 30].forEach(y => {
    const btn = document.createElement('button');
    btn.className = 'tfb' + (y === active ? ' on' : '');
    btn.textContent = y + 'yr';
    btn.onclick = () => { el.querySelectorAll('.tfb').forEach(b => b.classList.remove('on')); btn.classList.add('on'); cb(y); };
    el.appendChild(btn);
  });
}

function redrawCharts() {
  if (!ltChartInst) return;
  const { propC, spxC, gridC, txtC } = chartColors();
  ltChartInst.data.datasets[0].borderColor = propC;
  ltChartInst.data.datasets[1].borderColor = spxC;
  ltChartInst.options.scales.x.grid.color = gridC;
  ltChartInst.options.scales.y.grid.color = gridC;
  ltChartInst.options.scales.x.ticks.color = txtC;
  ltChartInst.options.scales.y.ticks.color = txtC;
  ltChartInst.update('none');
  const ov = liveOvWithApp();
  const R  = dashR || calcCore();
  if (ov.price) { const eq = equitySched(tf1, ov); drawUnifiedLongTermChart(eq, R); updateSpxNums(eq); }
  else if (ltChartInst._eq) drawUnifiedLongTermChart(ltChartInst._eq, ltChartInst._R || R);
}

window.addEventListener('resize', () => { if (ltChartInst) ltChartInst.resize(); });

function staggerIn() {
  const hero = document.getElementById('rvPart1');
  if (!hero) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      hero.classList.add('rv-entered');
    });
  });
}

/* ══ PDF ══ */
function pdfScenarioR() {
  const sc = liveOvWithApp();
  if (sc && sc.price) return calcCore({ price: sc.price, dp: sc.dp, rate: sc.rate, rents: sc.rents, appreciation: sc.appreciation });
  return dashR || calcCore();
}

function saveAnalysisPrompt() {
  const def = (addrStr() || 'Property').slice(0, 60);
  const inp = $('saveNameInp'); if (inp) inp.value = def;
  openModal('saveModal');
  setTimeout(() => { if (inp) { inp.focus(); inp.select(); } }, 60);
}

function saveAnalysisConfirm() {
  const inp = $('saveNameInp');
  const name = (inp ? inp.value : '').trim();
  if (!name) { if (inp) inp.focus(); return; }
  closeModal('saveModal');
  const entry = { id: Date.now(), name, created: new Date().toISOString(), data: structuredClone(S), stress: { d: stressRateDelta, v: stressVacPct, r: stressRentPct } };
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (_) {}
  arr.unshift(entry);
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(arr.slice(0, 40))); } catch (_) {}
  refreshSavedList();
}

function loadSavedAnalysis(id) {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (_) {}
  const e = arr.find(x => x.id === id);
  if (!e || !e.data) return;
  const safe = sanitizeState(e.data);
  if (!safe) return;
  S = { ...structuredClone(DEF), ...safe };
  if (S.appreciation == null) S.appreciation = 3;
  if (e.stress) { stressRateDelta = clamp(+e.stress.d || 2, 0, 4); stressVacPct = clamp(+e.stress.v || 20, 0, 50); stressRentPct = clamp(+e.stress.r || 10, 0, 40); }
  else { stressRateDelta = 2; stressVacPct = 20; stressRentPct = 10; }
  liveOv = {};
  showResults();
}

function deleteSavedAnalysis(id) {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (_) {}
  arr = arr.filter(x => x.id !== id);
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(arr)); } catch (_) {}
  refreshSavedList();
}

function openPdf() {
  const addr = addrStr(); if (addr) { const p = $('pdfProp'); if (p) p.value = addr; }
  openModal('pdfModal');
}

function doPrint() {
  const name = ($('pdfProp') ? $('pdfProp').value.trim() : '') || addrStr() || 'Rental property analysis';
  const R = pdfScenarioR();
  const addr = addrStr();
  const app = R.appreciation ?? 3;
  const stAbbr = (S.addr && S.addr.state) || '';
  const pdfStateName = stAbbr ? (ADDR_STATE_FULL[stAbbr] || stAbbr) : 'rental';
  const cfSign = n => (n >= 0 ? '+$' : '-$') + fmtN(Math.abs(n));
  const cell = (a, b) => `<tr><td>${a}</td><td class="pdf-num">${b}</td></tr>`;

  $('pdfDoc').innerHTML = `
  <div class="pdf-branded">
    <div class="pdf-brand-hero">
      <div class="pdf-brand-row">
        <div class="pdf-brand-icon"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="2.2"><path d="M2 13V7l6-5 6 5v6H10V9H6v4Z"/></svg></div>
        <div>
          <div class="pdf-brand-name"><span class="pdf-r">Real</span>Verdict</div>
          <div class="pdf-brand-tag">${esc(pdfStateName)} rental analysis · ${getDataAsOf()}</div>
        </div>
      </div>
    </div>
    <div class="pdf-body-card">
    <div class="pdf-compact-title">${esc(name)}</div>
    ${addr ? `<div class="pdf-compact-sub">${esc(addr)}</div>` : ''}
    <table class="pdf-compact">
      <tr class="pdf-hrow"><td colspan="2">Assumptions &amp; financing</td></tr>
      ${cell('Purchase price', '$' + fmtN(R.price))}
      ${cell('Units', String(S.units))}
      ${cell('Down payment', `${R.dp}% ($${fmtN(R.down)})`)}
      ${cell('Loan @ rate', `$${fmtN(Math.round(R.loan))} @ ${R.rate}%`)}
      ${cell('Monthly P&I', '$' + fmtN(Math.round(R.mort)))}
      ${cell('Annual appreciation', app.toFixed(2) + '%/yr')}
      ${cell('Gross rent (mo)', '$' + fmtN(R.gross))}
      <tr class="pdf-hrow"><td colspan="2">Returns</td></tr>
      ${cell('Monthly cashflow', cfSign(R.cf) + '/mo')}
      ${cell('Annual cashflow',  cfSign(R.annualCF) + '/yr')}
      ${cell('Cap rate', R.capRate.toFixed(2) + '%')}
      ${cell('Cash-on-cash', R.coc.toFixed(2) + '%')}
      ${cell('NOI (annual)', '$' + fmtN(Math.round(R.noi)))}
      ${cell('10-yr IRR', Math.max(0, R.irr10).toFixed(1) + '%')}
      ${cell('30-yr IRR', Math.max(0, R.irr30).toFixed(1) + '%')}
      ${cell('Equity multiple (10 yr)', R.eqMult.toFixed(2) + '×')}
      <tr class="pdf-hrow"><td colspan="2">Risk / efficiency</td></tr>
      ${cell('DSCR', R.dscr.toFixed(2) + '×')}
      ${cell('LTV', R.ltv.toFixed(1) + '%')}
      ${cell('GRM', R.grm.toFixed(1) + '×')}
      ${cell('Break-even occupancy', R.ber.toFixed(1) + '%')}
      ${cell('Operating expense ratio', R.oer.toFixed(1) + '%')}
      <tr class="pdf-hrow"><td colspan="2">Monthly operating</td></tr>
      ${cell('Property tax', '−$' + fmtN(R.tx))}
      ${cell('Insurance',    '−$' + fmtN(R.ins))}
      ${cell('Maintenance',  '−$' + fmtN(R.mnt))}
      ${cell('Vacancy',      '−$' + fmtN(R.vac))}
      ${cell('Management',   '−$' + fmtN(R.mgmt))}
      ${R.oth > 0 ? cell('Other', '−$' + fmtN(R.oth)) : ''}
    </table>
    <div class="pdf-compact-foot">Educational model · projections from your inputs · not financial advice · ${new Date().toLocaleDateString('en-US')}</div>
    </div>
  </div>`;

  closeModal('pdfModal');
  setTimeout(window.print, 150);
}

function goBack() {
  document.documentElement.classList.remove('rv-results-active');
  if (heroScrollCleanup) { heroScrollCleanup(); heroScrollCleanup = null; }
  const bar = $('rvCompactBar'); if (bar) bar.classList.remove('rv-cb--on');
  barAtBottom = false; const bar2 = $('rvCompactBar'); if (bar2) bar2.classList.remove('rv-cb--at-bottom', 'rv-cb--switching');
  S.step = LAST_WIZARD_STEP;
  showScreen('wizard');
  renderStep(false);
}

/* ══ Compare ══ */
function calcCoreFromSaved(data) {
  const safe = sanitizeState(data);
  if (!safe) return calcCore();
  const snap = { ...structuredClone(DEF), ...safe };
  return calcCorePure(snap, {});
}

function openCompare() {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (_) {}
  if (arr.length < 2) { alert('Save at least 2 analyses first — use the Save button on any results page.'); return; }
  const s1 = $('cmpSel1'), s2 = $('cmpSel2');
  const opts = arr.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  if (s1) s1.innerHTML = opts;
  if (s2) { s2.innerHTML = opts; if (arr.length > 1) s2.value = String(arr[1].id); }
  $('cmpResult').innerHTML = '';
  openModal('compareModal');
  runCompare();
}

function runCompare() {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (_) {}
  const id1 = +($('cmpSel1') ? $('cmpSel1').value : 0);
  const id2 = +($('cmpSel2') ? $('cmpSel2').value : 0);
  const e1 = arr.find(x => x.id === id1), e2 = arr.find(x => x.id === id2);
  if (!e1 || !e2 || !e1.data || !e2.data) { $('cmpResult').innerHTML = ''; return; }
  const R1 = calcCoreFromSaved(e1.data), R2 = calcCoreFromSaved(e2.data);
  const v1 = verdictAndAdvice(R1), v2 = verdictAndAdvice(R2);
  const win = (a, b, hi = true) => hi ? (a > b ? 'win' : 'lose') : (a < b ? 'win' : 'lose');
  const rows = [
    { l: 'Verdict',     v1: v1.verdict,              v2: v2.verdict,              raw: null },
    { l: 'Price',       v1: '$' + fmtN(R1.price),    v2: '$' + fmtN(R2.price),   raw: [R1.price, R2.price],     hi: false },
    { l: 'Monthly CF',  v1: fmtC(R1.cf, true),       v2: fmtC(R2.cf, true),      raw: [R1.cf, R2.cf],           hi: true },
    { l: 'Cap Rate',    v1: R1.capRate.toFixed(1)+'%',v2: R2.capRate.toFixed(1)+'%',raw:[R1.capRate,R2.capRate], hi: true },
    { l: 'Cash on Cash',v1: R1.coc.toFixed(1)+'%',   v2: R2.coc.toFixed(1)+'%',  raw: [R1.coc, R2.coc],        hi: true },
    { l: 'DSCR',        v1: R1.dscr.toFixed(2)+'×',  v2: R2.dscr.toFixed(2)+'×', raw: [R1.dscr, R2.dscr],      hi: true },
    { l: '10-yr IRR',   v1: R1.irr10.toFixed(1)+'%', v2: R2.irr10.toFixed(1)+'%',raw: [R1.irr10, R2.irr10],    hi: true },
    { l: 'NOI/yr',      v1: '$' + fmtN(Math.round(R1.noi)), v2: '$' + fmtN(Math.round(R2.noi)), raw: [R1.noi, R2.noi], hi: true },
  ];
  const n1 = esc(e1.name), n2 = esc(e2.name);
  $('cmpResult').innerHTML = `<p class="cmp-screening-note">Verdicts use the same underwriting thresholds as the main analysis.</p><div class="cmp-table">
    <div class="cmp-th"><div></div><div title="${n1}">${n1}</div><div title="${n2}">${n2}</div></div>
    ${rows.map(r => {
      const c1 = r.raw ? ('cmp-rv ' + (r.raw[0] !== r.raw[1] ? win(r.raw[0], r.raw[1], r.hi) : '')) : 'cmp-rv';
      const c2 = r.raw ? ('cmp-rv ' + (r.raw[0] !== r.raw[1] ? win(r.raw[1], r.raw[0], r.hi) : '')) : 'cmp-rv';
      return `<div class="cmp-row"><div class="cmp-rl">${r.l}</div><div class="${c1}">${r.v1}</div><div class="${c2}">${r.v2}</div></div>`;
    }).join('')}
  </div>`;
}

/* ── Saved list ── */
function refreshSavedList() {
  const el = $('savedList'); if (!el) return;
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (_) {}
  if (!arr.length) { el.innerHTML = '<div class="saved-empty">No saved analyses yet. Use Save to store the current inputs.</div>'; return; }
  const cmpBtn = arr.length >= 2 ? `<button type="button" class="saved-load" onclick="openCompare()" style="background:var(--card2);color:var(--text);border:1px solid var(--border);padding:6px 10px;font-size:.66rem">⇄ Compare</button>` : '';
  el.innerHTML = `<div style="display:flex;justify-content:flex-end;padding:6px 14px 4px;border-bottom:1px solid var(--border)">${cmpBtn}</div>`
    + arr.map(e => `<div class="saved-item">
        <div class="saved-left"><div class="saved-name">${esc(e.name)}</div><div class="saved-meta">${new Date(e.created).toLocaleDateString()}</div></div>
        <div class="saved-btns">
          <button type="button" class="saved-load" data-id="${e.id}">Open</button>
          <button type="button" class="saved-del"  data-id="${e.id}">Delete</button>
        </div>
      </div>`).join('');
  el.querySelectorAll('.saved-load[data-id]').forEach(b => b.addEventListener('click', () => loadSavedAnalysis(+b.dataset.id)));
  el.querySelectorAll('.saved-del').forEach(b => b.addEventListener('click', () => deleteSavedAnalysis(+b.dataset.id)));
}



