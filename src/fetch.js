// Web-standard fetch handler, shared by Deno and Bun.
import { dispatch } from './app.js';

const HEADERS = { 'Content-Type': 'application/json' };

export async function handle(req) {
  const url = req.url;
  // Path without parsing the whole URL: skip "http://host".
  const start = url.indexOf('/', url.indexOf('//') + 2);
  const q = url.indexOf('?', start);
  const path = q === -1 ? url.slice(start) : url.slice(start, q);
  const [status, body] = await dispatch(req.method, path, () => req.json());
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}
