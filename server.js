const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.match(/\.(css|js|woff2?|ttf|png|jpg|svg|ico)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    }
  }
}));

const fuelCache = new Map();
const routeCache = new Map();
const FUEL_TTL = 6 * 60 * 60 * 1000;
const ROUTE_TTL = 24 * 60 * 60 * 1000;

async function callClaude(system, userMsg, maxTokens = 500) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!response.ok) { const err = await response.text(); throw new Error(`Anthropic API error: ${response.status} — ${err}`); }
  const data = await response.json();
  const text = data.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

const requestCounts = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW = 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const record = requestCounts.get(ip);
  if (!record || now > record.resetTime) { requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW }); return next(); }
  if (record.count >= RATE_LIMIT) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  record.count++;
  next();
}
app.use('/api', rateLimit);

app.post('/api/fuel-prices', async (req, res) => {
  try {
    const { country, currencyCode, fuelPriceNote } = req.body;
    if (!country) return res.status(400).json({ error: 'Country is required' });

    // UK — use hardcoded current averages rather than AI (which returns stale data)
    // Update these periodically to reflect RAC/AA tracked national averages
    if (country === 'United Kingdom' || country === 'GB' || country === 'UK') {
      const ukPrices = { petrol: 156.8, diesel: 188.8, currency_note: 'pence/litre — UK national average May 2026' };
      fuelCache.set(country, { data: ukPrices, timestamp: Date.now() });
      return res.json(ukPrices);
    }

    const cached = fuelCache.get(country);
    if (cached && Date.now() - cached.timestamp < FUEL_TTL) return res.json({ ...cached.data, cached: true });
    const result = await callClaude(
      `You are a fuel price expert. Return current approximate retail fuel prices for the given country. Reply ONLY with valid JSON — no preamble, no markdown: {"petrol": 1.75, "diesel": 1.70, "currency_note": "€/litre avg 2026"} Use realistic current prices in the local unit specified. For UK use pence per litre (e.g. 156.98). For US use dollars per gallon. For all others use local currency per litre.`,
      `Country: ${country} (${currencyCode}). Fuel unit: ${fuelPriceNote}.`
    );
    fuelCache.set(country, { data: result, timestamp: Date.now() });
    res.json(result);
  } catch (err) { console.error('Fuel price error:', err.message); res.status(500).json({ error: 'Could not fetch fuel prices. Using defaults.' }); }
});

function inferRoadType(instruction = '', distance_m = 0) {
  const text = instruction.replace(/<[^>]+>/g, '').toLowerCase();
  if (/\bm\d+\b/.test(text)) return 'motorway';
  if (/\ba\d+\(m\)/.test(text)) return 'motorway';
  if (/motorway|freeway|interstate|autobahn|autoroute|autopista|autostrada|snelweg|motorvej|motorväg|autosnelweg|otoyol/.test(text)) return 'motorway';
  if (/\bi-\d+\b/.test(text)) return 'motorway';
  if (/\ba\d+\b/.test(text)) return 'aroad';
  if (/\bb\d+\b/.test(text)) return 'aroad';
  if (/highway|dual carriageway|trunk road|national route|state route|route nationale|bundesstra|rijksweg|riksväg|riksvei|landevej|carretera|estrada nacional/.test(text)) return 'aroad';
  if (distance_m > 10000) return 'aroad';
  return 'urban';
}

// ── Decode Google encoded polyline ────────────────────────────────────────────
function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

