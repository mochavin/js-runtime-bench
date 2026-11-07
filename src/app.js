// Everything the runtimes share: config, database access, routing, validation
// and the CPU workload. Each src/<runtime>.js only adapts its own HTTP server
// to dispatch(), so the benchmark compares the runtimes and nothing else.
//
// Only node: built-ins and the `postgres` package are used, so the same file
// runs unchanged on Node.js, Deno and Bun.
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import process from 'node:process';
import postgres from 'postgres';

const env = (key, def) => process.env[key] || def;

export const RUNTIME = env('APP_RUNTIME', 'unknown');
export const PORT = Number(env('PORT', '8000'));

// WORKERS=auto means one process per CPU. Single-process variants set WORKERS=1.
export const WORKERS = env('WORKERS', 'auto') === 'auto'
  ? availableParallelism()
  : Math.max(1, Number(env('WORKERS', '1')));

// Every container gets DB_MAX_CONNS connections in total (50 by default, like
// the Go apps), split across its worker processes.
export function poolSize(workers) {
  return Math.max(1, Math.ceil(Number(env('DB_MAX_CONNS', '50')) / workers));
}

let sql;

// connect opens the pool and runs the migration. Call it once per process that
// serves requests; launcher processes that only fork workers never call it.
export async function connect(workers = 1) {
  sql = postgres({
    host: env('DB_HOST', 'localhost'),
    port: Number(env('DB_PORT', '5432')),
    database: env('DB_DATABASE', 'js_bench'),
    username: env('DB_USERNAME', 'bench'),
    password: env('DB_PASSWORD', 'secret'),
    max: poolSize(workers),
    onnotice: () => {},
  });

  for (let i = 0; ; i++) {
    try {
      await migrate();
      return;
    } catch (err) {
      if (i >= 30) throw err;
      console.log(`waiting for database: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// migrate mirrors the Laravel posts migration. An advisory lock stops the
// containers and workers, which all start at once, from seeding twice.
async function migrate() {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(42)`;
    await tx`CREATE TABLE IF NOT EXISTS posts (
      id         BIGSERIAL PRIMARY KEY,
      title      VARCHAR(255) NOT NULL,
      body       TEXT NOT NULL,
      created_at TIMESTAMP(0) NULL,
      updated_at TIMESTAMP(0) NULL
    )`;
    const [{ n }] = await tx`SELECT count(*)::int AS n FROM posts`;
    if (n > 0) return;

    const now = new Date();
    const rows = Array.from({ length: 100 }, () => ({
      title: sentence(), body: paragraphs(3), created_at: now, updated_at: now,
    }));
    await tx`INSERT INTO posts ${tx(rows, 'title', 'body', 'created_at', 'updated_at')}`;
    console.log('seeded 100 posts');
  });
}

// ─── Queries ──────────────────────────────────────────────

// Matches Laravel's Post::latest()->limit(20)->get().
const latestPosts = () =>
  sql`SELECT id, title, body, created_at, updated_at FROM posts ORDER BY created_at DESC LIMIT 20`;

async function findPost(id) {
  const [post] = await sql`SELECT id, title, body, created_at, updated_at FROM posts WHERE id = ${id}`;
  return post;
}

async function createPost(title, body) {
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const [post] = await sql`
    INSERT INTO posts (title, body, created_at, updated_at)
    VALUES (${title}, ${body}, ${now}, ${now})
    RETURNING id, title, body, created_at, updated_at`;
  return post;
}

// BIGSERIAL comes back as a string; the API returns numbers like the Go and PHP apps.
const toJSON = (p) => ({ ...p, id: Number(p.id) });

// ─── Validation ───────────────────────────────────────────

// Laravel's rules: title required|string|max:255, body required|string.
// Returns null when valid, otherwise a 422 body in Laravel's shape.
export function validate(input) {
  const errors = {};
  const { title, body } = input && typeof input === 'object' ? input : {};
  if (title == null || (typeof title === 'string' && title.trim() === '')) {
    errors.title = ['The title field is required.'];
  } else if (typeof title !== 'string') {
    errors.title = ['The title field must be a string.'];
  } else if ([...title].length > 255) {
    errors.title = ['The title field must not be greater than 255 characters.'];
  }
  if (body == null || (typeof body === 'string' && body.trim() === '')) {
    errors.body = ['The body field is required.'];
  } else if (typeof body !== 'string') {
    errors.body = ['The body field must be a string.'];
  }
  return Object.keys(errors).length ? { message: 'The given data was invalid.', errors } : null;
}

// ─── Workload ─────────────────────────────────────────────

function fib(n) {
  return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}

// Same CPU work as the Laravel and Go /api/heavy routes:
// recursive fibonacci(30) plus 100 md5 hashes and a JSON round trip.
export function heavy() {
  const result = fib(30);
  const data = [];
  for (let i = 0; i < 100; i++) {
    data.push({ index: i, value: createHash('md5').update(String(i)).digest('hex'), nested: { a: i * 2, b: i * 3 } });
  }
  JSON.parse(JSON.stringify(data));
  return { fibonacci_30: result, iterations: 100, status: 'computed' };
}

// ─── Routing ──────────────────────────────────────────────

const NOT_FOUND = { message: 'Not found.' };
const SERVER_ERROR = { message: 'Server Error' };
const INVALID_JSON = { message: 'Invalid JSON body.' };

// dispatch handles one request and resolves to [status, body]. readJSON is the
// runtime's own body parser; it is only called for POST /api/posts.
export async function dispatch(method, path, readJSON) {
  try {
    if (path === '/api/health' && method === 'GET') {
      return [200, { status: 'ok', runtime: RUNTIME, timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }];
    }
    if (path === '/api/posts') {
      if (method === 'GET') {
        const posts = (await latestPosts()).map(toJSON);
        return [200, { data: posts, count: posts.length }];
      }
      if (method === 'POST') {
        let input;
        try {
          input = await readJSON();
        } catch {
          return [400, INVALID_JSON];
        }
        const errors = validate(input);
        if (errors) return [422, errors];
        return [201, { data: toJSON(await createPost(input.title, input.body)) }];
      }
    }
    if (path.startsWith('/api/posts/') && method === 'GET') {
      const raw = path.slice('/api/posts/'.length);
      if (!/^\d{1,18}$/.test(raw)) return [404, NOT_FOUND];
      const post = await findPost(raw);
      return post ? [200, { data: toJSON(post) }] : [404, NOT_FOUND];
    }
    if (path === '/api/heavy' && method === 'GET') {
      return [200, heavy()];
    }
    return [404, NOT_FOUND];
  } catch (err) {
    console.error(err);
    return [500, SERVER_ERROR];
  }
}

// ─── Seed text, similar in size to Faker's sentence() and paragraphs(3) ───

const WORDS = `lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod
tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation
ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate
velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa
qui officia deserunt mollit anim id est laborum`.split(/\s+/);

const rand = (n) => Math.floor(Math.random() * n);

function sentence() {
  const s = Array.from({ length: 4 + rand(6) }, () => WORDS[rand(WORDS.length)]).join(' ');
  return s[0].toUpperCase() + s.slice(1) + '.';
}

function paragraphs(n) {
  return Array.from({ length: n }, () => Array.from({ length: 3 + rand(4) }, sentence).join(' ')).join('\n\n');
}
