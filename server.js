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
      // Scrape HTML search page to detect class="flag preorder"
      const usagsSearch = `https://www.usagundamstore.com/search?q=${q}&type=product`;
      return usagsSearch; // fetched directly, no scraper needed (Shopify allows it)
    case 'newtype':
      const newtypeSearch = `https://newtype.us/search?q=${q}&type=product`;
      return `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(newtypeSearch)}&country_code=us&render=true`;
    case 'gpros':
      // Scrape HTML search page to detect class="on-preorder"
      const gprosSearch = `https://www.gundampros.shop/?s=${q}&post_type=product`;
      return gprosSearch;
    default:
      return null;
  }
}

// ── FETCH ─────────────────────────────────────────────────────────────────────
async function fetchUrl(targetUrl, timeout = 20000) {
  const response = await axios.get(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/json,*/*',
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

// ── USAGS HTML PARSER ─────────────────────────────────────────────────────────
// Detects class="flag preorder" or class="related-stock preorder"
function parseUSAGSHTML(html) {
  const items = [];
  const seen = new Set();

  // Shopify search: products are in grid items with /products/ links
  // Split by product card boundaries
  const cardRegex = /href="(\/products\/([^"?#]+))"[^>]*>/g;
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    const path = match[1];
    const slug = match[2];
    if (seen.has(path)) continue;
    seen.add(path);

    const fullUrl = 'https://www.usagundamstore.com' + path;
    const block = html.slice(Math.max(0, match.index - 200), match.index + 2000);

    // Name: look for heading text near the link
    let name = '';
    const nameMatch = block.match(/class="[^"]*(?:card__heading|product[_-]title|product[_-]name|full-unstyled-link)[^"]*"[^>]*>(?:<[^>]+>)*([^<]{3,120})/i);
    if (nameMatch) {
      name = nameMatch[1].trim();
    } else {
      // Fallback: use slug
      name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    if (!name || name.length < 3) continue;

    // Price
    const priceMatch = block.match(/\$[\d,]+\.?\d*/);
    const price = priceMatch ? priceMatch[0] : '';

    // Stock — detect preorder class first, then sold out
    const blockLower = block.toLowerCase();
    let stock = 'En stock';
    if (blockLower.includes('flag preorder') || blockLower.includes('related-stock preorder') ||
        blockLower.includes('preorder') || blockLower.includes('pre-order')) {
      stock = 'Pre-order';
    } else if (blockLower.includes('sold-out') || blockLower.includes('sold_out') ||
               blockLower.includes('out-of-stock') || blockLower.includes('"sold out"') ||
               blockLower.includes('>sold out<') || blockLower.includes('badge--sold')) {
      stock = 'Sin stock';
    }

    items.push({ name, url: fullUrl, price, stock });
    if (items.length >= 12) break;
  }

  return items;
}

// ── GPROS HTML PARSER ─────────────────────────────────────────────────────────
// WooCommerce — detects class="onsale on-preorder" and outofstock
function parseGPROSHTML(html) {
  const items = [];
  const seen = new Set();

  // WooCommerce product cards: li.product with /product/ links
  const cardRegex = /href="(https?:\/\/www\.gundampros\.shop\/product\/([^"?#\/]+)\/?)"[^>]*>/g;
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    const fullUrl = match[1];
    const slug = match[2];
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    const block = html.slice(Math.max(0, match.index - 500), match.index + 2000);
    const blockLower = block.toLowerCase();

    // Name
    let name = '';
    const nameMatch = block.match(/class="[^"]*woocommerce-loop-product__title[^"]*"[^>]*>([^<]{3,120})/i);
    if (nameMatch) {
      name = nameMatch[1].trim();
    } else {
      name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    if (!name || name.length < 3) continue;

    // Price
    const priceMatch = block.match(/\$[\d,]+\.?\d*/);
    const price = priceMatch ? priceMatch[0] : '';

    // Stock — check preorder class first
    let stock = 'En stock';
    if (blockLower.includes('on-preorder') || blockLower.includes('preorder now') ||
        blockLower.includes('pre-order now') || blockLower.includes('class="onsale on-preorder"')) {
      stock = 'Pre-order';
    } else if (blockLower.includes('outofstock') || blockLower.includes('out-of-stock') ||
               blockLower.includes('out of stock')) {
      stock = 'Sin stock';
    }

    items.push({ name, url: fullUrl, price, stock });
    if (items.length >= 12) break;
  }

  return items;
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
    if (!seen.has(path)) {
      seen.add(path);
      matches.push({ path, slug, index: match.index });
    }
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

  for (let i = 0; i < matches.length && items.length < 12; i++) {
    const { path, slug } = matches[i];
    const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    if (!name || name.length < 3) continue;
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
    res.end(JSON.stringify({ status: 'ok', service: 'Gunpla Scout API v7' }));
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
      const timeout = storeId === 'newtype' ? 30000 : 12000;
      const result = await fetchUrl(apiUrl, timeout);

      if (result.status !== 200) {
        const errData = { error: `HTTP ${result.status}` };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errData));
        return;
      }

      const html = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);

      // Cloudflare check
      if (html.includes('cf-challenge') || html.includes('Just a moment') || html.includes('Attention Required')) {
        const errData = { error: 'Cloudflare block' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errData));
        return;
      }

      let items = [];
      if (storeId === 'usags') {
        items = parseUSAGSHTML(html);
        const pLinks = (html.match(/href="\/products\//g)||[]).length;
        const dollar = html.indexOf('$');
        console.log(`[USAGS] /products/ links: ${pLinks}, first $ at: ${dollar}`);
        if (dollar > -1) console.log(`[USAGS] price context: ${html.slice(Math.max(0,dollar-40),dollar+80).replace(/\n/g,' ')}`);
        console.log(`[USAGS] items found: ${items.length}`);
      }
      if (storeId === 'newtype') items = parseNewtypeHTML(html);
      if (storeId === 'gpros') {
        items = parseGPROSHTML(html);
        const pLinks = (html.match(/\/product\//g)||[]).length;
        const dollar = html.indexOf('$');
        console.log(`[GPROS] /product/ links: ${pLinks}, first $ at: ${dollar}`);
        if (dollar > -1) console.log(`[GPROS] price context: ${html.slice(Math.max(0,dollar-40),dollar+80).replace(/\n/g,' ')}`);
        console.log(`[GPROS] items found: ${items.length}`);
      }

      const data = { items };
      cache.set(cacheKey, data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));

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
  console.log(`Gunpla Scout API v7 running on port ${PORT}`);
});