app.post('/api/route', async (req, res) => {
  try {
    const { origin, destination, distUnit } = req.body;
    if (!origin || !destination) return res.status(400).json({ error: 'Origin and destination are required' });

    const cacheKey = `${origin.toLowerCase().trim()}|${destination.toLowerCase().trim()}|${distUnit}`;
    const cached = routeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ROUTE_TTL) return res.json({ ...cached.data, cached: true });

    if (!process.env.GOOGLE_MAPS_API_KEY) throw new Error('GOOGLE_MAPS_API_KEY is not set');

    const googleRes = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline,routes.legs.steps,routes.description,routes.legs.startLocation,routes.legs.endLocation',
      },
      body: JSON.stringify({
        origin: { address: origin },
        destination: { address: destination },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
        computeAlternativeRoutes: false,
        routeModifiers: { avoidFerries: true },
      }),
    });

    if (!googleRes.ok) { const errText = await googleRes.text(); throw new Error(`Google Routes API error: ${googleRes.status} — ${errText}`); }

    const googleData = await googleRes.json();
    if (!googleData.routes || googleData.routes.length === 0) return res.json({ error: 'Cannot find route. Try more specific locations.' });

    const route = googleData.routes[0];
    const distanceMetres = route.distanceMeters;
    const distanceKm = distanceMetres / 1000;
    const distanceMiles = distanceKm * 0.621371;
    const distance = distUnit === 'miles' ? distanceMiles : distanceKm;

    const durationSeconds = parseInt((route.duration || '0s').replace('s', ''));
    const durationMins = Math.round(durationSeconds / 60);
    const typical_route = route.description || `${origin} to ${destination}`;

    let urbanMetres = 0, aroadMetres = 0, motorwayMetres = 0;
    const steps = route.legs?.[0]?.steps || [];
    steps.forEach(step => {
      const dist = step.distanceMeters || 0;
      const instruction = step.navigationInstruction?.instructions || '';
      const type = inferRoadType(instruction, dist);
      if (type === 'motorway') motorwayMetres += dist;
      else if (type === 'aroad') aroadMetres += dist;
      else urbanMetres += dist;
    });

    const total = urbanMetres + aroadMetres + motorwayMetres || distanceMetres;
    const urban    = Math.round((urbanMetres / total) * 100) / 100;
    const aroad    = Math.round((aroadMetres / total) * 100) / 100;
    const motorway = Math.round((1 - urban - aroad) * 100) / 100;

    // Decode full polyline for accurate route display and fuel finder
    let polylinePoints = [];
    if (route.polyline?.encodedPolyline) {
      polylinePoints = decodePolyline(route.polyline.encodedPolyline);
    }

    // Use polyline points as waypoints (sampled every ~10 points for fuel finder)
    // Fall back to step locations if no polyline
    let waypoints = [];
    if (polylinePoints.length > 0) {
      // Sample polyline — every 10th point gives ~50-200 waypoints depending on route length
      const step = Math.max(1, Math.floor(polylinePoints.length / 100));
      for (let i = 0; i < polylinePoints.length; i += step) {
        waypoints.push(polylinePoints[i]);
      }
      // Always include last point
      waypoints.push(polylinePoints[polylinePoints.length - 1]);
    } else {
      // Fall back to step locations
      const leg = route.legs?.[0];
      if (leg?.startLocation?.latLng) waypoints.push({ lat: leg.startLocation.latLng.latitude, lng: leg.startLocation.latLng.longitude });
      steps.forEach(step => { if (step?.startLocation?.latLng) waypoints.push({ lat: step.startLocation.latLng.latitude, lng: step.startLocation.latLng.longitude }); });
      if (leg?.endLocation?.latLng) waypoints.push({ lat: leg.endLocation.latLng.latitude, lng: leg.endLocation.latLng.longitude });
    }

    console.log(`Route: ${waypoints.length} waypoints from ${polylinePoints.length > 0 ? 'polyline' : 'steps'}`);

    const result = {
      distance: Math.round(distance * 10) / 10,
      distanceKm: Math.round(distanceKm * 10) / 10,
      distanceMiles: Math.round(distanceMiles * 10) / 10,
      durationMins,
      typical_route,
      urban,
      aroad,
      motorway,
      waypoints,
      polyline: route.polyline?.encodedPolyline || null,
      source: 'google',
    };

    routeCache.set(cacheKey, { data: result, timestamp: Date.now() });
    res.json(result);

  } catch (err) {
    console.error('Route error:', err.message);
    try {
      const { origin, destination, country, distUnit } = req.body;
      const result = await callClaude(
        `You are a driving route expert. Estimate driving distance in ${distUnit} and road type split. Proportions must sum to 1.0. Reply ONLY JSON: {"distance":175.2,"typical_route":"via M6","urban":0.15,"aroad":0.25,"motorway":0.60} If unknown: {"error":"Cannot find route"}.`,
        `From: "${origin}" To: "${destination}" Country: ${country}`
      );
      if (!result.error) routeCache.set(`${origin}|${destination}|${distUnit}`, { data: { ...result, source: 'ai' }, timestamp: Date.now() });
      res.json({ ...result, source: 'ai' });
    } catch (fallbackErr) {
      res.status(500).json({ error: 'Could not calculate route. Please enter distance manually.' });
    }
  }
});

