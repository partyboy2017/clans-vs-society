/* ============================================================
   ui.js — Clans vs Society shared UI helpers
   Include after nav.js. Expects the canonical element IDs below
   to be present on the page (some are optional per-page).

   Toast:          #toast
   Log:             #log-list  (optional #log-placeholder entry)
   Health bar:      #hp-bar #hp-pct #hp-text
   Energy bar:      #en-bar #en-pct #en-text
   XP bar:          #xp-bar #xp-pct #xp-text   (optional)
   Status banners:  #jail-banner #jail-timer
                     #hospital-banner #hospital-timer
   Modal:           #modal-overlay #modal-icon #modal-title
                     #modal-sub #modal-stats
   ============================================================ */

/* ---------- Toast ---------- */
function showToast(msg, isLevelUp = false) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast' + (isLevelUp ? ' levelup-toast' : '');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

/* ---------- Activity log ---------- */
function addLog(html) {
  const list = document.getElementById('log-list');
  if (!list) return;
  const placeholder = document.getElementById('log-placeholder');
  if (placeholder) placeholder.closest('.log-entry')?.remove();

  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' +
               now.getMinutes().toString().padStart(2, '0');
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-text">${html}</span>`;
  list.insertBefore(entry, list.firstChild);
}

/* ---------- Resource bars (HP / Energy / XP) ---------- */
function updateResourceBars(stats) {
  const set = (barId, pctId, textId, val, max, textFn) => {
    const bar = document.getElementById(barId);
    const pct = document.getElementById(pctId);
    const text = document.getElementById(textId);
    if (!bar) return;
    const p = Math.max(0, Math.min(100, Math.round((val / max) * 100)));
    bar.style.width = p + '%';
    if (pct) pct.textContent = p + '%';
    if (text) text.textContent = textFn ? textFn() : `${val} / ${max}`;
  };

  set('hp-bar', 'hp-pct', 'hp-text', stats.health, stats.maxHealth);
  set('en-bar', 'en-pct', 'en-text', stats.energy, stats.maxEnergy);

  if (typeof stats.level === 'number') {
    const xpNeeded = stats.level * 100;
    set('xp-bar', 'xp-pct', 'xp-text', stats.xp, xpNeeded,
      () => `Level ${stats.level} — ${stats.xp}/${xpNeeded} XP`);
  }
}

/* ---------- Jail / hospital countdown banners ---------- */
let _statusTickInterval = null;
let _jailRemainingMs = 0;
let _hospitalRemainingMs = 0;

function formatMs(ms) {
  if (ms <= 0) return '0s';
  const s = Math.ceil(ms / 1000), m = Math.floor(s / 60), sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

// stats: { inJail, jailUntil, inHospital, hospitalUntil }
// onExpire: called once when either timer reaches 0 (e.g. to refetch status)
function updateStatusBanners(stats, onExpire) {
  const now = Date.now();
  const jailBanner = document.getElementById('jail-banner');
  const hospitalBanner = document.getElementById('hospital-banner');

  if (stats.inJail && stats.jailUntil && jailBanner) {
    jailBanner.classList.add('show');
    _jailRemainingMs = Math.max(0, new Date(stats.jailUntil).getTime() - now);
    document.getElementById('jail-timer').textContent = `Released in ${formatMs(_jailRemainingMs)}`;
  } else {
    jailBanner?.classList.remove('show');
    _jailRemainingMs = 0;
  }

  if (stats.inHospital && stats.hospitalUntil && hospitalBanner) {
    hospitalBanner.classList.add('show');
    _hospitalRemainingMs = Math.max(0, new Date(stats.hospitalUntil).getTime() - now);
    document.getElementById('hospital-timer').textContent = `Discharged in ${formatMs(_hospitalRemainingMs)}`;
  } else {
    hospitalBanner?.classList.remove('show');
    _hospitalRemainingMs = 0;
  }

  if (_statusTickInterval) clearInterval(_statusTickInterval);
  _statusTickInterval = setInterval(() => {
    if (_jailRemainingMs > 0) {
      _jailRemainingMs = Math.max(0, _jailRemainingMs - 1000);
      const el = document.getElementById('jail-timer');
      if (el) el.textContent = `Released in ${formatMs(_jailRemainingMs)}`;
      if (_jailRemainingMs === 0) onExpire?.();
    }
    if (_hospitalRemainingMs > 0) {
      _hospitalRemainingMs = Math.max(0, _hospitalRemainingMs - 1000);
      const el = document.getElementById('hospital-timer');
      if (el) el.textContent = `Discharged in ${formatMs(_hospitalRemainingMs)}`;
      if (_hospitalRemainingMs === 0) onExpire?.();
    }
  }, 1000);
}

/* ---------- Result modal (raid/monster outcome popups) ---------- */
// stats: [{ label, value, cls: 'pos'|'neg'|'' }]
function showModal(icon, title, sub, stats = []) {
  document.getElementById('modal-icon').textContent = icon;
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-sub').textContent = sub;
  document.getElementById('modal-stats').innerHTML = stats.map(s =>
    `<div class="modal-stat"><span class="label">${s.label}</span><span class="value ${s.cls || ''}">${s.value}</span></div>`
  ).join('');
  document.getElementById('modal-overlay').classList.add('show');
}

function closeModal() {
  document.getElementById('modal-overlay')?.classList.remove('show');
}

/* ---------- Small fetch helper (consistent error handling) ---------- */
async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data, status: res.status });
  return data;
}
