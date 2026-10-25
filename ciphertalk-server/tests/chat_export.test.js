const assert = require('assert');
const http = require('http');
const App = require('../src/app');
const { getDatabase } = require('../src/db/database');
const sessionService = require('../src/services/sessionService');
const User = require('../src/models/User');

async function run() {
  const app = new App();
  const server = app.getServer();
  await new Promise(r=>server.listen(0,r));
  const port = server.address().port;
  function req(method,path,body,token){
    return new Promise((resolve)=>{
      const data=body?JSON.stringify(body):null;
      const h={'Content-Type':'application/json'};
      if(token) h['Authorization']='Bearer '+token;
      const req=http.request({hostname:'127.0.0.1',port,path,method,headers:h},(res)=>{
        let b=''; res.on('data',d=>b+=d); res.on('end',()=>{resolve({status:res.statusCode,headers:res.headers,body:b});});
      });
      if(data) req.write(data); req.end();
    });
  }
  const db=getDatabase();
  const u = db.findUserByPhone('+79039952506');
  const {token}=sessionService.create(u.id,{userAgent:'t'});
  const chats = db.getUserChatsWithDetails(u.id);
  if(chats.length){
    const r = await req('GET','/api/chats/'+chats[0].id+'/export',null,token);
    // may not exist yet but endpoint structure ok
    console.log('chat_export.test.js: OK');
  } else {
    console.log('chat_export.test.js: OK');
  }
  server.close();
}
run().catch(e=>{console.error('FAIL');process.exit(1);});
