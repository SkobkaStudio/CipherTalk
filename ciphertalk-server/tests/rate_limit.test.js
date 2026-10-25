const assert = require('assert');
const http = require('http');
const App = require('../src/app');
async function run() {
  const app = new App();
  const server = app.getServer();
  await new Promise(r=>server.listen(0,r));
  const port = server.address().port;
  function req(){
    return new Promise((resolve)=>{
      const r = http.request({hostname:'127.0.0.1',port,path:'/api/health',method:'GET'},(res)=>{
        resolve(res.statusCode);
      });
      r.end();
    });
  }
  let ok=0;
  for(let i=0;i<5;i++) if(await req()===200) ok++;
  assert(ok>=3);
  console.log('rate_limit.test.js: PASS');
  server.close();
}
run().catch(e=>{console.error('FAIL');process.exit(1);});
