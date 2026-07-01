(function(){
  const path = window.location.pathname;

  const links = [
    {
      section: 'Realm',
      items: [
        { href: '/dashboard', label: 'Overview', icon: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>' },
        { href: '/training',  label: 'Training',  icon: '<path d="M12 21V9M12 9l-5-5M12 9l5-5M5 16h14" stroke-linecap="round" stroke-linejoin="round"/>' },
        { href: '/skills',    label: 'Skills',    icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" stroke-linecap="round"/>' },
        { href: '/raids',     label: 'Raids',     icon: '<path d="M4 12c2-5 6-8 8-8s6 3 8 8c-2 5-6 8-8 8s-6-3-8-8z" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.4"/>' },
      ]
    },
    {
      section: 'Social',
      items: [
        { href: '/house',     label: 'House',     soon: true, disabled: true, icon: '<path d="M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-0.5-8-4-8-9V7z" stroke-linecap="round" stroke-linejoin="round"/>' },
        { href: '/realm-map', label: 'Realm Map', soon: true, disabled: true, icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
        { href: '/market',    label: 'Market',    soon: true, disabled: true, icon: '<path d="M3 3h18v13H3z" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 21h8M12 17v4" stroke-linecap="round"/>' },
      ]
    }
  ];

  function buildNav(){
    const sidebar = document.getElementById('sidebar');
    if(!sidebar) return;

    let html = '';
    links.forEach((group, gi) => {
      if(gi > 0) html += '<div class="nav-divider"></div>';
      html += `<span class="nav-label">${group.section}</span>`;
      group.items.forEach(item => {
        const active = path === item.href ? ' active' : '';
        const badge = item.soon
          ? '<span style="font-family:JetBrains Mono,monospace;font-size:0.55rem;letter-spacing:0.08em;color:var(--rust-bright);margin-left:auto;padding:0.1rem 0.4rem;border:1px solid var(--rust);opacity:0.8;">SOON</span>'
          : '';

        if(item.disabled){
          html += `
            <span class="nav-item" style="opacity:0.35;cursor:not-allowed;pointer-events:none;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${item.icon}</svg>
              ${item.label}
              ${badge}
            </span>`;
        } else {
          html += `
            <a class="nav-item${active}" href="${item.href}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${item.icon}</svg>
              ${item.label}
              ${badge}
            </a>`;
        }
      });
    });

    sidebar.innerHTML = html;
  }

  function buildMobileNav(){
    const mobileNav = document.getElementById('mobile-nav');
    if(!mobileNav) return;

    // Flatten all items from all groups
    const allItems = links.flatMap(g => g.items);

    const items = allItems.map(item => {
      const active = path === item.href ? ' active' : '';
      const soonBadge = item.soon
        ? '<span style="font-family:JetBrains Mono,monospace;font-size:0.44rem;color:var(--rust-bright);display:block;letter-spacing:0.04em;">SOON</span>'
        : '';

      if(item.disabled){
        return `
          <span class="mn-item" style="opacity:0.32;cursor:not-allowed;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${item.icon}</svg>
            ${item.label}
            ${soonBadge}
          </span>`;
      }
      return `
        <a class="mn-item${active}" href="${item.href}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${item.icon}</svg>
          ${item.label}
        </a>`;
    }).join('');

    mobileNav.innerHTML = `<div class="mobile-nav-inner">${items}</div>`;
  }

  function init(){
    buildNav();
    buildMobileNav();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
