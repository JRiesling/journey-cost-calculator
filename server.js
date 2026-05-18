const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Simple in-memory cache ───────────────────────────────────────────────────
// Fuel prices cached per country for 6 hours
// Routes cached for 24 hours (distances don't change)
// Vehicle lookups cached indefinitely per session (plate/model)
const fuelCache = new Map();   // key: countryCode, value: { data, timestamp }
const routeCache = new Map();  // key: "origin|dest", value: { data, timestamp }
const FUEL_TTL = 6 * 60 * 60 * 1000;   // 6 hours
const ROUTE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ─── Helper: call Claude API ──────────────────────────────────────────────────
async function callClaude(system, userMsg, maxTokens = 500) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', // Use Haiku for cost efficiency
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  const text = data.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

// ─── Rate limiting (simple in-memory) ────────────────────────────────────────
const requestCounts = new Map(); // key: IP, value: { count, resetTime }
const RATE_LIMIT = 30;           // max requests per window
const RATE_WINDOW = 60 * 1000;   // 1 minute window

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const record = requestCounts.get(ip);

  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return next();
  }

  if (record.count >= RATE_LIMIT) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  record.count++;
  next();
}

app.use('/api', rateLimit);

// ─── API Routes ───────────────────────────────────────────────────────────────

// 1. Fuel price lookup (cached per country, 6 hours)
app.post('/api/fuel-prices', async (req, res) => {
  try {
    const { country, currencyCode, fuelPriceNote } = req.body;
    if (!country) return res.status(400).json({ error: 'Country is required' });

    const cacheKey = country;
    const cached = fuelCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < FUEL_TTL) {
      return res.json({ ...cached.data, cached: true });
    }

    const result = await callClaude(
      `You are a fuel price expert. Return current approximate retail fuel prices for the given country. Reply ONLY with valid JSON — no preamble, no markdown: {"petrol": 1.75, "diesel": 1.70, "currency_note": "€/litre avg 2026"} Use realistic current prices in the local unit specified. For UK use pence per litre (e.g. 156.98). For US use dollars per gallon. For all others use local currency per litre.`,
      `Country: ${country} (${currencyCode}). Fuel unit: ${fuelPriceNote}.`
    );

    fuelCache.set(cacheKey, { data: result, timestamp: Date.now() });
    res.json(result);
  } catch (err) {
    console.error('Fuel price error:', err.message);
    res.status(500).json({ error: 'Could not fetch fuel prices. Using defaults.' });
  }
});

// ─── Helper: infer road type from a Google Routes API step instruction ────────
// Google returns HTML navigation instructions like "Take the <b>M1</b>"
// We parse these to classify each step as urban / aroad / motorway
function inferRoadType(instruction = '', distance_m = 0) {
  const text = instruction.replace(/<[^>]+>/g, '').toLowerCase();

  // Motorway patterns (UK M-roads, US Interstates, EU Autobahn etc.)
  if (/\bm\d+\b/.test(text)) return 'motorway';           // M1, M25 etc
  if (/\ba\d+\(m\)/.test(text)) return 'motorway';        // A1(M)
  if (/motorway|freeway|interstate|autobahn|autoroute|autopista|autostrada|snelweg|motorvej|motorväg|autosnelweg|otoyol/.test(text)) return 'motorway';
  if (/\bi-\d+\b/.test(text)) return 'motorway';          // I-95 (US interstates)

  // A-road / highway patterns
  if (/\ba\d+\b/.test(text)) return 'aroad';              // A1, A303 etc
  if (/\bb\d+\b/.test(text)) return 'aroad';              // B roads
  if (/highway|dual carriageway|trunk road|national route|state route|route nationale|bundesstra|rijksweg|riksväg|riksvei|landevej|carretera|estrada nacional/.test(text)) return 'aroad';

  // Long steps on unnamed roads are likely A-roads
  if (distance_m > 10000) return 'aroad';

  // Default: urban
  return 'urban';
}

