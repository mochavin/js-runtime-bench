// Deno: run with `deno serve`. With --parallel, Deno starts one isolate per CPU
// (or DENO_JOBS) and they share the listening socket.
import { connect, WORKERS } from './app.js';
import { handle } from './fetch.js';

await connect(WORKERS);

export default { fetch: handle };
