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
    rac: 'https://www.rac.co.uk/breakdown-cover',
    // Awin tracked links (publisher 3113587)
    awin: function (mid, url) {
      return 'https://www.awin1.com/cread.php?awinmid=' + mid + '&awinaffid=3113587&ued=' + encodeURIComponent(url);
    },
    compareParking: function () { return AFF.awin(118401, 'https://www.compareparkingprices.co.uk/'); },
    arcParking: function () { return AFF.awin(121428, 'https://arcparking.co.uk/'); }
  };

  // ── UK airports (for airport parking offers) ────────────────────────────────
  var AIRPORTS = [
    { name: 'Heathrow', keys: ['heathrow', 'lhr'], lat: 51.4700, lng: -0.4543 },
    { name: 'Gatwick', keys: ['gatwick', 'lgw'], lat: 51.1537, lng: -0.1821 },
    { name: 'Stansted', keys: ['stansted', 'stn'], lat: 51.8860, lng: 0.2389 },
    { name: 'Luton', keys: ['luton airport', 'ltn'], lat: 51.8747, lng: -0.3683 },
    { name: 'London City', keys: ['london city airport', 'lcy'], lat: 51.5048, lng: 0.0495 },
    { name: 'Southend', keys: ['southend airport'], lat: 51.5714, lng: 0.6956 },
    { name: 'Manchester', keys: ['manchester airport', 'man airport', 'ringway'], lat: 53.3537, lng: -2.2750 },
    { name: 'Birmingham', keys: ['birmingham airport', 'bhx'], lat: 52.4539, lng: -1.7480 },
    { name: 'Bristol', keys: ['bristol airport', 'brs'], lat: 51.3827, lng: -2.7191 },
    { name: 'East Midlands', keys: ['east midlands airport', 'ema'], lat: 52.8311, lng: -1.3281 },
    { name: 'Leeds Bradford', keys: ['leeds bradford', 'lba'], lat: 53.8659, lng: -1.6606 },
    { name: 'Liverpool', keys: ['liverpool airport', 'john lennon airport', 'lpl'], lat: 53.3336, lng: -2.8497 },
    { name: 'Newcastle', keys: ['newcastle airport', 'ncl'], lat: 55.0375, lng: -1.6917 },
    { name: 'Southampton', keys: ['southampton airport', 'sou'], lat: 50.9503, lng: -1.3568 },
    { name: 'Exeter', keys: ['exeter airport'], lat: 50.7344, lng: -3.4139 },
    { name: 'Cardiff', keys: ['cardiff airport', 'cwl'], lat: 51.3967, lng: -3.3433 },
    { name: 'Edinburgh', keys: ['edinburgh airport', 'edi'], lat: 55.9500, lng: -3.3725 },
    { name: 'Glasgow', keys: ['glasgow airport', 'gla'], lat: 55.8719, lng: -4.4331 },
    { name: 'Aberdeen', keys: ['aberdeen airport', 'abz'], lat: 57.2019, lng: -2.1978 },
    { name: 'Belfast International', keys: ['belfast international', 'bfs'], lat: 54.6575, lng: -6.2158 },
    { name: 'Doncaster', keys: ['doncaster airport', 'doncaster sheffield'], lat: 53.4805, lng: -1.0106 }
  ];
  // Returns the airport the trip ends at, or null. Matches the typed destination
  // first, then falls back to being within 3 km of an airport.
  function findAirport(destText, coords) {
    var t = String(destText || '').toLowerCase();
    for (var i = 0; i < AIRPORTS.length; i++) {
      var a = AIRPORTS[i];
      for (var j = 0; j < a.keys.length; j++) {
        var k = a.keys[j];
        if (k.length <= 3 ? new RegExp('\\b' + k + '\\b').test(t) : t.indexOf(k) !== -1) return a;
      }
    }
    if (coords && coords.lat) {
      for (var n = 0; n < AIRPORTS.length; n++) if (dist(coords, AIRPORTS[n]) < 3) return AIRPORTS[n];
    }
    return null;
  }

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
    '.fs-loc-btn{display:inline-flex;align-items:center;gap:4px;margin:6px 0 2px;padding:0;border:none;background:none;color:var(--accent,#2D6A4F);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;}' +
    '.fs-loc-btn:hover{text-decoration:underline;}' +
    '.fs-loc-btn:disabled{opacity:0.6;cursor:default;text-decoration:none;}' +
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

  // ── "Before you go" offers ──────────────────────────────────────────────────
  function buildOffers(s) {
    var dest = s.route.destination || '';
    var offers = '';
    var endCoords = s.park && s.park.lat ? { lat: s.park.lat, lng: s.park.lng } : s.route.destCoords;
    var airport = findAirport(dest, endCoords);
    if (airport) {
      offers += '<a class="offer" href="' + AFF.compareParking() + '" target="_blank" rel="noopener sponsored"><span class="ico">✈️</span><div><b>Compare ' + esc(airport.name) + ' Airport parking</b><span>Meet & greet, park & ride and on-site deals — pre-book and save</span></div></a>';
      if (airport.name === 'Heathrow') {
        offers += '<a class="offer" href="' + AFF.arcParking() + '" target="_blank" rel="noopener sponsored"><span class="ico">🅿️</span><div><b>Arc Parking at Heathrow</b><span>Secure park & ride or meet & greet, 24/7</span></div></a>';
      }
      offers += '<a class="offer" href="' + AFF.justpark(airport.name + ' Airport', airport.lat, airport.lng) + '" target="_blank" rel="noopener sponsored"><span class="ico">🚗</span><div><b>Cheaper spaces near ' + esc(airport.name) + ' on JustPark</b><span>Private driveways and car parks a short drive away</span></div></a>';
    } else if (s.park && s.park.lat) {
      offers += '<a class="offer" href="' + AFF.justpark(s.park.name, s.park.lat, s.park.lng) + '" target="_blank" rel="noopener sponsored"><span class="ico">🅿️</span><div><b>Secure your space near ' + esc(s.park.name) + '</b><span>Pre-book on JustPark so it\'s waiting when you arrive</span></div></a>';
    } else if (dest) {
      var dc = s.route.destCoords || {};
      offers += '<a class="offer" href="' + AFF.justpark(dest, dc.lat, dc.lng) + '" target="_blank" rel="noopener sponsored"><span class="ico">🅿️</span><div><b>Need parking in ' + esc(dest) + '?</b><span>Pre-book a space on JustPark</span></div></a>';
    }
    if (!s.fuel && path !== '/fuel-finder') {
      offers += '<a class="offer" href="/fuel-finder"><span class="ico">⛽</span><div><b>Find the cheapest fuel on your route</b><span>Live prices, updated within 30 minutes</span></div></a>';
    }
    offers += '<a class="offer" href="' + AFF.aa + '" target="_blank" rel="noopener sponsored"><span class="ico">🔧</span><div><b>AA Breakdown Cover</b><span>Roadside help across the UK</span></div></a>';
    offers += '<a class="offer" href="' + AFF.rac + '" target="_blank" rel="noopener sponsored"><span class="ico">🛡️</span><div><b>RAC Breakdown Cover</b><span>Get covered before you set off</span></div></a>';
    return '<div class="byg"><div class="byg-t">Before you go</div>' + offers +
      '<p class="disc">FuelSmarter may earn a commission from some links, at no cost to you.</p></div>';
  }

  // ── Export modal ────────────────────────────────────────────────────────────
  // openModal()            → whole planned route
  // openModal(url, name)   → a single place someone tapped "Open in Maps" on
  function openModal(placeUrl, placeName) {
    if (typeof placeUrl !== 'string') placeUrl = null;
    var s = state(), built = buildUrl(s), box = document.getElementById('fs-jm-box');
    var dest = s.route.destination || '';
    var h = '<button class="close" type="button" aria-label="Close">×</button>';
    var trackStops = built ? built.stops : 0;

    if (placeUrl) {
      h += '<h3>' + (placeName ? esc(placeName) : 'Open in Maps') + '</h3>' +
        '<p class="sub">Opening just this location in your map app.</p>' +
        '<a class="open" id="fs-jm-open" href="' + esc(placeUrl) + '" target="_blank" rel="noopener">Open in Maps</a>';
      var n0 = (s.fuel ? 1 : 0) + s.svc.length + (s.park ? 1 : 0);
      if (built && n0) {
        h += '<p class="note" style="font-size:12px;">Or <a href="#" id="fs-jm-full" style="color:#4285F4;font-weight:600;">open your full route with ' + n0 + ' stop' + (n0 === 1 ? '' : 's') + ' →</a></p>';
      }
      trackStops = 0;
    } else if (!built) {
      h += '<h3>Where are you heading?</h3><p class="sub">Add a destination first so we can build your route.</p>' +
        '<a class="open" href="/">Plan a journey →</a>';
    } else {
      var n = (s.fuel ? 1 : 0) + s.svc.length + (s.park ? 1 : 0);
      h += '<h3>Your route is ready 🚗</h3><p class="sub">' +
        (s.route.origin ? esc(s.route.origin) + ' → ' : '') + esc(dest || 'your car park') +
        ' · ' + n + ' stop' + (n === 1 ? '' : 's') + '</p>' +
        '<a class="open" id="fs-jm-open" href="' + built.url + '" target="_blank" rel="noopener">Open in Maps</a>';
      if (built.stops > 3) h += '<p class="note">Some map apps show fewer stops on mobile. Check all your stops appear.</p>';
    }
    if (placeUrl || built) h += buildOffers(s);

    box.innerHTML = h;
    box.querySelector('.close').addEventListener('click', closeModal);
    var op = document.getElementById('fs-jm-open');
    if (op) op.addEventListener('click', function () {
      if (typeof gtag === 'function') gtag('event', placeUrl ? 'open_place_in_maps' : 'export_to_maps', { stops: trackStops });
    });
    var full = document.getElementById('fs-jm-full');
    if (full) full.addEventListener('click', function (e) { e.preventDefault(); openModal(); });
    document.getElementById('fs-jm').classList.add('on');
  }
  function closeModal() { document.getElementById('fs-jm').classList.remove('on'); }

  // ── Route single-place "Open in Maps" links through the panel ───────────────
  // Any link to Google Maps on the page (cards, map pop-ups) opens the panel
  // first, so "Before you go" offers are shown. Ctrl/Cmd-click still goes straight.
  function isMapsLink(a) {
    return a && a.href && /^https:\/\/(www\.)?google\.[a-z.]+\/maps/i.test(a.href);
  }
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest ? e.target.closest('a') : null;
    if (!isMapsLink(a) || a.closest('#fs-jm')) return;
    e.preventDefault();
    e.stopPropagation();
    inject();
    var card = a.closest('[class*="card"]');
    var nameEl = card && card.querySelector('.station-name, .service-name, .parking-name');
    var name = nameEl ? nameEl.textContent.trim() : '';
    if (!name) {
      var iw = a.closest('.gm-style-iw, .gm-style-iw-d');
      var b = iw && iw.querySelector('div[style*="font-weight:700"]');
      if (b) name = b.textContent.trim();
    }
    openModal(a.href, name);
  }, true);

  // ── "Use my location" on every From box ─────────────────────────────────────
  var FROM_IDS = ['origin', 'origin-input'];
  function addLocationButtons() {
    if (!navigator.geolocation) return;
    FROM_IDS.forEach(function (id) {
      var input = document.getElementById(id);
      if (!input || input.getAttribute('data-fs-loc')) return;
      input.setAttribute('data-fs-loc', '1');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fs-loc-btn';
      btn.innerHTML = '📍 Use my current location';
      btn.addEventListener('click', function () { useMyLocationFor(input, btn); });
      input.insertAdjacentElement('afterend', btn);
    });
  }
  function useMyLocationFor(input, btn) {
    var label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = 'Finding you…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      var coordText = lat.toFixed(5) + ',' + lng.toFixed(5);
      function done(text) {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        btn.disabled = false;
        btn.innerHTML = '✓ Using your location';
        setTimeout(function () { btn.innerHTML = label; }, 3000);
      }
      // UK: turn coordinates into a postcode so the box reads nicely
      fetch('https://api.postcodes.io/postcodes?lon=' + lng + '&lat=' + lat + '&limit=1')
        .then(function (r) { return r.json(); })
        .then(function (d) { done(d && d.result && d.result[0] ? d.result[0].postcode : coordText); })
        .catch(function () { done(coordText); });
    }, function (err) {
      btn.disabled = false;
      btn.innerHTML = err && err.code === 1 ? 'Location blocked — type it instead' : 'Couldn\'t find you — type it instead';
      setTimeout(function () { btn.innerHTML = label; }, 4000);
    }, { timeout: 10000, maximumAge: 60000 });
  }

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

  function start() { render(); addLocationButtons(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