// 2. Route calculation using Google Routes API (cached 24 hours)
app.post('/api/route', async (req, res) => {
  try {
    const { origin, destination, distUnit } = req.body;
    if (!origin || !destination) return res.status(400).json({ error: 'Origin and destination are required' });

    const cacheKey = `${origin.toLowerCase().trim()}|${destination.toLowerCase().trim()}|${distUnit}`;
    const cached = routeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ROUTE_TTL) {
      return res.json({ ...cached.data, cached: true });
    }

    if (!process.env.GOOGLE_MAPS_API_KEY) {
      throw new Error('GOOGLE_MAPS_API_KEY is not set');
    }

    // Call Google Routes API
    const googleRes = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.legs.steps,routes.description,routes.legs.startLocation,routes.legs.endLocation',
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

    if (!googleRes.ok) {
      const errText = await googleRes.text();
      throw new Error(`Google Routes API error: ${googleRes.status} — ${errText}`);
    }

    const googleData = await googleRes.json();

    if (!googleData.routes || googleData.routes.length === 0) {
      return res.json({ error: 'Cannot find route. Try more specific locations.' });
    }

    const route = googleData.routes[0];
    const distanceMetres = route.distanceMeters;
    const distanceKm = distanceMetres / 1000;
    const distanceMiles = distanceKm * 0.621371;
    const distance = distUnit === 'miles' ? distanceMiles : distanceKm;

    // Parse duration (Google returns "3600s" format)
    const durationSeconds = parseInt((route.duration || '0s').replace('s', ''));
    const durationMins = Math.round(durationSeconds / 60);

    // Build a readable route description from the route description or steps
    const typical_route = route.description || `${origin} to ${destination}`;

    // Classify each step by road type and accumulate distances
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
    const motorway = Math.round((1 - urban - aroad) * 100) / 100; // ensures sum = 1.0

    // Extract waypoints for fuel finder (start, ~25%, ~50%, ~75%, end)
    const leg = route.legs?.[0];
    const waypoints = [];
    if (leg?.startLocation?.latLng) {
      waypoints.push({ lat: leg.startLocation.latLng.latitude, lng: leg.startLocation.latLng.longitude });
    }
    const stepCount = steps.length;
    if (stepCount > 4) {
      [Math.floor(stepCount*0.25), Math.floor(stepCount*0.5), Math.floor(stepCount*0.75)].forEach(idx => {
        const step = steps[idx];
        if (step?.startLocation?.latLng) {
          waypoints.push({ lat: step.startLocation.latLng.latitude, lng: step.startLocation.latLng.longitude });
        }
      });
    }
    if (leg?.endLocation?.latLng) {
      waypoints.push({ lat: leg.endLocation.latLng.latitude, lng: leg.endLocation.latLng.longitude });
    }

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
      source: 'google',
    };

    routeCache.set(cacheKey, { data: result, timestamp: Date.now() });
    res.json(result);

  } catch (err) {
    console.error('Route error:', err.message);

    // Fallback to Claude AI estimation if Google fails
    console.log('Falling back to AI route estimation...');
    try {
      const { origin, destination, country, distUnit, aroadLabel, motorwayLabel } = req.body;
      const result = await callClaude(
        `You are a driving route expert. Estimate driving distance in ${distUnit} and road type split. Proportions must sum to 1.0. Reply ONLY JSON: {"distance":175.2,"typical_route":"via M6","urban":0.15,"aroad":0.25,"motorway":0.60} If unknown: {"error":"Cannot find route"}.`,
        `From: "${origin}" To: "${destination}" Country: ${country}`
      );
      if (!result.error) {
        routeCache.set(`${origin}|${destination}|${distUnit}`, { data: { ...result, source: 'ai' }, timestamp: Date.now() });
      }
      res.json({ ...result, source: 'ai' });
    } catch (fallbackErr) {
      res.status(500).json({ error: 'Could not calculate route. Please enter distance manually.' });
    }
  }
});

