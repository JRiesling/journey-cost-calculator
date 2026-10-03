/* FuelSmarter — shared journey bar
   Reads selections saved by each tool from localStorage, shows them in one bar,
   exports the whole route to the user's map app, and shows "Before you go" offers. */
(function () {
  var K = {
    route: 'fs_saved_route',
    fuel: 'fs_selected_fuel_station',
    svc: 'fs_selected_service_stations',
    park: 'fs_selected_parking'
  };

  // Affiliate links — swap these for Awin tracked links once approved
  var AFF = {
    justpark: function (q, lat, lng) {
      var u = 'https://www.justpark.com/search/?q=' + encodeURIComponent(q || '');
      if (lat && lng) u += '&coords=' + encodeURIComponent(lat + ',' + lng);
      return u;
    },
    aa: 'https://www.theaa.com/breakdown-cover',
    rac: 'https://www.rac.co.uk/breakdown-cover'
  };

  var path = location.pathname.replace(/\/$/, '') || '/';

  // ── Storage helpers ─────────────────────────────────────────────────────────
  function get(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function set(k, v) {
    try {
      if (v == null || (Array.isArray(v) && !v.length)) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {}
  }
  function state() {
    return { route: get(K.route, {}) || {}, fuel: get(K.fuel, null), svc: get(K.svc, []) || [], park: get(K.park, null) };
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dist(a, b) {
    var R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  function changed() { try { window.dispatchEvent(new Event('fsjourney:change')); } catch (e) {} }

  // ── Styles ──────────────────────────────────────────────────────────────────
  var css = '' +
    '#fs-jb{position:fixed;bottom:0;left:0;right:0;z-index:600;background:var(--card,#FDFCFA);border-top:2px solid var(--accent-border,#95C9A8);box-shadow:0 -4px 24px rgba(0,0,0,0.12);padding:10px 16px;display:none;font-family:var(--font,Inter,-apple-system,sans-serif);}' +
    '#fs-jb .in{max-width:1000px;margin:0 auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}' +
    '#fs-jb .lbl{font-size:11px;font-weight:700;color:var(--text-secondary,#6B6560);text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap;}' +
    '#fs-jb .chips{flex:1;min-width:0;display:flex;gap:6px;flex-wrap:wrap;align-items:center;}' +
    '#fs-jb .chip{font-size:12px;padding:4px 10px;border-radius:20px;font-weight:500;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;}' +
    '#fs-jb .chip.fuel{background:#FEF3C7;color:#78350F;border:1px solid #FDE68A;}' +
    '#fs-jb .chip.svc{background:var(--accent-light,#EAF4EE);color:var(--accent-text,#1A4731);border:1px solid var(--accent-border,#95C9A8);}' +
    '#fs-jb .chip.park{background:#e6f1fb;color:#0c447c;border:1px solid #b5d4f4;}' +
    '#fs-jb .chip .x{cursor:pointer;font-size:15px;line-height:1;margin-left:2px;opacity:0.6;}' +
    '#fs-jb .chip .x:hover{opacity:1;}' +
    '#fs-jb .add{font-size:12px;padding:4px 10px;border-radius:20px;border:1px dashed var(--border,rgba(0,0,0,0.2));color:var(--text-secondary,#6B6560);text-decoration:none;white-space:nowrap;}' +
    '#fs-jb .add:hover{border-color:var(--accent,#2D6A4F);color:var(--accent,#2D6A4F);}' +
    '#fs-jb .go{height:40px;padding:0 16px;background:#4285F4;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:6px;white-space:nowrap;flex-shrink:0;}' +
    '#fs-jb .go:hover{background:#3367D6;}' +
    'body.fs-jb-on{padding-bottom:84px;}' +
    '@media(max-width:600px){#fs-jb{padding:8px 10px;}#fs-jb .lbl{display:none;}#fs-jb .chip,#fs-jb .add{font-size:11px;padding:3px 8px;}#fs-jb .go{height:36px;padding:0 12px;font-size:12px;}body.fs-jb-on{padding-bottom:110px;}}' +
    '#fs-jm{position:fixed;inset:0;z-index:700;background:rgba(0,0,0,0.45);display:none;align-items:flex-end;justify-content:center;font-family:var(--font,Inter,-apple-system,sans-serif);}' +
    '#fs-jm.on{display:flex;}' +
    '@media(min-width:601px){#fs-jm{align-items:center;}}' +
    '#fs-jm .box{background:var(--card,#FDFCFA);color:var(--text,#1C1917);width:100%;max-width:440px;border-radius:16px 16px 0 0;padding:20px;max-height:90vh;overflow-y:auto;}' +
    '@media(min-width:601px){#fs-jm .box{border-radius:16px;}}' +
    '#fs-jm h3{font-size:18px;font-weight:800;margin:0 0 4px;}' +
    '#fs-jm .sub{font-size:13px;color:var(--text-secondary,#6B6560);margin:0 0 14px;}' +
    '#fs-jm .open{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:46px;background:#4285F4;color:#fff;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;}' +
    '#fs-jm .note{font-size:11px;color:var(--text-tertiary,#A8A29E);margin:8px 0 0;text-align:center;}' +
    '#fs-jm .byg{margin-top:18px;border-top:1px solid var(--border,rgba(0,0,0,0.08));padding-top:14px;}' +
    '#fs-jm .byg-t{font-size:11px;font-weight:700;color:var(--text-secondary,#6B6560);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;}' +
    '#fs-jm .offer{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border,rgba(0,0,0,0.08));border-radius:10px;margin-bottom:8px;text-decoration:none;color:var(--text,#1C1917);background:var(--bg,#F4F1EA);}' +
    '#fs-jm .offer:hover{border-color:var(--accent-border,#95C9A8);}' +
    '#fs-jm .offer b{display:block;font-size:13px;}' +
    '#fs-jm .offer span{font-size:12px;color:var(--text-secondary,#6B6560);}' +
    '#fs-jm .ico{font-size:20px;flex-shrink:0;}' +
    '#fs-jm .disc{font-size:10px;color:var(--text-tertiary,#A8A29E);margin-top:6px;}' +
    '#fs-jm .close{float:right;border:none;background:none;font-size:22px;line-height:1;cursor:pointer;color:var(--text-secondary,#6B6560);}';

  // ── Build DOM ───────────────────────────────────────────────────────────────
  function inject() {
    if (document.getElementById('fs-jb')) return;
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

    var bar = document.createElement('div');
    bar.id = 'fs-jb';
    bar.innerHTML = '<div class="in"><span class="lbl">Your journey</span><div class="chips" id="fs-jb-chips"></div>' +
      '<button class="go" id="fs-jb-go" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>Open in Maps</button></div>';
    document.body.appendChild(bar);

    var modal = document.createElement('div');
    modal.id = 'fs-jm';
    modal.innerHTML = '<div class="box" id="fs-jm-box"></div>';
    document.body.appendChild(modal);

    document.getElementById('fs-jb-go').addEventListener('click', openModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    document.getElementById('fs-jb-chips').addEventListener('click', function (e) {
      var x = e.target.closest('.x'); if (!x) return;
      var t = x.getAttribute('data-t'), i = parseInt(x.getAttribute('data-i'), 10);
      if (t === 'fuel') set(K.fuel, null);
      if (t === 'park') set(K.park, null);
      if (t === 'svc') { var s = get(K.svc, []) || []; s.splice(i, 1); set(K.svc, s); }
      render(); changed();
    });
  }

  // ── Render bar ──────────────────────────────────────────────────────────────
  function render() {
    inject();
    var s = state(), bar = document.getElementById('fs-jb');
    var has = !!(s.fuel || s.svc.length || s.park);
    if (!has) { bar.style.display = 'none'; document.body.classList.remove('fs-jb-on'); return; }

    var h = '';
    if (s.fuel) h += '<span class="chip fuel">⛽ ' + esc(s.fuel.name) + '<span class="x" data-t="fuel" title="Remove">×</span></span>';
    s.svc.forEach(function (v, i) { h += '<span class="chip svc">🛣️ ' + esc(v.name) + '<span class="x" data-t="svc" data-i="' + i + '" title="Remove">×</span></span>'; });
    if (s.park) h += '<span class="chip park">🅿️ ' + esc(s.park.name) + '<span class="x" data-t="park" title="Remove">×</span></span>';

    // Prompts for tools not yet used (hidden on the tool's own page)
    if (!s.fuel && path !== '/fuel-finder') h += '<a class="add" href="/fuel-finder">+ Fuel stop</a>';
    if (!s.svc.length && path !== '/service-station-planner') h += '<a class="add" href="/service-station-planner">+ Pit stops</a>';
    if (!s.park && path !== '/parking-finder') h += '<a class="add" href="/parking-finder">+ Parking</a>';

    document.getElementById('fs-jb-chips').innerHTML = h;
    bar.style.display = 'block';
    document.body.classList.add('fs-jb-on');
  }

  // ── Build map URL ───────────────────────────────────────────────────────────
  function buildUrl(s) {
    var origin = s.route.origin || '';
    var dest = s.route.destination || '';
    var finalDest = s.park && s.park.lat ? (s.park.lat + ',' + s.park.lng) : dest;
    if (!finalDest) return null;

    var stops = [];
    if (s.fuel && s.fuel.lat) stops.push({ lat: s.fuel.lat, lng: s.fuel.lng });
    s.svc.forEach(function (v) { if (v.lat) stops.push({ lat: v.lat, lng: v.lng }); });

    // Order stops: furthest from destination first (i.e. route order)
    var ref = s.park && s.park.lat ? { lat: s.park.lat, lng: s.park.lng } : s.route.destCoords;
    if (ref && stops.length > 1) stops.sort(function (a, b) { return dist(b, ref) - dist(a, ref); });

    var url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(finalDest);
    if (origin) url += '&origin=' + encodeURIComponent(origin);
    if (stops.length) url += '&waypoints=' + encodeURIComponent(stops.map(function (p) { return p.lat + ',' + p.lng; }).join('|'));
    return { url: url, stops: stops.length };
  }

  // ── Export modal with "Before you go" ───────────────────────────────────────
  function openModal() {
    var s = state(), built = buildUrl(s), box = document.getElementById('fs-jm-box');
    var dest = s.route.destination || '';
    var h = '<button class="close" type="button" aria-label="Close">×</button>';

    if (!built) {
      h += '<h3>Where are you heading?</h3><p class="sub">Add a destination first so we can build your route.</p>' +
        '<a class="open" href="/">Plan a journey →</a>';
    } else {
      var n = (s.fuel ? 1 : 0) + s.svc.length + (s.park ? 1 : 0);
      h += '<h3>Your route is ready 🚗</h3><p class="sub">' +
        (s.route.origin ? esc(s.route.origin) + ' → ' : '') + esc(dest || 'your car park') +
        ' · ' + n + ' stop' + (n === 1 ? '' : 's') + '</p>' +
        '<a class="open" id="fs-jm-open" href="' + built.url + '" target="_blank" rel="noopener">Open in Maps</a>';
      if (built.stops > 3) h += '<p class="note">Some map apps show fewer stops on mobile. Check all your stops appear.</p>';

      var offers = '';
      if (!s.park && dest) {
        var dc = s.route.destCoords || {};
        offers += '<a class="offer" href="' + AFF.justpark(dest, dc.lat, dc.lng) + '" target="_blank" rel="noopener sponsored"><span class="ico">🅿️</span><div><b>Need parking in ' + esc(dest) + '?</b><span>Pre-book a space on JustPark</span></div></a>';
      }
      if (!s.fuel && path !== '/fuel-finder') {
        offers += '<a class="offer" href="/fuel-finder"><span class="ico">⛽</span><div><b>Find the cheapest fuel on your route</b><span>Live prices, updated within 30 minutes</span></div></a>';
      }
      offers += '<a class="offer" href="' + AFF.aa + '" target="_blank" rel="noopener sponsored"><span class="ico">🔧</span><div><b>AA Breakdown Cover</b><span>Roadside help across the UK</span></div></a>';
      offers += '<a class="offer" href="' + AFF.rac + '" target="_blank" rel="noopener sponsored"><span class="ico">🛡️</span><div><b>RAC Breakdown Cover</b><span>Get covered before you set off</span></div></a>';

      h += '<div class="byg"><div class="byg-t">Before you go</div>' + offers +
        '<p class="disc">FuelSmarter may earn a commission from some links, at no cost to you.</p></div>';
    }

    box.innerHTML = h;
    box.querySelector('.close').addEventListener('click', closeModal);
    var op = document.getElementById('fs-jm-open');
    if (op) op.addEventListener('click', function () {
      if (typeof gtag === 'function') gtag('event', 'export_to_maps', { stops: built.stops });
    });
    document.getElementById('fs-jm').classList.add('on');
  }
  function closeModal() { document.getElementById('fs-jm').classList.remove('on'); }

  // ── Public API ──────────────────────────────────────────────────────────────
  window.FSJourney = {
    render: render,
    state: state,
    open: openModal,
    setFuel: function (v) { set(K.fuel, v); render(); },
    setServices: function (a) { set(K.svc, a); render(); },
    setParking: function (v) { set(K.park, v); render(); },
    setDestCoords: function (lat, lng) { var r = get(K.route, {}) || {}; r.destCoords = { lat: lat, lng: lng }; set(K.route, r); }
  };

  // Keep in sync across tabs
  window.addEventListener('storage', function (e) { if (e.key && e.key.indexOf('fs_') === 0) { render(); changed(); } });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
