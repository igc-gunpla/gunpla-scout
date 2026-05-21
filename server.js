const http     = require('http');
const url      = require('url');
const axios    = require('axios');
const NodeCache = require('node-cache');

const PORT = process.env.PORT || 3000;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '5c434df146987a017b1db25457b4d759';

const cache = new NodeCache({ stdTTL: 300 });

// ── URL BUILDERS ──────────────────────────────────────────────────────────────
function buildApiUrl(storeId, query) {
  const q = encodeURIComponent(query);
  switch (storeId) {
    case 'usags':
      return `https://www.usagundamstore.com/search/suggest.json?q=${q}&resources[type]=product&resources[limit]=12&section_id=predictive-search`;
    case 'newtype':
      // Scrape search results page via ScraperAPI (suggest.json returns HTML, not JSON)
      const newtypeSearch = `https://newtype.us/search?q=${q}&type=product`;
      return `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(newtypeSearch)}&country_code=us&render=false`;
    case 'gpros':
      return `https://www.gundampros.shop/wp-json/wc/store/v1/products?search=${q}&per_page=12&status=publish`;
    default:
      return null;
  }
}

// ── FETCH ─────────────────────────────────────────────────────────────────────
async function fetchUrl(targetUrl) {
  const response = await axios.get(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Referer': 'https://www.google.com/'
    },
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: () => true,
    responseType: 'text'
  });
  return { status: response.status, body: response.data };
}

// ── NEWTYPE HTML PARSER ───────────────────────────────────────────────────────
function parseNewtypeHTML(html) {
  const items = [];

  // Extract product cards — Newtype uses Shopify so product links follow /products/ pattern
  // Match product blocks using regex on the HTML string
  
  // Strategy 1: Find all product URLs and titles from anchor tags
  const productLinkRegex = /href="(\/products\/[^"?#]+)"[^>]*>([^<]{3,120})/g;
  const seen = new Set();
  let match;

  while ((match = productLinkRegex.exec(html)) !== null) {
    const path = match[1];
    const text = match[2].trim().replace(/\s+/g, ' ');
    if (text.length < 3 || seen.has(path)) continue;
    seen.add(path);

    const fullUrl = 'https://newtype.us' + path;

    // Look for price near this match position
    const surrounding = html.slice(Math.max(0, match.index - 500), match.index + 500);
    const priceMatch = surrounding.match(/\$[\d,]+\.?\d*/);
    const price = priceMatch ? priceMatch[0] : '';

    // Look for stock indicators
    const surroundLower = surrounding.toLowerCase();
    let stock = 'En stock';
    if (surroundLower.includes('sold out') || surroundLower.includes('out of stock')) {
      stock = 'Sin stock';
    } else if (surroundLower.includes('pre-order') || surroundLower.includes('coming soon')) {
      stock = 'Pre-order';
    } else if (surroundLower.includes('< 10') || surroundLower.includes('low stock')) {
      stock = '< 10 unid.';
    }

    items.push({ name: text, url: fullUrl, price, stock });
  }

  // Deduplicate by URL keeping first occurrence
  const unique = [];
  const urlsSeen = new Set();
  for (const item of items) {
    if (!urlsSeen.has(item.url) && item.name.length > 3) {
      urlsSeen.add(item.url);
      unique.push(item);
    }
  }

  return unique.slice(0, 12);
}

// ── SERVER ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'Gunpla Scout API v6' }));
    return;
  }

  if (req.url.startsWith('/search')) {
    const params = url.parse(req.url, true).query;
    const storeId = params.store;
    const query   = params.q;

    if (!storeId || !query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing store or q parameter' }));
      return;
    }

    const cacheKey = `${storeId}:${query.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cached));
      return;
    }

    const apiUrl = buildApiUrl(storeId, query);
    if (!apiUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown store' }));
      return;
    }

    try {
      const result = await fetchUrl(apiUrl);

      if (result.status !== 200) {
        const errData = { error: `HTTP ${result.status}` };
        cache.set(cacheKey, errData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errData));
        return;
      }

      // ── NEWTYPE: parse HTML response ──────────────────────────────────────
      if (storeId === 'newtype') {
        const html = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);

        // Check if Cloudflare blocked us
        if (html.includes('cf-challenge') || html.includes('Attention Required') || html.includes('Just a moment')) {
          const errData = { error: 'Cloudflare block — intentar más tarde' };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errData));
          return;
        }

        const items = parseNewtypeHTML(html);
        const data = { items };
        cache.set(cacheKey, data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      // ── USAGS / GPROS: JSON response ──────────────────────────────────────
      let jsonData;
      try {
        jsonData = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
      } catch(e) {
        const errData = { error: 'Invalid JSON from store' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errData));
        return;
      }

      const bodyString = JSON.stringify(jsonData);
      if (bodyString.includes('cf-challenge') || bodyString.includes('Cloudflare') || bodyString.includes('Attention Required')) {
        const errData = { error: 'Cloudflare protection triggered' };
        cache.set(cacheKey, errData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errData));
        return;
      }

      cache.set(cacheKey, jsonData);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonData));

    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Gunpla Scout API v6 running on port ${PORT}`);
});
