// Builds the benchmark results page from k6 JSON summaries. Node built-ins only.
//
//   node report/build.mjs [--in results] [--go dir] [--php dir] [--date YYYY-MM-DD] [--out benchmark-report.html]
//
// For each runtime it uses <in>/<key>.json, or else the newest <in>/<key>_*.json.
// --go and --php point at summaries from go-framework-bench and
// fpm-vs-swoole-vs-franken, shown as a reference.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string', default: 'results' },
    go: { type: 'string' },
    php: { type: 'string' },
    out: { type: 'string', default: 'benchmark-report.html' },
    date: { type: 'string', default: new Date().toISOString().slice(0, 10) },
  },
});

// hue picks the color family on the page; multi marks one-worker-per-CPU variants.
const JS = [
  { key: 'node', label: 'Node.js', detail: 'node:http, 1 process', hue: 'node', multi: false },
  { key: 'node-cluster', label: 'Node.js cluster', detail: 'node:cluster, 1 worker per CPU', hue: 'node', multi: true },
  { key: 'deno', label: 'Deno', detail: 'deno serve, 1 isolate', hue: 'deno', multi: false },
  { key: 'deno-parallel', label: 'Deno --parallel', detail: 'deno serve --parallel, 1 isolate per CPU', hue: 'deno', multi: true },
  { key: 'bun', label: 'Bun', detail: 'Bun.serve, 1 process', hue: 'bun', multi: false },
  { key: 'bun-reuseport', label: 'Bun reusePort', detail: 'Bun.serve, 1 process per CPU, SO_REUSEPORT', hue: 'bun', multi: true },
];
const GO = [
  { key: 'stdlib', label: 'Go net/http', detail: 'Go standard library' },
  { key: 'chi', label: 'Go Chi', detail: 'go-chi/chi v5' },
  { key: 'gin', label: 'Go Gin', detail: 'gin-gonic/gin' },
  { key: 'echo', label: 'Go Echo', detail: 'labstack/echo v4' },
  { key: 'fiber', label: 'Go Fiber', detail: 'gofiber/fiber v2 (fasthttp)' },
].map((r) => ({ ...r, hue: 'go', multi: true }));
const PHP = [
  { key: 'fpm', label: 'PHP-FPM', detail: 'Nginx + PHP-FPM 8.3' },
  { key: 'swoole', label: 'Swoole', detail: 'Laravel Octane + Swoole' },
  { key: 'franken', label: 'FrankenPHP', detail: 'Laravel Octane + FrankenPHP' },
].map((r) => ({ ...r, hue: 'php', multi: true }));

const SCENARIOS = [
  { key: 'health_check', label: 'Health check', vus: '5000', trend: 'health_duration' },
  { key: 'read_posts', label: 'List 20 posts', vus: '1000 ramp', trend: 'list_posts_duration' },
  { key: 'single_post', label: 'Single post', vus: '3000', trend: 'single_post_duration' },
  { key: 'write_posts', label: 'Create post', vus: '2000', trend: 'create_post_duration' },
  { key: 'heavy_compute', label: 'Heavy compute', vus: '2000', trend: 'heavy_duration' },
];

function findSummary(dir, key) {
  const exact = join(dir, `${key}.json`);
  if (existsSync(exact)) return exact;
  if (!existsSync(dir)) return null;
  // `node_` must not match `node-cluster_`: the key is followed by _ and an ISO timestamp.
  const re = new RegExp(`^${key.replace(/[-]/g, '\\-')}_\\d{4}-.*\\.json$`);
  const files = readdirSync(dir).filter((f) => re.test(f)).sort(); // ISO timestamps sort chronologically
  return files.length ? join(dir, files.at(-1)) : null;
}

function load(dir, runtimes) {
  const rows = [];
  for (const rt of runtimes) {
    const path = findSummary(dir, rt.key);
    if (!path) continue;
    const { metrics: m } = JSON.parse(readFileSync(path, 'utf8'));
    const val = (metric, k) => m[metric]?.values?.[k] ?? 0;
    // Successful responses only; failed connections report ~0 ms.
    const ok = m['http_req_duration{expected_response:true}'] ? 'http_req_duration{expected_response:true}' : 'http_req_duration';
    rows.push({
      ...rt,
      source: basename(path),
      reqs: val('http_reqs', 'count'),
      rps: val('http_reqs', 'rate'),
      failed: val('http_req_failed', 'rate') * 100,
      avg: val(ok, 'avg'),
      p95: val(ok, 'p(95)'),
      scenAvg: SCENARIOS.map((s) => val(s.trend, 'avg')),
      scenP95: SCENARIOS.map((s) => val(s.trend, 'p(95)')),
    });
  }
  return rows;
}

const js = load(args.in, JS);
if (!js.length) {
  console.error(`no k6 summaries found in ${args.in}`);
  process.exit(1);
}
const go = args.go ? load(args.go, GO) : [];
const php = args.php ? load(args.php, PHP) : [];

const data = JSON.stringify({
  js, go, php, date: args.date,
  scenarios: SCENARIOS.map(({ key, label, vus }) => ({ key, label, vus })),
}).replace(/</g, '\\u003c'); // the data must not be able to close the <script> tag

const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'page.html'), 'utf8');
writeFileSync(args.out, template.replace('/*DATA*/null', () => data));
console.log(`wrote ${args.out} (${[...js, ...go, ...php].map((r) => r.key).join(', ')})`);