// 3. Number plate lookup — DVLA Vehicle Enquiry Service
const dvlaCache = new Map(); // cache plate lookups indefinitely per session
app.post('/api/plate-lookup', async (req, res) => {
  try {
    const { plate, country, economy } = req.body;
    if (!plate) return res.status(400).json({ error: 'Plate is required' });

    const cleanPlate = plate.toUpperCase().replace(/\s/g, '');

    // Check cache first
    const cacheKey = `dvla_${cleanPlate}`;
    if (dvlaCache.has(cacheKey)) {
      return res.json(dvlaCache.get(cacheKey));
    }

    // ── Step 1: Call DVLA Vehicle Enquiry Service ──────────────────────────
    const dvlaResponse = await fetch('https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.DVLA_API_KEY,
      },
      body: JSON.stringify({ registrationNumber: cleanPlate }),
    });

    if (!dvlaResponse.ok) {
      const errText = await dvlaResponse.text();
      console.error('DVLA API error:', dvlaResponse.status, errText);

      // If DVLA fails, fall back to AI estimation
      const fallback = await callClaude(
        `You are a vehicle data expert for UK. Given a number plate, estimate the make, model, year, engine size, fuel type, and real-world fuel economy in ${economy}. Reply ONLY with valid JSON: {"make":"Ford","model":"Focus","year":2018,"engine_cc":1000,"fuel_type":"petrol","real_world_economy":42,"confidence":"low","note":"DVLA unavailable — AI estimate only"} If unrecognisable: {"error":"Unrecognised plate format"}`,
        `Plate: ${cleanPlate}`
      );
      return res.json(fallback);
    }

    const dvlaData = await dvlaResponse.json();

    // ── Step 2: Use DVLA data + AI to estimate real-world MPG ─────────────
    const make = dvlaData.make || 'Unknown';
    const year = dvlaData.yearOfManufacture || 'Unknown';
    const engineCC = dvlaData.engineCapacity || 'Unknown';
    const fuelType = (dvlaData.fuelType || 'PETROL').toLowerCase();
    const colour = dvlaData.colour || '';
    const taxClass = dvlaData.taxClass || '';

    // Ask AI for real-world MPG using the accurate DVLA vehicle details
    const mpgResult = await callClaude(
      `You are a vehicle fuel economy expert. Given accurate vehicle details from the DVLA database, estimate the real-world fuel economy. Reply ONLY with valid JSON — no preamble, no markdown: {"make":"Ford","model":"Focus","year":2018,"engine_cc":1000,"fuel_type":"petrol","real_world_economy":42,"note":"1.0L EcoBoost — real-world owner data"} The economy unit is ${economy}. Real-world figures are typically 10-20% below official WLTP figures.`,
      `DVLA data: Make=${make}, Year=${year}, Engine=${engineCC}cc, Fuel=${fuelType}, Colour=${colour}, TaxClass=${taxClass}. Identify the most likely model and trim, then estimate real-world fuel economy.`
    );

    // Merge DVLA data with AI MPG estimate
    const result = {
      ...mpgResult,
      make: make,
      year: parseInt(year) || mpgResult.year,
      engine_cc: parseInt(engineCC) || mpgResult.engine_cc,
      fuel_type: fuelType,
      dvla_verified: true,
      confidence: 'high',
      note: mpgResult.note || `${year} ${make} — DVLA verified, MPG estimated from engine data`,
    };

    // Cache the result
    dvlaCache.set(cacheKey, result);
    res.json(result);

  } catch (err) {
    console.error('Plate lookup error:', err.message);
    res.status(500).json({ error: 'Could not look up plate. Try make & model or enter MPG manually.' });
  }
});

// 4. Make & model lookup (no caching — too many combinations)
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
  } catch (err) {
    console.error('Model lookup error:', err.message);
    res.status(500).json({ error: 'Could not look up vehicle. Please enter fuel economy manually.' });
  }
});

// 5. UK Fuel Finder — cheapest station on route
// Uses UK Government Fuel Finder API (OAuth 2.0)
let fuelFinderToken = null;
let fuelFinderTokenExpiry = 0;

async function getFuelFinderToken() {
  if (fuelFinderToken && Date.now() < fuelFinderTokenExpiry) {
    return fuelFinderToken;
  }
  const clientId = process.env.FUEL_FINDER_CLIENT_ID;
  const clientSecret = process.env.FUEL_FINDER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Fuel Finder credentials not configured');

  const response = await fetch('https://www.fuel-finder.service.gov.uk/api/v1/oauth/generate_access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Fuel Finder token error: ${response.status} — ${errText}`);
  }
  const json = await response.json();
  const data = json.data || json;
  fuelFinderToken = data.access_token;
  fuelFinderTokenExpiry = Date.now() + ((data.expires_in || 3600) * 1000) - 60000;
  console.log('Fuel Finder token obtained successfully');
  return fuelFinderToken;
}

// ─── Pre-load PFS station info (coordinates) on startup ──────────────────────
let pfsInfoMap = new Map();
let pfsInfoLoaded = false;

