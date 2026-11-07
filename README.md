# JS Runtime Benchmark: Node.js vs Deno vs Bun

**Results page:** https://mochavin.github.io/js-runtime-bench/

The same benchmark app as [fpm-vs-swoole-vs-franken](https://github.com/mochavin/fpm-vs-swoole-vs-franken) and [go-framework-bench](https://github.com/mochavin/go-framework-bench), rewritten in JavaScript and run on three runtimes. Same endpoints, same Postgres schema, same [k6](https://k6.io/) scenarios, all in Docker Compose.

Each runtime runs in two modes:

- **Single process**: one JavaScript thread, as you get from `node app.js`, `deno serve` or `bun app.js`.
- **One worker per CPU**: the runtime's own way to use every core. Go and the PHP runtimes use all cores by default, so this is the like-for-like comparison with them.

## Latest Results (2026-11-07)

Run on the same 4 vCPU Azure VM as the PHP and Go benchmarks, with the same k6 scenarios ([test machine](#test-machine)). Raw k6 summaries and the HTML report are in [`benchmarks/2026-11-07_azure-d4as-v6/`](benchmarks/2026-11-07_azure-d4as-v6/), along with the Go and PHP summaries used as a reference.

### Overall

| Metric | node | node-cluster | deno | deno-parallel | bun | bun-reuseport |
|---|---:|---:|---:|---:|---:|---:|
| Workers | 1 | 4 | 1 | 4 | 1 | 4 |
| Total requests | 1,157,701 | 1,165,236 | 1,311,598 | 1,234,637 | **1,322,431** | 1,250,299 |
| Throughput (req/s) | 5,337 | 5,589 | 6,086 | 5,936 | **6,288** | 6,107 |
| Failed requests | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| Avg latency (ms) | 179.3 | 150.0 | 145.0 | 138.9 | 136.2 | **133.1** |
| p95 latency (ms) | 306.3 | 245.9 | **210.8** | 232.1 | 224.9 | 241.3 |

### Per scenario: avg / p95 latency (ms)

| Scenario | VUs | node | node-cluster | deno | deno-parallel | bun | bun-reuseport |
|---|---:|---:|---:|---:|---:|---:|---:|
| Health check (no DB) | 5000 | 133 / 294 | 153 / 286 | 107 / **216** | 136 / 272 | **106** / 246 | 132 / 264 |
| List 20 posts (DB read) | 1000 ramp | 14.6 / 66.5 | 9.3 / 50.3 | 13.0 / 63.3 | 9.5 / 50.0 | **8.7 / 44.4** | 9.6 / 49.9 |
| Single post (DB read) | 3000 | 235 / 414 | 110 / 240 | 148 / 261 | **103 / 222** | 141 / 244 | 107 / 223 |
| Create post (DB write) | 2000 | 16.7 / 59.1 | 17.2 / 65.7 | 14.0 / 58.4 | 14.7 / 67.4 | **11.8 / 45.5** | 16.2 / 72.9 |
| Heavy compute (CPU) | 2000 | 13,402 / 37,862 | 7,185 / 35,731 | 12,464 / 15,042 | 6,610 / 8,652 | 8,652 / 10,000 | **3,928 / 7,517** |

### Takeaways

- **The machine sets the ceiling, not the runtime.** All six JS variants land between 5,337 and 6,288 req/s, and the five Go frameworks between 5,772 and 6,170. k6 runs 5000 VUs on the same 4 vCPUs as the server and Postgres, so for the light endpoints the load generator is the bottleneck.
- **Single process: Bun > Deno > Node.js.** Bun 6,288 req/s, Deno 6,086, Node.js 5,337. With one JavaScript thread each, the HTTP layer and event loop are what differ.
- **A worker per CPU helps CPU work, not req/s.** Overall throughput barely moves (Node.js +5%, Deno −2%, Bun −3%) because k6 needs those cores too. Heavy-compute latency drops by about half: Node.js 13.4 → 7.2 s, Deno 12.5 → 6.6 s, Bun 8.7 → 3.9 s.
- **Node.js cluster has a long heavy-compute tail** (p95 35.7 s vs 8.7 s for Deno `--parallel` and 7.5 s for Bun reusePort). One fibonacci(30) blocks a worker's event loop, and requests queued on that worker wait behind it.
- **JS vs Go:** Bun's 6,288 req/s matches Go Fiber's 6,170 on this machine, but Go is still faster on CPU work: 2.8 s average on the heavy scenario vs 3.9 s for the fastest JS variant.
- **JS vs PHP:** even the slowest JS variant (single-process Node.js, 5,337 req/s) has ~7× the throughput of the fastest PHP runtime, FrankenPHP (771 req/s).

### Test machine

| | |
|---|---|
| Host | Azure `Standard_D4as_v6` |
| CPU | AMD EPYC 9V74, 4 vCPU (2 cores × 2 threads) |
| RAM | 15.6 GiB, no swap |
| OS | Ubuntu 24.04.5 LTS, kernel 7.0.0-1017-azure |
| Docker | Engine 29.1.3, Compose 2.40.3 |
| Runtimes | Node.js 26.13.0 (`node:26.13.0-slim`), Deno 2.9.8 (`denoland/deno:debian-2.9.8`), Bun 1.4.4 (`oven/bun:1.4.4-slim`) |
| Driver | postgres.js 4.1.0 on all three |
| Database | PostgreSQL 16 (alpine), `max_connections=400` |
| Load generator | k6 v2.3.0, **on the same machine** as the servers |

## Runtimes

| Variant | Host port | Server | Workers |
|---|---|---|---|
| **node** | 8001 | `node:http` | 1 |
| **node-cluster** | 8002 | `node:http` + `node:cluster` (primary distributes connections round-robin) | 1 per CPU |
| **deno** | 8003 | `deno serve` | 1 |
| **deno-parallel** | 8004 | `deno serve --parallel` (one isolate per CPU, shared socket) | 1 per CPU |
| **bun** | 8005 | `Bun.serve` | 1 |
| **bun-reuseport** | 8006 | `Bun.serve({ reusePort: true })`, one process per CPU, kernel load-balances | 1 per CPU |

Everything except the HTTP server lives in [`src/app.js`](src/app.js): routing, Postgres access, validation and the CPU workload. It uses only `node:` built-ins and [postgres.js](https://github.com/porsager/postgres), so the same file runs unchanged on all three runtimes. The entry points ([`node.js`](src/node.js), [`deno.js`](src/deno.js), [`bun.js`](src/bun.js)) only adapt their server to it. Deno and Bun share a Web-standard `fetch` handler ([`fetch.js`](src/fetch.js)).

All variants share one PostgreSQL 16 database. Each container has 50 database connections in total (`DB_MAX_CONNS`, the same as the Go apps), split across its workers. Postgres runs with `max_connections=400`.

## Quick Start

Only Docker with Compose v2 is needed. The runtimes run inside containers.

```bash
git clone https://github.com/mochavin/js-runtime-bench
cd js-runtime-bench

docker compose up -d --build
curl http://localhost:8005/api/health
# {"status":"ok","runtime":"bun","timestamp":"..."}
```

Each app creates the `posts` table and seeds 100 posts on startup (an advisory lock makes sure only one of them seeds).

### Run the benchmark

```bash
bash run-bench.sh                  # all six variants, ~25 minutes
bash run-bench.sh bun deno         # only some
```

The runner builds, starts, smoke-tests, benchmarks each variant in turn with a 10 s cooldown, then writes `benchmark-report.html`.

Manual run for one variant:

```bash
docker compose --profile bench run --rm \
  -e BASE_URL=http://app-bun:8000 -e RUNTIME=bun \
  k6 run /scripts/benchmark.js
```

Rebuild the report from `results/`:

```bash
docker run --rm -v "$PWD:/src" -w /src node:26.13.0-slim node report/build.mjs
```

Flags: `--in <dir>` (k6 summaries), `--go <dir>` and `--php <dir>` (summaries from the Go and PHP projects, shown as a reference), `--date`, `--out`. The published page is built with:

```bash
d=benchmarks/2026-11-07_azure-d4as-v6
node report/build.mjs --in $d --go $d/go --php $d/php --date 2026-11-07 --out $d/benchmark-report.html
```

GitHub Pages serves the `result` branch, whose `index.html` is a copy of that report.

## Endpoints

Same as the Laravel and Go versions, with the same JSON shapes.

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | `{"status":"ok","runtime":...,"timestamp":...}`, no DB |
| `/api/posts` | GET | 20 latest posts (`ORDER BY created_at DESC LIMIT 20`) |
| `/api/posts/{id}` | GET | One post, 404 if missing |
| `/api/posts` | POST | Create a post; Laravel's rules (`title` required, max 255; `body` required), 422 on error |
| `/api/heavy` | GET | Recursive fibonacci(30) + 100 md5 hashes + JSON round trip |

## k6 Scenarios

`k6/benchmark.js` is copied unchanged from the PHP and Go projects.

| Scenario | VUs | Duration | Start |
|---|---|---|---|
| `health_check` | 5000 constant | 30s | 0s |
| `read_posts` | 1000 → 500 → 1000 → 0 | 60s | 35s |
| `single_post` | 3000 constant | 30s | 100s |
| `write_posts` | 2000 constant | 30s | 135s |
| `heavy_compute` | 2000 constant | 30s | 170s |

Latency counts successful responses only (`http_req_duration{expected_response:true}`); failed connections report ~0 ms and would make a struggling server look fast.

## Fairness Notes

- Same app code, same Postgres driver (postgres.js 4.1.0, installed once by `npm ci` and copied into every image), same total connection count per app.
- Containers get `nofile` 65535, as in the PHP and Go projects. No request logging.
- k6 runs on the same machine as the servers and Postgres, so they all share the CPUs. Numbers are comparable to each other and to the PHP and Go projects on the same VM, not to a dedicated setup.
- `run-bench.sh` resets `posts` to the 100 seeded rows before each variant, so every variant starts from the same data.
- Variants run one at a time, but all containers stay up during every run.

## Project Structure

```
├── src/
│   ├── app.js                 # shared routing, DB, validation, workload
│   ├── fetch.js               # Web fetch handler (Deno, Bun)
│   └── node.js deno.js bun.js # one entry point per runtime
├── report/                    # builds the results page (build.mjs + page.html)
├── k6/benchmark.js, smoke.js
├── benchmarks/                # committed result summaries (+ Go and PHP references)
├── Dockerfile                 # targets: node, deno, bun
├── docker-compose.yml
└── run-bench.sh
```

## Cleanup

```bash
docker compose down -v            # containers + database volume
docker compose down -v --rmi all  # also images
```
