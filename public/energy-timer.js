/* ============================================================
   energy-timer.js — live energy regen countdowns
   Adds a line under the page's energy bar:
       "+5 in 3m 12s · Full in 41m 12s"   (or "Energy full")
   Works on any page with #en-bar (theme bars) or #energy-fill
   (training page). Self-contained: fetches /api/me itself.

   - Counts down every second from the server's timers.
   - When a tick lands, re-fetches /api/me, updates the energy bar
     text, and fires a `energy:update` event (detail = stats) so a
     page can refresh its own state (e.g. re-enable buttons).
   - Watches the energy text: when the page changes it (spending
     energy), re-syncs so the countdown starts right away.
   ============================================================ */
(function () {
  const BAR_IDS  = ['en-bar', 'energy-fill'];
  const TEXT_IDS = ['en-text', 'energy-val'];
  const PCT_IDS  = ['en-pct', 'en-val'];

  let nextAt = null;      // epoch ms of next tick
  let fullAt = null;      // epoch ms when energy will be full
  let amount = 5;
  let lastEnergy = null;  // last energy value we know/wrote
  let fetching = false;
  let el = null;

  function byFirstId(ids) {
    for (const id of ids) {
      const e = document.getElementById(id);
      if (e) return e;
    }
    return null;
  }

  function fmt(ms) {
    if (ms <= 0) return '0s';
    const s = Math.ceil(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
    return `${sec}s`;
  }

  function mount() {
    const bar = byFirstId(BAR_IDS);
    if (!bar) return false;
    el = document.createElement('div');
    el.className = 'energy-timer';
    el.setAttribute('aria-live', 'off');
    el.style.cssText = [
      "font-family:'JetBrains Mono',monospace",
      'font-size:0.62rem',
      'letter-spacing:0.08em',
      'color:var(--ash, #8a8478)',
      'margin-top:0.35rem',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
    ].join(';');

    // Theme pages: put it at the bottom of the resource card.
    const card = bar.closest('.resource-card');
    if (card) {
      card.appendChild(el);
    } else {
      // Training page: the bar is a flex row — place the timer just below it.
      const row = bar.closest('.energy-bar') || bar.parentElement;
      el.style.marginTop = '-1.2rem';
      el.style.marginBottom = '1.6rem';
      el.style.textAlign = 'right';
      row.insertAdjacentElement('afterend', el);
    }
    return true;
  }

  function render() {
    if (!el) return;
    if (nextAt === null) {
      el.textContent = lastEnergy === null ? '' : 'Energy full';
      return;
    }
    const now = Date.now();
    el.innerHTML =
      `<span style="color:var(--brass, #B08D45)">+${amount}</span> in ${fmt(nextAt - now)}` +
      ` &middot; Full in ${fmt(fullAt - now)}`;
  }

  function writeEnergy(stats) {
    const bar = byFirstId(BAR_IDS);
    const text = byFirstId(TEXT_IDS);
    const pct = byFirstId(PCT_IDS);
    const p = Math.max(0, Math.min(100, Math.round((stats.energy / stats.maxEnergy) * 100)));
    if (bar) bar.style.width = p + '%';
    if (text) text.textContent = `${stats.energy} / ${stats.maxEnergy}`;
    if (pct) pct.textContent = p + '%';
  }

  async function sync(fromTick) {
    if (fetching) return;
    fetching = true;
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const regen = data.energyRegen || {};
      const stats = data.stats;
      if (!stats) return;

      const now = Date.now();
      amount = regen.amount || amount;
      nextAt = regen.nextTickMs == null ? null : now + regen.nextTickMs;
      fullAt = regen.fullMs == null ? null : now + regen.fullMs;

      const changed = lastEnergy !== null && stats.energy !== lastEnergy;
      lastEnergy = stats.energy;

      if (fromTick || changed) {
        writeEnergy(stats);
        document.dispatchEvent(new CustomEvent('energy:update', { detail: stats }));
      }
      render();
    } catch (_) {
      /* network blip — next tick/visibility change will retry */
    } finally {
      fetching = false;
    }
  }

  // Re-sync when the page itself changes the energy number (spending energy).
  function watchText() {
    const text = byFirstId(TEXT_IDS);
    if (!text) return;
    let debounce = null;
    new MutationObserver(() => {
      const m = /^\s*(\d+)\s*\//.exec(text.textContent || '');
      if (!m) return;
      const shown = Number(m[1]);
      if (shown === lastEnergy) return; // our own write or no real change
      clearTimeout(debounce);
      debounce = setTimeout(() => sync(false), 400);
    }).observe(text, { childList: true, characterData: true, subtree: true });
  }

  function loop() {
    setInterval(() => {
      if (nextAt !== null && Date.now() >= nextAt) {
        nextAt = null; // avoid repeat fetches while waiting
        // Small delay so the server's interval has definitely elapsed.
        setTimeout(() => sync(true), 750);
      }
      render();
    }, 1000);

    // Catch up after the tab was in the background.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) sync(false);
    });
  }

  function start() {
    if (!mount()) return;
    watchText();
    sync(false);
    loop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
