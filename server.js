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
      return `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(newtypeSearch)}&country_code=us&render=true`;
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
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: () => true,
    responseType: 'text'
  });
  return { status: response.status, body: response.data };
}

// ── NEWTYPE HTML PARSER ───────────────────────────────────────────────────────
// Newtype URL format: href="/p/PRODUCTID/h/product-slug"
// Price format: $<!-- -->19.99 or $19.99
function parseNewtypeHTML(html) {
  const items = [];
  const seen = new Set();

  // Match product links: /p/ID/h/slug
  const linkRegex = /href="(\/p\/[^\/]+\/h\/([^"]+))"/g;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const path  = match[1];
    const slug  = match[2]; // e.g. "mg-gn-003-gundam-kyrios"
    if (seen.has(path)) continue;
    seen.add(path);

    const fullUrl = 'https://newtype.us' + path;

    // Get surrounding block (1200 chars) to find name and price
    const block = html.slice(match.index, match.index + 1200);

    // Try to extract text name from anchor or nearby tag
    // Pattern 1: text directly after data-discover="true">
    let nameMatch = block.match(/data-discover="true">([^<]{3,120})</);
    // Pattern 2: any text-heavy tag near the link
    if (!nameMatch) nameMatch = block.match(/class="[^"]*title[^"]*"[^>]*>([^<]{3,120})</i);
    if (!nameMatch) nameMatch = block.match(/class="[^"]*name[^"]*"[^>]*>([^<]{3,120})</i);

    // Fallback: build name from slug (mg-gn-003-gundam-kyrios → MG GN-003 Gundam Kyrios)
    let name = nameMatch
      ? nameMatch[1].trim()
      : slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    if (!name || name.length < 3) continue;

    // Extract price — handles $19.99 and $<!-- -->19.99
    const priceMatch = block.match(/\$(?:<!--[^>]*-->)?(\d[\d,]*\.?\d*)/);
    const price = priceMatch ? `$${priceMatch[1]}` : '';

    // Stock detection
    const blockLower = block.toLowerCase();
    let stock = 'En stock';
    if (blockLower.includes('sold out') || blockLower.includes('out of stock')) {
      stock = 'Sin stock';
    } else if (blockLower.includes('pre-order') || blockLower.includes('coming soon')) {
      stock = 'Pre-order';
    } else if (blockLower.includes('< 10') || blockLower.includes('low stock')) {
      stock = '< 10 unid.';
    }

    // Debug price on first item only
    if (items.length === 0) {
      const priceArea = block.slice(0, 800);
      const dollarIdx = priceArea.indexOf('$');
      if (dollarIdx > -1) console.log(`[Newtype] Price area: ${priceArea.slice(Math.max(0,dollarIdx-30), dollarIdx+80).replace(/\n/g,' ')}`);
      else console.log('[Newtype] No $ found in first block');
    }
    items.push({ name, url: fullUrl, price, stock });
    if (items.length >= 12) break;
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

        console.log(`[Newtype] HTML length: ${html.length}`);
        // Look for /p/ links to confirm products loaded
        const pCount = (html.match(/href="\/p\//g) || []).length;
        console.log(`[Newtype] Product links found: ${pCount}`);
        if (pCount > 0) {
          const pIdx = html.indexOf('href="/p/');
          console.log(`[Newtype] First product: ${html.slice(pIdx, pIdx+300).replace(/\n/g,' ')}`);
        } else {
          const mid = Math.floor(html.length / 2);
          console.log(`[Newtype] Mid sample (no products): ${html.slice(mid, mid+400).replace(/\n/g,' ')}`);
        }

        // Check if Cloudflare blocked us
        if (html.includes('cf-challenge') || html.includes('Attention Required') || html.includes('Just a moment')) {
          console.log('[Newtype] BLOCKED by Cloudflare');
          const errData = { error: 'Cloudflare block — intentar más tarde' };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errData));
          return;
        }

        const items = parseNewtypeHTML(html);
        console.log(`[Newtype] Items found: ${items.length}`);
        if (items.length > 0) console.log(`[Newtype] First item: ${JSON.stringify(items[0])}`);

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
