// A stand-in for POST /v1/images/generations: logs what it was sent, answers
// with a PNG (or, in FAKE_OPENAI_MODE=refuse, the API's error shape).
const http = require('node:http');
const fs = require('node:fs');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; }).on('end', () => {
    fs.appendFileSync(process.env.FAKE_OPENAI_LOG, JSON.stringify({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') }) + '\n');
    const mode = fs.existsSync(process.env.FAKE_OPENAI_MODE_FILE) ? fs.readFileSync(process.env.FAKE_OPENAI_MODE_FILE, 'utf8').trim() : 'ok';
    res.setHeader('content-type', 'application/json');
    if (mode === 'refuse') { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'Your request was rejected by the safety system.' } })); return; }
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }));
  });
}).listen(Number(process.env.PORT), '127.0.0.1');
