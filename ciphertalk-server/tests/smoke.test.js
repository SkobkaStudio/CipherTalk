const http = require('http');
const App = require('../src/app');

jest.setTimeout(15000);

describe('CipherTalk smoke', () => {
  let server;
  beforeAll((done) => {
    const app = new App();
    server = app.start();
    const timer = setTimeout(() => {
      if (server.listening) done();
      else done(new Error('not listening'));
    }, 5000);
    server.on('listening', () => {
      clearTimeout(timer);
      done();
    });
  });
  afterAll((done) => {
    try {
      if (server && server.listening) {
        server.close(() => done());
      } else {
        done();
      }
    } catch (e) {
      done();
    }
  });
  test('health endpoint', (done) => {
    const port = server.address().port;
    http.get('http://127.0.0.1:' + port + '/api/health', (res) => {
      expect(res.statusCode).toBe(200);
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          expect(json.status).toBe('ok');
          done();
        } catch (e) {
          done(e);
        }
      });
    }).on('error', done);
  });
});
