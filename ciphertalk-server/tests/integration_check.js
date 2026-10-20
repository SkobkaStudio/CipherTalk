const http = require('http');
const https = require('https');

async function request(opts, data) {
  return new Promise((resolve, reject) => {
    const lib = opts.protocol === 'https:' ? https : http;
    const req = lib.request(opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body, json: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, body, json: null }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(typeof data === 'string' ? data : JSON.stringify(data));
    req.end();
  });
}

async function run() {
  // health
  const health = await request({ hostname: 'localhost', port: 3000, path: '/api/health', method: 'GET' });
  console.log('HEALTH:', health.status, health.json && health.json.status);
  
  // search without auth should be 401
  const search = await request({ hostname: 'localhost', port: 3000, path: '/api/users/search?q=test', method: 'GET' });
  console.log('SEARCH_AUTH:', search.status);
  
  console.log('DONE');
}
run().catch(e => { console.error(e); process.exit(1); });
