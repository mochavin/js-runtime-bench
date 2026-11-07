// Node.js: node:http. With WORKERS > 1 the cluster module forks one worker per
// CPU and the primary hands out connections round-robin (the Linux default).
import cluster from 'node:cluster';
import http from 'node:http';
import { connect, dispatch, PORT, RUNTIME, WORKERS } from './app.js';

if (WORKERS > 1 && cluster.isPrimary) {
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  cluster.on('exit', (w, code) => {
    console.error(`worker ${w.process.pid} exited (${code}), restarting`);
    cluster.fork();
  });
  console.log(`${RUNTIME}: primary started ${WORKERS} workers on :${PORT}`);
} else {
  await connect(WORKERS);

  const readJSON = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    const q = req.url.indexOf('?');
    const path = q === -1 ? req.url : req.url.slice(0, q);
    const [status, body] = await dispatch(req.method, path, () => readJSON(req));
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
    res.end(json);
  });
  server.listen(PORT, () => {
    if (WORKERS === 1) console.log(`${RUNTIME}: listening on :${PORT}`);
  });
}