async function loadPFSInfo() {
  try {
    console.log('Loading PFS station info (coordinates)...');
    const token = await getFuelFinderToken();
    let totalLoaded = 0;

    for (let batch = 1; batch <= 8; batch++) {
      try {
        const res = await fetch(
          `https://www.fuel-finder.service.gov.uk/api/v1/pfs?batch-number=${batch}`,
          { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
        );
        if (!res.ok) { console.log(`PFS batch ${batch} failed: ${res.status}`); break; }
        const data = await res.json();
        const arr = Array.isArray(data) ? data : (data.data || data.results || []);
        if (arr.length === 0) { console.log(`PFS batch ${batch}: empty, stopping`); break; }
        arr.forEach(s => { if (s.node_id) pfsInfoMap.set(s.node_id, s); });
        totalLoaded += arr.length;
        console.log(`PFS batch ${batch}: ${arr.length} stations (total: ${totalLoaded})`);
        if (arr.length < 500) break;
      } catch (e) {
        console.log(`PFS batch ${batch} error:`, e.message);
        break;
      }
    }

    pfsInfoLoaded = true;
    console.log(`PFS info fully loaded: ${pfsInfoMap.size} stations`);
  } catch (e) {
    console.log('PFS info preload error:', e.message);
  }
}

// Pre-load fuel prices on startup
let pricesCacheMap = new Map(); // node_id -> fuel_prices array

async function loadFuelPrices() {
  try {
    console.log('Loading fuel prices...');
    const token = await getFuelFinderToken();
    let totalLoaded = 0;

    for (let batch = 1; batch <= 8; batch++) {
      try {
        const res = await fetch(
          `https://www.fuel-finder.service.gov.uk/api/v1/pfs/fuel-prices?batch-number=${batch}`,
          { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
        );
        if (!res.ok) { console.log(`Prices batch ${batch} failed: ${res.status}`); break; }
        const data = await res.json();
        const arr = Array.isArray(data) ? data : (data.data || data.results || []);
        if (arr.length === 0) { break; }
        arr.forEach(s => { if (s.node_id) pricesCacheMap.set(s.node_id, s.fuel_prices || []); });
        totalLoaded += arr.length;
        console.log(`Prices batch ${batch}: ${arr.length} stations (total: ${totalLoaded})`);
        if (arr.length < 500) break;
      } catch (e) {
        console.log(`Prices batch ${batch} error:`, e.message);
        break;
      }
    }
    console.log(`Fuel prices loaded: ${pricesCacheMap.size} stations`);
  } catch (e) {
    console.log('Fuel prices preload error:', e.message);
  }
}

// Refresh prices every 30 minutes
setInterval(loadFuelPrices, 30 * 60 * 1000);

// Cache fuel finder results for 30 minutes per location
const fuelFinderCache = new Map();
const FUEL_FINDER_TTL = 30 * 60 * 1000;

app.post('/api/fuel-finder', async (req, res) => {
  try {
    const { waypoints, fuelType } = req.body;
    if (!waypoints || !waypoints.length) return res.status(400).json({ error: 'Waypoints required' });

    // Use first waypoint as cache key
    const wp = waypoints[0];
    const cacheKey = `${Math.round(wp.lat * 10) / 10}_${Math.round(wp.lng * 10) / 10}_${fuelType}`;
    const cached = fuelFinderCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < FUEL_FINDER_TTL) {
      return res.json({ ...cached.data, cached: true });
    }

    // Use pre-loaded prices and info maps
    const infoMap = pfsInfoMap;
    const fuelTypeMap = { 'petrol': ['E10', 'E5'], 'diesel': ['B7_STANDARD', 'B7'] };
    const targetFuelTypes = fuelTypeMap[fuelType] || ['E10', 'E5'];

    // If we have cached prices use them, otherwise fetch batch 1
    let pricesArray = [];
    if (pricesCacheMap.size > 0) {
      // Build from cache
      pricesArray = Array.from(pricesCacheMap.entries()).map(([node_id, fuel_prices]) => ({ node_id, fuel_prices }));
      console.log(`Using cached prices: ${pricesArray.length} stations`);
    } else {
      // Fetch fresh
      const token = await getFuelFinderToken();
      const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
      const pricesRes = await fetchWithTimeout(
        'https://www.fuel-finder.service.gov.uk/api/v1/pfs/fuel-prices?batch-number=1',
        { headers }
      );
      if (!pricesRes.ok) return res.status(502).json({ error: 'Fuel Finder unavailable' });
      const pricesData = await pricesRes.json();
      pricesArray = Array.isArray(pricesData) ? pricesData : (pricesData.data || pricesData.results || []);
    }

    console.log(`Fuel Finder: ${pricesArray.length} prices, ${pfsInfoMap.size} stations with coords`);

    // Haversine distance in km
    function haversine(lat1, lng1, lat2, lng2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    // Min distance from any waypoint
    function minDistToRoute(sLat, sLng) {
      return Math.min(...waypoints.map(wp => haversine(wp.lat, wp.lng, sLat, sLng)));
    }

    // Build joined dataset
    const joined = pricesArray.map(s => {
      const info = infoMap.get(s.node_id) || {};

      // Extract price
      const fuelPrices = s.fuel_prices || [];
      let price = 0;
      for (const ft of targetFuelTypes) {
        const match = fuelPrices.find(fp => fp.fuel_type === ft);
        if (match && match.price > 0) { price = match.price; break; }
      }
      if (!price) return null;

      // Extract coordinates from location object (confirmed field names from API)
      const loc = info.location || {};
      const sLat = parseFloat(loc.latitude || info.latitude || 0);
      const sLng = parseFloat(loc.longitude || info.longitude || 0);

      const distKm = (sLat && sLng) ? minDistToRoute(sLat, sLng) : 999;
      const address = [
        loc.address_line_1,
        loc.city,
        loc.postcode,
      ].filter(Boolean).join(', ');

      return {
        name: s.trading_name || info.trading_name || 'Fuel Station',
        brand: info.brand_name || '',
        address,
        lat: sLat,
        lng: sLng,
        price,
        distKm,
        lastUpdated: fuelPrices[0]?.price_last_updated || '',
        isSupermarket: info.is_supermarket_service_station || false,
        isMotorway: info.is_motorway_service_station || false,
      };
    }).filter(Boolean);

    // If we have coordinates, filter to within 8 miles (13km) of route
    const hasCoords = joined.some(s => s.lat && s.lng && s.distKm < 100);
    let result_stations;

    if (hasCoords) {
      result_stations = joined
        .filter(s => s.distKm < 13 && s.price > 50 && s.price < 300)
        .sort((a, b) => a.price - b.price)
        .slice(0, 5);
      console.log(`Fuel Finder: ${result_stations.length} stations within 8 miles of route`);
    } else {
      // Fall back to national cheapest
      result_stations = joined
        .filter(s => s.price > 50 && s.price < 300)
        .sort((a, b) => a.price - b.price)
        .slice(0, 5);
      console.log('Fuel Finder: no coordinates found, showing national cheapest');
    }

    const result = {
      stations: result_stations,
      routeSpecific: hasCoords,
    };
    fuelFinderCache.set(cacheKey, { data: result, timestamp: Date.now() });
    res.json(result);

  } catch (err) {
    console.error('Fuel Finder error:', err.message);
    res.status(500).json({ error: 'Could not fetch fuel prices. ' + err.message });
  }
});

// ─── Health check (Render uses this to confirm the server is alive) ────────────
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── Named page routes ────────────────────────────────────────────────────────
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/fuel-prices', (req, res) => res.sendFile(path.join(__dirname, 'public', 'fuel-prices.html')));
app.get('/environment', (req, res) => res.sendFile(path.join(__dirname, 'public', 'environment.html')));
app.get('/uk', (req, res) => res.sendFile(path.join(__dirname, 'public', 'uk.html')));
app.get('/us', (req, res) => res.sendFile(path.join(__dirname, 'public', 'us.html')));
app.get('/australia', (req, res) => res.sendFile(path.join(__dirname, 'public', 'australia.html')));
app.get('/france', (req, res) => res.sendFile(path.join(__dirname, 'public', 'france.html')));
app.get('/germany', (req, res) => res.sendFile(path.join(__dirname, 'public', 'germany.html')));
app.get('/guides/how-to-improve-mpg', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'how-to-improve-mpg.html')));
app.get('/guides/is-it-worth-driving-slower', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'is-it-worth-driving-slower.html')));
app.get('/guides', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'index.html')));
app.get('/faq', (req, res) => res.sendFile(path.join(__dirname, 'public', 'faq.html')));
app.get('/ev-calculator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ev-calculator.html')));
app.get('/guides/petrol-vs-electric', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'petrol-vs-electric.html')));
app.get('/guides/ev-charging-costs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'ev-charging-costs.html')));
app.get('/guides/cost-per-mile-uk', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'cost-per-mile-uk.html')));
app.get('/guides/best-fuel-efficient-cars-uk', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'best-fuel-efficient-cars-uk.html')));
app.get('/guides/uk-fuel-duty', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'uk-fuel-duty.html')));
app.get('/guides/autobahn-driving-guide', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'autobahn-driving-guide.html')));
app.get('/guides/ev-vs-hybrid', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'ev-vs-hybrid.html')));
app.get('/llms.txt', (req, res) => { res.setHeader('Content-Type', 'text/plain'); res.sendFile(path.join(__dirname, 'public', 'llms.txt')); });
app.get('/guides/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guides', 'index.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});
app.get('/ads.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'public', 'ads.txt'));
});
app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Fuel Smarter running on port ${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY environment variable is not set!');
  }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.warn('WARNING: GOOGLE_MAPS_API_KEY is not set — route calculation will fall back to AI estimation.');
  }
  if (!process.env.DVLA_API_KEY) {
    console.warn('WARNING: DVLA_API_KEY is not set — plate lookup will fall back to AI estimation.');
  }
  // Pre-load PFS station info and prices in background
  setTimeout(loadPFSInfo, 5000);
  setTimeout(loadFuelPrices, 10000);
});
