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
// USAGS Shopify search page structure:
// - Links: href="/products/slug" class="full-unstyled-link"
// - Name: in card__heading > a tag after the image block  
// - Price: collected separately in order like Newtype
// - Stock: class="badge--sold-out" or class="flag preorder"
function parseUSAGSHTML(html) {
  const items = [];
  const seen = new Set();

  // 1. Collect all product slugs in order (skip duplicates)
  const linkRegex = /href="(\/products\/([^"?#\/]+))"/g;
  const matches = [];
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const path = match[1];
    const slug = match[2];
    // Skip non-product links (collections, pages, etc)
    if (slug.includes('.') || slug.length < 3) continue;
    if (!seen.has(path)) {
      seen.add(path);
      matches.push({ path, slug, index: match.index });
    }
  }

  // 2. Collect all prices in order: $XX.XX patterns in product cards
  // Shopify uses class="price-item" or data-price
  const priceRegex = /class="price-item[^"]*"[^>]*>\s*\$([\d,]+\.?\d*)/g;
  const prices = [];
  let pm;
  while ((pm = priceRegex.exec(html)) !== null) prices.push(`$${pm[1]}`);

  // Fallback: money spans
  if (!prices.length) {
    const moneyRegex = /<span class="money">\$([\d,]+\.?\d*)<\/span>/g;
    while ((pm = moneyRegex.exec(html)) !== null) prices.push(`$${pm[1]}`);
  }

  // 3. Stock: collect badge/flag classes in order
  const stocks = [];
  // sold out badges
  const soldRegex = /class="[^"]*badge[^"]*"[^>]*>([^<]+)</g;
  let sm;
  while ((sm = soldRegex.exec(html)) !== null) {
    const txt = sm[1].trim().toLowerCase();
    if (txt.includes('sold out') || txt.includes('unavailable')) stocks.push('Sin stock');
    else if (txt.includes('pre') || txt.includes('coming soon')) stocks.push('Pre-order');
    else if (txt.includes('sale') || txt.includes('new')) continue; // skip non-stock badges
    else stocks.push('En stock');
  }

  for (let i = 0; i < matches.length && items.length < 12; i++) {
    const { path, slug } = matches[i];
    const fullUrl = 'https://www.usagundamstore.com' + path;
    const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const price = prices[i] || '';
    const stock = stocks[i] || 'En stock';
    items.push({ name, url: fullUrl, price, stock });
  }

  return items;
}

// ── GPROS HTML PARSER ─────────────────────────────────────────────────────────
// WooCommerce search page structure:
// - Cards: li.product or li[class*="product"]
// - Name: .woocommerce-loop-product__title
// - Price: .price .amount (inside each card)
// - Stock: li.outofstock class, or span.onsale with on-preorder
function parseGPROSHTML(html) {
  const items = [];

  // Split HTML into product card blocks using WooCommerce li.product boundaries
  // Each card starts at <li class="...product..."
  const cardSplitRegex = /<li[^>]+class="[^"]*(?:type-product|product-type)[^"]*"[^>]*>/g;
  const cardStarts = [];
  let cm;
  while ((cm = cardSplitRegex.exec(html)) !== null) {
    cardStarts.push(cm.index);
  }

  for (let i = 0; i < cardStarts.length && items.length < 12; i++) {
    const start = cardStarts[i];
    const end = cardStarts[i + 1] || start + 3000;
    const card = html.slice(start, end);
    const cardLower = card.toLowerCase();

    // URL and slug
    const urlMatch = card.match(/href="(https?:\/\/www\.gundampros\.shop\/product\/([^"?#\/]+)\/?)"/)
    if (!urlMatch) continue;
    const fullUrl = urlMatch[1];
    const slug = urlMatch[2];

    // Name
    let name = '';
    const nameMatch = card.match(/class="[^"]*woocommerce-loop-product__title[^"]*"[^>]*>([^<]{3,120})/i);
    name = nameMatch ? nameMatch[1].trim() : slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    if (!name || name.length < 3) continue;

    // Price — look for .amount span inside .price
    const priceMatch = card.match(/<span class="[^"]*amount[^"]*"[^>]*>\$([\d,]+\.?\d*)<\/span>/);
    const price = priceMatch ? `$${priceMatch[1]}` : '';

    // Stock
    let stock = 'En stock';
    if (cardLower.includes('on-preorder') || cardLower.includes('preorder now') || cardLower.includes('pre-order now')) {
      stock = 'Pre-order';
    } else if (card.includes('outofstock') || cardLower.includes('out of stock')) {
      stock = 'Sin stock';
    }

    items.push({ name, url: fullUrl, price, stock });
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
        // Find first /products/ link and show 800 chars of context
        const pidx = html.indexOf('href="/products/');
        if (pidx > -1) console.log(`[USAGS] first product block: ${html.slice(pidx, pidx+800).replace(/\n/g,' ')}`);
        // Find price after position 5000 (skip head section)
        const bodyHtml = html.slice(5000);
        const d2 = bodyHtml.indexOf('$');
        if (d2 > -1) console.log(`[USAGS] first body $: ${bodyHtml.slice(Math.max(0,d2-30),d2+100).replace(/\n/g,' ')}`);
        console.log(`[USAGS] items found: ${items.length}`);
      }
      if (storeId === 'newtype') items = parseNewtypeHTML(html);
      if (storeId === 'gpros') {
        items = parseGPROSHTML(html);
        const pidx2 = html.indexOf('/product/');
        if (pidx2 > -1) console.log(`[GPROS] first product block: ${html.slice(Math.max(0,pidx2-200), pidx2+800).replace(/\n/g,' ')}`);
        console.log(`[GPROS] items found: ${items.length}, first: ${JSON.stringify(items[0]||{})}`);
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
