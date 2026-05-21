const http      = require('http');
const url       = require('url');
const axios     = require('axios');
const NodeCache = require('node-cache');

const PORT = process.env.PORT || 3000;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '5c434df146987a017b1db25457b4d759';

const cache = new NodeCache({ stdTTL: 300 });

// ── URL BUILDERS ──────────────────────────────────────────────────────────────
function buildApiUrl(storeId, query) {
  const q = encodeURIComponent(query);
  switch (storeId) {
    case 'usags':
      // Shopify AJAX API — clean JSON with prices and availability
      return `https://www.usagundamstore.com/search/suggest.json?q=${q}&resources[type]=product&resources[limit]=12&section_id=predictive-search`;
    case 'newtype':
      // ScraperAPI with JS rendering — Newtype is React/Next.js
      const newtypeUrl = `https://newtype.us/search?q=${q}&type=product`;
      return `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(newtypeUrl)}&country_code=us&render=true`;
    case 'gpros':
      // WooCommerce Store API — clean JSON with stock_status
      return `https://www.gundampros.shop/wp-json/wc/store/v1/products?search=${q}&per_page=12&status=publish`;
    default:
      return null;
  }
}

// ── FETCH ─────────────────────────────────────────────────────────────────────
async function fetchUrl(targetUrl, timeout = 15000) {
  const response = await axios.get(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/html, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Referer': 'https://www.google.com/'
    },
    timeout,
    maxRedirects: 5,
    validateStatus: () => true,
    responseType: 'text'
  });
  return { status: response.status, body: response.data };
}

// ── NEWTYPE HTML PARSER ───────────────────────────────────────────────────────
function parseNewtypeHTML(html) {
  const items = [];
  const seen = new Set();

  const linkRegex = /href="(\/p\/[^\/]+\/h\/([^"]+))"/g;
  const matches = [];
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const path = match[1];
    const slug = match[2];
    if (!seen.has(path)) { seen.add(path); matches.push({ path, slug }); }
  }
  if (!matches.length) return items;

  // Prices: <span>$XX</span>
  const priceRegex = /<span>\$([\d,]+(?:\.\d{1,2})?)<\/span>/g;
  const prices = [];
  let pm;
  while ((pm = priceRegex.exec(html)) !== null) prices.push(`$${pm[1]}`);

  // Stock tags
  const stockRegex = /stock-tag[^"]*"[^>]*>([^<]+)</g;
  const stocks = [];
  let sm;
  while ((sm = stockRegex.exec(html)) !== null) {
    const txt = sm[1].trim().toLowerCase();
    if (txt.includes('pre') || txt.includes('coming') || txt.includes('order')) stocks.push('Pre-order');
    else if (txt.includes('out') || txt.includes('sold')) stocks.push('Sin stock');
    else if (txt.includes('< 10') || txt.includes('low')) stocks.push('< 10 unid.');
    else stocks.push('En stock');
  }

  console.log(`[Newtype] products: ${matches.length}, prices: ${prices.length}, stocks: ${stocks.length}`);

  for (let i = 0; i < matches.length && items.length < 12; i++) {
    const { path, slug } = matches[i];
    const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    items.push({
      name,
      url: 'https://newtype.us' + path,
      price: prices[i] || '',
      stock: stocks[i] || 'En stock'
    });
  }
  return items;
}

// ── SERVER ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'Gunpla Scout API v8' }));
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
      const timeout = storeId === 'newtype' ? 30000 : 15000;
      const result = await fetchUrl(apiUrl, timeout);

      if (result.status !== 200) {
        const errData = { error: `HTTP ${result.status}` };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errData));
        return;
      }

      // ── NEWTYPE: HTML scraping ────────────────────────────────────────────
      if (storeId === 'newtype') {
        const html = typeof result.body === 'string' ? result.body : String(result.body);
        if (html.includes('cf-challenge') || html.includes('Just a moment')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cloudflare block' }));
          return;
        }
        const items = parseNewtypeHTML(html);
        const data = { items };
        cache.set(cacheKey, data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      // ── USAGS & GPROS: JSON APIs ──────────────────────────────────────────
      let jsonData;
      try {
        jsonData = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON from store' }));
        return;
      }

      const bodyStr = JSON.stringify(jsonData);
      if (bodyStr.includes('cf-challenge') || bodyStr.includes('Cloudflare') || bodyStr.includes('Attention Required')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cloudflare protection triggered' }));
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
  console.log(`Gunpla Scout API v8 running on port ${PORT}`);
});
