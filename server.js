const http  = require('http');
const url   = require('url');
const axios = require('axios');
const NodeCache = require('node-cache');

const PORT = process.env.PORT || 3000;

// Cache for 5 minutes
const cache = new NodeCache({ stdTTL: 300 });

function buildApiUrl(storeId, query) {
  const q = encodeURIComponent(query);

  switch (storeId) {

    // USA Gundam Store
    case 'usags':
      return `https://www.usagundamstore.com/search/suggest.json?q=${q}&resources[type]=product&resources[limit]=12&section_id=predictive-search`;

    // GundamPros WooCommerce API
    case 'gpros':
      return `https://www.gundampros.shop/wp-json/wc/store/v1/products?search=${q}&per_page=12&status=publish`;

    default:
      return null;
  }
}

async function fetchUrl(targetUrl) {

  const response = await axios.get(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': 'https://www.google.com/'
    },
    timeout: 10000,
    maxRedirects: 5,
    validateStatus: () => true
  });

  return {
    status: response.status,
    body: response.data
  };
}

const server = http.createServer(async (req, res) => {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/' || req.url === '/health') {

    res.writeHead(200, {
      'Content-Type': 'application/json'
    });

    res.end(JSON.stringify({
      status: 'ok',
      service: 'Gunpla Scout API v4'
    }));

    return;
  }

  // Search endpoint
  if (req.url.startsWith('/search')) {

    const params = url.parse(req.url, true).query;

    const storeId = params.store;
    const query   = params.q;

    if (!storeId || !query) {

      res.writeHead(400, {
        'Content-Type': 'application/json'
      });

      res.end(JSON.stringify({
        error: 'Missing store or q parameter'
      }));

      return;
    }

    // CACHE KEY
    const cacheKey = `${storeId}:${query.toLowerCase()}`;

    // RETURN CACHE IF EXISTS
    const cached = cache.get(cacheKey);

    if (cached) {

      res.writeHead(200, {
        'Content-Type': 'application/json'
      });

      res.end(JSON.stringify(cached));
      return;
    }

    const apiUrl = buildApiUrl(storeId, query);

    if (!apiUrl) {

      res.writeHead(400, {
        'Content-Type': 'application/json'
      });

      res.end(JSON.stringify({
        error: 'Unknown store'
      }));

      return;
    }

    try {

      const result = await fetchUrl(apiUrl);

      // Detect Cloudflare block
      const bodyString = JSON.stringify(result.body);

      if (
        bodyString.includes('cf-challenge') ||
        bodyString.includes('Cloudflare') ||
        bodyString.includes('Attention Required')
      ) {

        const errorData = {
          error: 'Cloudflare protection triggered'
        };

        cache.set(cacheKey, errorData);

        res.writeHead(200, {
          'Content-Type': 'application/json'
        });

        res.end(JSON.stringify(errorData));
        return;
      }

      // HTTP ERROR
      if (result.status !== 200) {

        const errorData = {
          error: `HTTP ${result.status}`
        };

        cache.set(cacheKey, errorData);

        res.writeHead(200, {
          'Content-Type': 'application/json'
        });

        res.end(JSON.stringify(errorData));
        return;
      }

      // SAVE TO CACHE
      cache.set(cacheKey, result.body);

      res.writeHead(200, {
        'Content-Type': 'application/json'
      });

      res.end(JSON.stringify(result.body));

    } catch (e) {

      res.writeHead(200, {
        'Content-Type': 'application/json'
      });

      res.end(JSON.stringify({
        error: e.message
      }));
    }

    return;
  }

  // 404
  res.writeHead(404, {
    'Content-Type': 'application/json'
  });

  res.end(JSON.stringify({
    error: 'Not found'
  }));
});

server.listen(PORT, () => {
  console.log(`Gunpla Scout API v4 running on port ${PORT}`);
});