const dvlaCache = new Map();
app.post('/api/plate-lookup', async (req, res) => {
  try {
    const { plate, country, economy } = req.body;
    if (!plate) return res.status(400).json({ error: 'Plate is required' });
    const cleanPlate = plate.toUpperCase().replace(/\s/g, '');
    const cacheKey = `dvla_${cleanPlate}`;
    if (dvlaCache.has(cacheKey)) return res.json(dvlaCache.get(cacheKey));

    const dvlaResponse = await fetch('https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.DVLA_API_KEY },
      body: JSON.stringify({ registrationNumber: cleanPlate }),
    });

    if (!dvlaResponse.ok) {
      const errText = await dvlaResponse.text();
      console.error('DVLA API error:', dvlaResponse.status, errText);
      const fallback = await callClaude(
        `You are a vehicle data expert for UK. Given a number plate, estimate the make, model, year, engine size, fuel type, and real-world fuel economy in ${economy}. Reply ONLY with valid JSON: {"make":"Ford","model":"Focus","year":2018,"engine_cc":1000,"fuel_type":"petrol","real_world_economy":42,"confidence":"low","note":"DVLA unavailable — AI estimate only"} If unrecognisable: {"error":"Unrecognised plate format"}`,
        `Plate: ${cleanPlate}`
      );
      return res.json(fallback);
    }

    const dvlaData = await dvlaResponse.json();
    const make = dvlaData.make || 'Unknown';
    const year = dvlaData.yearOfManufacture || 'Unknown';
    const engineCC = dvlaData.engineCapacity || 'Unknown';
    const fuelType = (dvlaData.fuelType || 'PETROL').toLowerCase();
    const colour = dvlaData.colour || '';
    const taxClass = dvlaData.taxClass || '';

    const mpgResult = await callClaude(
      `You are a vehicle fuel economy expert. Given accurate vehicle details from the DVLA database, estimate the real-world fuel economy. Reply ONLY with valid JSON — no preamble, no markdown: {"make":"Ford","model":"Focus","year":2018,"engine_cc":1000,"fuel_type":"petrol","real_world_economy":42,"note":"1.0L EcoBoost — real-world owner data"} The economy unit is ${economy}. Real-world figures are typically 10-20% below official WLTP figures.`,
      `DVLA data: Make=${make}, Year=${year}, Engine=${engineCC}cc, Fuel=${fuelType}, Colour=${colour}, TaxClass=${taxClass}. Identify the most likely model and trim, then estimate real-world fuel economy.`
    );

    const result = { ...mpgResult, make, year: parseInt(year) || mpgResult.year, engine_cc: parseInt(engineCC) || mpgResult.engine_cc, fuel_type: fuelType, dvla_verified: true, confidence: 'high', note: mpgResult.note || `${year} ${make} — DVLA verified, MPG estimated from engine data` };
    dvlaCache.set(cacheKey, result);
    res.json(result);
  } catch (err) { console.error('Plate lookup error:', err.message); res.status(500).json({ error: 'Could not look up plate. Try make & model or enter MPG manually.' }); }
});

app.post('/api/model-lookup', async (req, res) => {
  try {
    const { make, model, year, trim, country, economy } = req.body;
    if (!make || !model) return res.status(400).json({ error: 'Make and model are required' });
    const query = [year, make, model, trim].filter(Boolean).join(' ');
    const result = await callClaude(
      `You are a vehicle fuel economy expert. Estimate real-world fuel economy in ${economy} for the ${country} market. Real-world figures are typically 10-20% lower than official test figures. Reply ONLY with valid JSON — no preamble, no markdown: {"make":"Ford","model":"Focus","year":2019,"engine_cc":1000,"fuel_type":"petrol","real_world_economy":42,"confidence":"high","note":"1.0L EcoBoost real-world based on owner data"} If unrecognisable: {"error":"Cannot identify vehicle"}. confidence: high / medium / low.`,
      `Car: ${query} Market: ${country}`
    );
    res.json(result);
  } catch (err) { console.error('Model lookup error:', err.message); res.status(500).json({ error: 'Could not look up vehicle. Please enter fuel economy manually.' }); }
});

