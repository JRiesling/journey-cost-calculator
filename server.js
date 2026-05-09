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

// 2. Route calculation (cached per origin+destination, 24 hours)
app.post('/api/route', async (req, res) => {
  try {
    const { origin, destination, country, distUnit, aroadLabel, motorwayLabel } = req.body;
    if (!origin || !destination) return res.status(400).json({ error: 'Origin and destination are required' });

    const cacheKey = `${origin.toLowerCase().trim()}|${destination.toLowerCase().trim()}|${distUnit}`;
    const cached = routeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ROUTE_TTL) {
      return res.json({ ...cached.data, cached: true });
    }

    const result = await callClaude(
      `You are a driving route expert. Estimate driving distance in ${distUnit} and road type split for a journey. The three proportions (urban, aroad, motorway) must sum to exactly 1.0. Reply ONLY with valid JSON — no preamble, no markdown: {"distance":175.2,"typical_route":"via M6, M1","urban":0.15,"aroad":0.25,"motorway":0.60} If the route cannot be found: {"error":"Cannot find route"}. Be realistic about road splits — long journeys are motorway-heavy, short town-to-town journeys are A-road heavy, city journeys are urban-heavy.`,
      `From: "${origin}" To: "${destination}" Country context: ${country}. Distance unit: ${distUnit}. Road types: urban / ${aroadLabel} / ${motorwayLabel}.`
    );

    if (!result.error) {
      routeCache.set(cacheKey, { data: result, timestamp: Date.now() });
    }
    res.json(result);
  } catch (err) {
    console.error('Route error:', err.message);
    res.status(500).json({ error: 'Could not calculate route. Please enter distance manually.' });
  }
});

// 3. Number plate lookup (no caching — too many combinations)
app.post('/api/plate-lookup', async (req, res) => {
  try {
    const { plate, country, economy } = req.body;
    if (!plate) return res.status(400).json({ error: 'Plate is required' });

    const result = await callClaude(
      `You are a vehicle data expert for ${country}. Given a license/number plate, estimate the make, model, year, engine size, fuel type, and real-world fuel economy in ${economy}. Reply ONLY with valid JSON — no preamble, no markdown: {"make":"Ford","model":"Focus","year":2018,"engine_cc":1000,"fuel_type":"petrol","real_world_economy":42,"confidence":"medium","note":"1.0L EcoBoost typical real-world"} If the plate is unrecognisable: {"error":"Unrecognised plate format"}. confidence: high / medium / low.`,
      `Plate: ${plate.toUpperCase()} Country: ${country}`
    );

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

// ─── Health check (Render uses this to confirm the server is alive) ────────────
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── Serve frontend for all other routes (single page app) ───────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Journey Cost Calculator running on port ${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY environment variable is not set!');
  }
});
