// Bun: Bun.serve. With WORKERS > 1 this process spawns one child per CPU, each
// listening on the same port with SO_REUSEPORT so the kernel spreads connections.
import { connect, PORT, RUNTIME, WORKERS } from './app.js';
import { handle } from './fetch.js';

if (WORKERS > 1 && !process.env.BUN_WORKER) {
  const spawn = () => Bun.spawn(['bun', import.meta.path], {
    env: { ...process.env, BUN_WORKER: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
    onExit(proc, code) {
      console.error(`worker ${proc.pid} exited (${code}), restarting`);
      spawn();
    },
  });
  for (let i = 0; i < WORKERS; i++) spawn();
  console.log(`${RUNTIME}: started ${WORKERS} workers on :${PORT}`);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
} else {
  await connect(WORKERS);
  Bun.serve({ port: PORT, reusePort: WORKERS > 1, fetch: handle });
  if (WORKERS === 1) console.log(`${RUNTIME}: listening on :${PORT}`);
}