let fuelFinderToken = null;
let fuelFinderTokenExpiry = 0;

async function getFuelFinderToken() {
  if (fuelFinderToken && Date.now() < fuelFinderTokenExpiry) return fuelFinderToken;
  const clientId = process.env.FUEL_FINDER_CLIENT_ID;
  const clientSecret = process.env.FUEL_FINDER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Fuel Finder credentials not configured');
  const response = await fetch('https://www.fuel-finder.service.gov.uk/api/v1/oauth/generate_access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) { const errText = await response.text(); throw new Error(`Fuel Finder token error: ${response.status} — ${errText}`); }
  const json = await response.json();
  const data = json.data || json;
  fuelFinderToken = data.access_token;
  fuelFinderTokenExpiry = Date.now() + ((data.expires_in || 3600) * 1000) - 60000;
  console.log('Fuel Finder token obtained successfully');
  return fuelFinderToken;
}

let pfsInfoMap = new Map();
let pfsInfoLoaded = false;

async function loadPFSInfo() {
  try {
    console.log('Loading PFS station info (coordinates)...');
    const token = await getFuelFinderToken();
    let totalLoaded = 0;
    for (let batch = 1; batch <= 20; batch++) {
      try {
        const res = await fetch(`https://www.fuel-finder.service.gov.uk/api/v1/pfs?batch-number=${batch}`, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
        if (!res.ok) { console.log(`PFS batch ${batch} failed: ${res.status}`); break; }
        const data = await res.json();
        const arr = Array.isArray(data) ? data : (data.data || data.results || []);
        if (arr.length === 0) { console.log(`PFS batch ${batch}: empty, stopping`); break; }
        arr.forEach(s => { if (s.node_id) pfsInfoMap.set(s.node_id, s); });
        totalLoaded += arr.length;
        console.log(`PFS batch ${batch}: ${arr.length} stations (total: ${totalLoaded})`);
        if (arr.length < 500) break;
      } catch (e) { console.log(`PFS batch ${batch} error:`, e.message); break; }
    }
    pfsInfoLoaded = true;
    console.log(`PFS info fully loaded: ${pfsInfoMap.size} stations`);
  } catch (e) { console.log('PFS info preload error:', e.message); }
}

let pricesCacheMap = new Map();

async function loadFuelPrices() {
  try {
    console.log('Loading fuel prices...');
    const token = await getFuelFinderToken();
    let totalLoaded = 0;
    for (let batch = 1; batch <= 20; batch++) {
      try {
        const res = await fetch(`https://www.fuel-finder.service.gov.uk/api/v1/pfs/fuel-prices?batch-number=${batch}`, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
        if (!res.ok) { console.log(`Prices batch ${batch} failed: ${res.status}`); break; }
        const data = await res.json();
        const arr = Array.isArray(data) ? data : (data.data || data.results || []);
        if (arr.length === 0) { break; }
        arr.forEach(s => { if (s.node_id) pricesCacheMap.set(s.node_id, s.fuel_prices || []); });
        totalLoaded += arr.length;
        console.log(`Prices batch ${batch}: ${arr.length} stations (total: ${totalLoaded})`);
        if (arr.length < 500) break;
      } catch (e) { console.log(`Prices batch ${batch} error:`, e.message); break; }
    }
    console.log(`Fuel prices loaded: ${pricesCacheMap.size} stations`);
  } catch (e) { console.log('Fuel prices preload error:', e.message); }
}

setInterval(loadFuelPrices, 30 * 60 * 1000);

const fuelFinderCache = new Map();
const FUEL_FINDER_TTL = 30 * 60 * 1000;

app.post('/api/fuel-finder', async (req, res) => {
  try {
    const { waypoints, fuelType } = req.body;
    if (!waypoints || !waypoints.length) return res.status(400).json({ error: 'Waypoints required' });

    // Cache key uses spread of waypoints to avoid same-start-point cache collisions
    const wp0 = waypoints[0];
    const wpLast = waypoints[waypoints.length - 1];
    const cacheKey = `${Math.round(wp0.lat * 100) / 100}_${Math.round(wp0.lng * 100) / 100}_${Math.round(wpLast.lat * 100) / 100}_${Math.round(wpLast.lng * 100) / 100}_${fuelType}`;
    const cached = fuelFinderCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < FUEL_FINDER_TTL) return res.json({ ...cached.data, cached: true });

    const infoMap = pfsInfoMap;
    const fuelTypeMap = { 'petrol': ['E10', 'E5'], 'diesel': ['B7_STANDARD', 'B7'] };
    const targetFuelTypes = fuelTypeMap[fuelType] || ['E10', 'E5'];

    let pricesArray = [];
    if (pricesCacheMap.size > 0) {
      pricesArray = Array.from(pricesCacheMap.entries()).map(([node_id, fuel_prices]) => ({ node_id, fuel_prices }));
    } else {
      const token = await getFuelFinderToken();
      const pricesRes = await fetch('https://www.fuel-finder.service.gov.uk/api/v1/pfs/fuel-prices?batch-number=1', { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
      if (!pricesRes.ok) return res.status(502).json({ error: 'Fuel Finder unavailable' });
      const pricesData = await pricesRes.json();
      pricesArray = Array.isArray(pricesData) ? pricesData : (pricesData.data || pricesData.results || []);
    }

    console.log(`Fuel Finder: ${pricesArray.length} prices, ${pfsInfoMap.size} stations, ${waypoints.length} waypoints`);

    function haversine(lat1, lng1, lat2, lng2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    function minDistToRoute(sLat, sLng) {
      return Math.min(...waypoints.map(wp => haversine(wp.lat, wp.lng, sLat, sLng)));
    }

    const joined = pricesArray.map(s => {
      const info = infoMap.get(s.node_id) || {};
      const fuelPrices = s.fuel_prices || [];
      let price = 0;
      for (const ft of targetFuelTypes) {
        const match = fuelPrices.find(fp => fp.fuel_type === ft);
        if (match && match.price > 0) { price = match.price; break; }
      }
      if (!price) return null;

      const loc = info.location || {};
      const sLat = parseFloat(loc.latitude || info.latitude || 0);
      const sLng = parseFloat(loc.longitude || info.longitude || 0);
      const distKm = (sLat && sLng) ? minDistToRoute(sLat, sLng) : 999;
      const address = [loc.address_line_1, loc.city, loc.postcode].filter(Boolean).join(', ');

      return { name: s.trading_name || info.trading_name || 'Fuel Station', brand: info.brand_name || '', address, lat: sLat, lng: sLng, price, distKm, lastUpdated: fuelPrices[0]?.price_last_updated || '', isSupermarket: info.is_supermarket_service_station || false, isMotorway: info.is_motorway_service_station || false };
    }).filter(Boolean);

    const hasCoords = joined.some(s => s.lat && s.lng && s.distKm < 100);
    let result_stations, radiusUsed;

    if (hasCoords) {
      result_stations = joined.filter(s => s.distKm < 1.6 && s.price > 50 && s.price < 300).sort((a, b) => a.price - b.price).slice(0, 5);
      radiusUsed = 1;
      if (result_stations.length < 3) { result_stations = joined.filter(s => s.distKm < 4.8 && s.price > 50 && s.price < 300).sort((a, b) => a.price - b.price).slice(0, 5); radiusUsed = 3; }
      if (result_stations.length < 3) { result_stations = joined.filter(s => s.distKm < 13 && s.price > 50 && s.price < 300).sort((a, b) => a.price - b.price).slice(0, 5); radiusUsed = 8; }
      console.log(`Fuel Finder: ${result_stations.length} stations within ${radiusUsed} mile(s) of route`);
    } else {
      result_stations = joined.filter(s => s.price > 50 && s.price < 300).sort((a, b) => a.price - b.price).slice(0, 5);
      radiusUsed = null;
      console.log('Fuel Finder: no coordinates, showing national cheapest');
    }

    const result = { stations: result_stations, routeSpecific: hasCoords, radiusUsed };
    fuelFinderCache.set(cacheKey, { data: result, timestamp: Date.now() });
    res.json(result);

  } catch (err) { console.error('Fuel Finder error:', err.message); res.status(500).json({ error: 'Could not fetch fuel prices. ' + err.message }); }
});

// ── EV Charger API ────────────────────────────────────────────────────────────

const evChargerCache = new Map();
const EV_CHARGER_TTL = 60 * 60 * 1000; // 1 hour cache

app.post('/api/ev-chargers', async (req, res) => {
  try {
    const { lat, lng, distance = 10, maxresults = 10 } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    const cacheKey = `${Math.round(lat * 100) / 100}_${Math.round(lng * 100) / 100}_${distance}`;
    const cached = evChargerCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < EV_CHARGER_TTL) {
      return res.json({ ...cached.data, cached: true });
    }

    const apiKey = process.env.OPEN_CHARGE_MAP_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'EV charger API not configured' });

    const url = `https://api.openchargemap.io/v3/poi/?output=json&latitude=${lat}&longitude=${lng}&distance=${distance}&distanceunit=KM&maxresults=${maxresults}&compact=true&verbose=false&countrycode=&key=${apiKey}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'FuelSmarter/1.0 (fuel-smarter.com)' }
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Open Charge Map API error: ${response.status} — ${err}`);
    }

    const data = await response.json();

    // Normalise the response
    const chargers = data.map(poi => {
      const addr = poi.AddressInfo || {};
      const connections = poi.Connections || [];

      // Get the fastest connection
      const maxKw = connections.reduce((max, c) => {
        const kw = c.PowerKW || 0;
        return kw > max ? kw : max;
      }, 0);

      // Get connection types
      const connTypes = [...new Set(connections
        .map(c => c.ConnectionType && c.ConnectionType.Title)
        .filter(Boolean)
      )].slice(0, 3);

      // Speed label
      let speedLabel = 'Slow';
      if (maxKw >= 100) speedLabel = 'Ultra-rapid';
      else if (maxKw >= 43) speedLabel = 'Rapid';
      else if (maxKw >= 22) speedLabel = 'Fast';
      else if (maxKw >= 7) speedLabel = 'Fast';

      // Operator
      const operator = poi.OperatorInfo && poi.OperatorInfo.Title ? poi.OperatorInfo.Title : 'Unknown';

      // Status
      const statusType = poi.StatusType && poi.StatusType.Title ? poi.StatusType.Title : null;
      const isOperational = !statusType || statusType.toLowerCase().includes('operational') || statusType.toLowerCase().includes('unknown');

      return {
        id: poi.ID,
        name: addr.Title || operator,
        operator,
        address: [addr.AddressLine1, addr.Town, addr.Postcode].filter(Boolean).join(', '),
        lat: addr.Latitude,
        lng: addr.Longitude,
        maxKw,
        speedLabel,
        connTypes,
        numPoints: poi.NumberOfPoints || connections.length || 1,
        isOperational,
        status: statusType,
        usageType: poi.UsageType && poi.UsageType.Title ? poi.UsageType.Title : null,
        isFree: poi.UsageType && poi.UsageType.IsFreeCharge,
        mapsUrl: `https://www.google.com/maps/search/${encodeURIComponent((addr.Title || operator) + ' ' + (addr.AddressLine1 || '') + ' ' + (addr.Postcode || ''))}`,
      };
    }).filter(c => c.lat && c.lng);

    const result = { chargers };
    evChargerCache.set(cacheKey, { data: result, timestamp: Date.now() });
    res.json(result);

  } catch (err) {
    console.error('EV charger error:', err.message);
    res.status(500).json({ error: 'Could not fetch EV chargers. ' + err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/api/maps-key', (req, res) => res.json({ key: process.env.GOOGLE_MAPS_API_KEY || '' }));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/fuel-prices', (req, res) => res.sendFile(path.join(__dirname, 'public', 'fuel-prices.html')));
app.get('/environment', (req, res) => res.sendFile(path.join(__dirname, 'public', 'environment.html')));
app.get('/fuel-finder', (req, res) => res.sendFile(path.join(__dirname, 'public', 'fuel-finder.html')));
app.get('/uk', (req, res) => res.sendFile(path.join(__dirname, 'public', 'uk.html')));
app.get('/us', (req, res) => res.sendFile(path.join(__dirname, 'public', 'us.html')));
app.get('/australia', (req, res) => res.sendFile(path.join(__dirname, 'public', 'australia.html')));
app.get('/france', (req, res) => res.sendFile(path.join(__dirname, 'public', 'france.html')));
app.get('/germany', (req, res) => res.sendFile(path.join(__dirname, 'public', 'germany.html')));
app.get('/guides/how-to-improve-mpg', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'how-to-improve-mpg.html')));
app.get('/guides/is-it-worth-driving-slower', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'is-it-worth-driving-slower.html')));
app.get('/guides', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'index.html')));
app.get('/guides/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'index.html')));
app.get('/faq', (req, res) => res.sendFile(path.join(__dirname, 'public', 'faq.html')));
app.get('/ev-calculator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ev-calculator.html')));
app.get('/guides/petrol-vs-electric', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'petrol-vs-electric.html')));
app.get('/guides/ev-charging-costs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'ev-charging-costs.html')));
app.get('/guides/cost-per-mile-uk', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'cost-per-mile-uk.html')));
app.get('/guides/best-fuel-efficient-cars-uk', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'best-fuel-efficient-cars-uk.html')));
app.get('/guides/uk-fuel-duty', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'uk-fuel-duty.html')));
app.get('/guides/autobahn-driving-guide', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'autobahn-driving-guide.html')));
app.get('/guides/ev-vs-hybrid', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'ev-vs-hybrid.html')));
app.get('/guides/london-to-cornwall', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'london-to-cornwall.html')));
app.get('/guides/london-to-edinburgh', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'london-to-edinburgh.html')));
app.get('/guides/cheapest-day-to-buy-petrol', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'cheapest-day-to-buy-petrol.html')));
app.get('/guides/why-petrol-prices-vary', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'why-petrol-prices-vary.html')));
app.get('/car-care', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car-care.html')));
app.get('/guides/most-fuel-efficient-small-cars', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'most-fuel-efficient-small-cars.html')));
app.get('/guides/most-fuel-efficient-family-cars', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'most-fuel-efficient-family-cars.html')));
app.get('/guides/most-fuel-efficient-suvs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'most-fuel-efficient-suvs.html')));
app.get('/guides/most-fuel-efficient-used-cars', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'most-fuel-efficient-used-cars.html')));
app.get('/llms.txt', (req, res) => { res.setHeader('Content-Type', 'text/plain'); res.sendFile(path.join(__dirname, 'public', 'llms.txt')); });
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/sitemap.xml', (req, res) => { res.setHeader('Content-Type', 'application/xml'); res.sendFile(path.join(__dirname, 'public', 'sitemap.xml')); });
app.get('/ads.txt', (req, res) => { res.setHeader('Content-Type', 'text/plain'); res.sendFile(path.join(__dirname, 'public', 'ads.txt')); });
app.get('/robots.txt', (req, res) => { res.setHeader('Content-Type', 'text/plain'); res.sendFile(path.join(__dirname, 'public', 'robots.txt')); });
app.get('/91addefa64b146dea96e677938a4c432.txt', (req, res) => { res.setHeader('Content-Type', 'text/plain'); res.sendFile(path.join(__dirname, 'public', '91addefa64b146dea96e677938a4c432.txt')); });
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

app.listen(PORT, () => {
  console.log(`Fuel Smarter running on port ${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY not set');
  if (!process.env.GOOGLE_MAPS_API_KEY) console.warn('WARNING: GOOGLE_MAPS_API_KEY not set');
  if (!process.env.DVLA_API_KEY) console.warn('WARNING: DVLA_API_KEY not set');
  setTimeout(loadPFSInfo, 5000);
  setTimeout(loadFuelPrices, 10000);
});
