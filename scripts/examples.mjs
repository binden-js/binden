// The runnable examples (`examples/*.ts`) and what each one must do over HTTP. An
// example is a server: it is started on a free port of 127.0.0.1 (`PORT`: it
// prints `Listening on http://localhost:<port>`), checked with real requests (statuses,
// headers and bodies), then stopped with SIGTERM, on which it must shut down
// gracefully and exit with code 0, without writing to stderr.
//
// `scripts/consumer-check.mjs` runs them compiled against the installed archives, and
// `npm run acceptance` from the sources against the workspaces (with tsx). SIGTERM is
// a hard kill on Windows: the examples are checked on POSIX systems only.
import {
  brotliDecompressSync,
  constants,
  createGunzip,
  gzipSync,
} from "node:zlib";
import { createServer, request } from "node:http";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

/** The time that an example has to start, to pass its checks, and to exit */
const deadline = 30_000;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Rejects after `ms` (without keeping the process alive) */
const expire = (ms, message) =>
  new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Timed out: ${message}`));
    }, ms).unref();
  });

/** Whether a response has no such header */
const absent = (headers, name) => !Object.hasOwn(headers, name);

/**
 * A request on a connection of its own: its status, headers and body (as received,
 * e.g. compressed). `flush` sends the headers only, and settles on the response
 * (e.g. a request refused by its `Content-Length` before its body is read), then
 * closes the connection.
 */
function exchange(url, { method = "GET", headers = {}, body, flush = false }) {
  return new Promise((resolve, reject) => {
    const sent = request(url, {
      method,
      headers,
      agent: false,
      signal: AbortSignal.timeout(10_000),
    });
    sent.once("error", reject).once("response", (response) => {
      const chunks = [];
      response
        .on("data", (chunk) => {
          chunks.push(chunk);
        })
        .once("error", reject)
        .once("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
          if (flush) {
            sent.destroy();
          }
        });
    });
    if (flush) {
      sent.flushHeaders();
    } else {
      sent.end(body);
    }
  });
}

/** The JSON body of a response */
const json = ({ body }) => JSON.parse(body.toString("utf8"));

/** A `multipart/form-data` body of a form, and its `Content-Type` */
async function multipart(form) {
  const encoded = new Request("http://localhost/", {
    method: "POST",
    body: form,
  });
  return {
    body: Buffer.from(await encoded.arrayBuffer()),
    type: encoded.headers.get("content-type"),
  };
}

/** Polls `condition` until it holds, or fails after `ms` */
async function eventually(condition, ms, message) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error(`Timed out: ${message}`);
    }
    await sleep(20);
  }
}

async function hello({ url }) {
  const response = await exchange(`${url}/`, {});
  equal(response.status, 200);
  equal(response.headers["content-type"], "text/plain; charset=utf-8");
  equal(response.body.toString(), "Hello, World!");
  equal((await exchange(`${url}/missing`, {})).status, 404);
}

async function routing({ url }) {
  const list = await exchange(`${url}/api/v1/users`, {});
  equal(list.status, 200);
  deepEqual(json(list), [
    { id: "1", name: "Ada" },
    { id: "2", name: "Grace" },
  ]);
  deepEqual(json(await exchange(`${url}/api/v2/users/2`, {})), {
    user: { id: "2", name: "Grace" },
    params: { version: "v2", id: "2" },
    mount_path: "/api/v2/users",
  });
  const missing = await exchange(`${url}/api/v1/users/3`, {});
  equal(missing.status, 404);
  equal(missing.body.toString(), "No such user");
  equal(
    (await exchange(`${url}/api/v1/users`, { method: "POST" })).status,
    201,
  );
  // The methods of the guarded routers
  const refused = await exchange(`${url}/api/v1/users`, { method: "DELETE" });
  equal(refused.status, 405);
  equal(refused.headers.allow, "GET, POST, HEAD, OPTIONS");
  const options = await exchange(`${url}/api/v1/users/1`, {
    method: "OPTIONS",
  });
  equal(options.status, 204);
  equal(options.headers.allow, "GET, HEAD, OPTIONS");
  // `*path`, decoded once; an encoded slash is refused
  deepEqual(json(await exchange(`${url}/files/docs/a%20guide.md`, {})), {
    path: "docs/a guide.md",
  });
  equal((await exchange(`${url}/files/a%2Fb`, {})).status, 400);
  equal((await exchange(`${url}/api`, {})).status, 404);
}

async function bodyCheck({ url }) {
  const item = { name: "tea", quantity: 2 };
  const created = await exchange(`${url}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  });
  equal(created.status, 201);
  deepEqual(json(created), item);
  const compressed = await exchange(`${url}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    body: gzipSync(JSON.stringify({ name: "coffee" })),
  });
  equal(compressed.status, 201);
  deepEqual(json(compressed), { name: "coffee", quantity: 1 });
  const invalid = await exchange(`${url}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  equal(invalid.status, 400);
  const unprocessable = await exchange(`${url}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "[]",
  });
  equal(unprocessable.status, 422);
  // Another media type is not read by the parser: the route refuses it
  const xml = await exchange(`${url}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body: "<item/>",
  });
  equal(xml.status, 415);
  equal(xml.body.toString(), "Send application/json");
  // Refused by its length before its body is read, and the connection closed
  const large = await exchange(`${url}/items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": 1024 * 1024 + 1,
    },
    flush: true,
  });
  equal(large.status, 413);
  equal(large.headers.connection, "close");
}

async function multipartCheck({ url, dir }) {
  const form = new FormData();
  form.append("title", "Reports");
  form.append(
    "document",
    new File(["%PDF-1.7 first"], "first.pdf", { type: "application/pdf" }),
  );
  form.append(
    "document",
    new File(["second"], "../second.txt", { type: "text/plain" }),
  );
  const upload = await multipart(form);
  const created = await exchange(`${url}/documents`, {
    method: "POST",
    headers: { "Content-Type": upload.type },
    body: upload.body,
  });
  equal(created.status, 201);
  const { title, kept } = json(created);
  equal(title, "Reports");
  deepEqual(
    kept.map(({ filename, size }) => ({ filename, size })),
    [
      { filename: "first.pdf", size: 14 },
      // The name that the client has sent, without its path (metadata only)
      { filename: "second.txt", size: 6 },
    ],
  );
  // The kept files are those of the application, the others are removed
  deepEqual(
    kept.map(({ name }) => readFileSync(join(dir, name), "utf8")),
    ["%PDF-1.7 first", "second"],
  );
  await eventually(
    () => readdirSync(join(dir, ".incoming")).length === 0,
    5000,
    "the private directory of the request is removed",
  );

  // A type that `file_filter` refuses
  const refused = new FormData();
  refused.append(
    "document",
    new File(["MZ"], "setup.exe", { type: "application/x-msdownload" }),
  );
  const exe = await multipart(refused);
  const unsupported = await exchange(`${url}/documents`, {
    method: "POST",
    headers: { "Content-Type": exe.type },
    body: exe.body,
  });
  equal(unsupported.status, 415);
  // A body over `limit`, refused by its length
  const large = await exchange(`${url}/documents`, {
    method: "POST",
    headers: {
      "Content-Type": exe.type,
      "Content-Length": 10 * 1024 * 1024 + 1,
    },
    flush: true,
  });
  equal(large.status, 413);
  equal(large.headers.connection, "close");
  await eventually(
    () => readdirSync(join(dir, ".incoming")).length === 0,
    5000,
    "the private directories of the refused requests are removed",
  );

  // Streamed to a checksum, never stored
  const content = "x".repeat(256 * 1024);
  const streamed = new FormData();
  streamed.append("archive", new File([content], "archive.tar"));
  const archive = await multipart(streamed);
  const sums = await exchange(`${url}/checksums`, {
    method: "POST",
    headers: { "Content-Type": archive.type },
    body: archive.body,
  });
  equal(sums.status, 200);
  deepEqual(json(sums), {
    archive: createHash("sha256").update(content).digest("hex"),
  });
}

/**
 * Reads the events of a compressed stream as they come: resolves with the first
 * `count` (they are decompressed, so each of them has been flushed), then waits
 * for the end of the stream
 */
function readEvents(url, count) {
  return new Promise((resolve, reject) => {
    const sent = request(url, {
      agent: false,
      headers: { "Accept-Encoding": "gzip" },
    });
    sent.once("error", reject).once("response", (response) => {
      const { statusCode, headers } = response;
      let text = "";
      const ended = new Promise((done, fail) => {
        response.once("end", done).once("error", fail);
      });
      const gunzip = createGunzip({ flush: constants.Z_SYNC_FLUSH });
      gunzip.setEncoding("utf8").on("data", (chunk) => {
        text += chunk;
        const events = text.split("\n\n").slice(0, -1);
        if (events.length >= count) {
          resolve({ status: statusCode, headers, events, ended });
        }
      });
      response.on("data", (chunk) => {
        gunzip.write(chunk);
      });
    });
    sent.end();
  });
}

async function sse({ url, stop }) {
  const report = await exchange(`${url}/report`, {
    headers: { "Accept-Encoding": "br, gzip" },
  });
  equal(report.status, 200);
  equal(report.headers["content-encoding"], "br");
  equal(report.headers.vary, "Accept-Encoding");
  ok(absent(report.headers, "content-length"));
  const rows = JSON.parse(brotliDecompressSync(report.body).toString());
  equal(rows.length, 200);
  // Without `Accept-Encoding`: identity
  const identity = await exchange(`${url}/report`, {});
  ok(absent(identity.headers, "content-encoding"));
  equal(Number(identity.headers["content-length"]), identity.body.length);

  // Each event is decompressed as soon as it is sent, a second apart
  const stream = await Promise.race([
    readEvents(`${url}/events`, 2),
    expire(5000, "the events have not been flushed"),
  ]);
  equal(stream.status, 200);
  equal(stream.headers["content-type"], "text/event-stream");
  equal(stream.headers["content-encoding"], "gzip");
  equal(stream.headers["x-accel-buffering"], "no");
  deepEqual(
    stream.events.map((event) => event.split("\n").slice(0, 2)),
    [
      ["id: 1", "event: tick"],
      ["id: 2", "event: tick"],
    ],
  );
  // The stream ends when the server shuts down
  const exit = stop();
  await stream.ended;
  return exit;
}

async function shutdownCheck({ url, stop, output }) {
  const { promise: started, resolve: start } = Promise.withResolvers();
  const sent = request(`${url}/export`, { agent: false });
  const completed = new Promise((resolve, reject) => {
    sent.once("error", reject).once("response", (response) => {
      start();
      let text = "";
      response
        .setEncoding("utf8")
        .on("data", (chunk) => {
          text += chunk;
        })
        .once("error", reject)
        .once("end", () => {
          resolve({ status: response.statusCode, text });
        });
    });
  });
  sent.end();
  // The response has started: SIGTERM while it is in progress
  await Promise.race([started, completed]);
  const exit = stop();
  await eventually(
    () => output().includes("Shutting down\n"),
    5000,
    "the shutdown has started",
  );
  // No new connection is accepted
  await exchange(`${url}/export`, {}).then(
    () => {
      throw new Error("A connection has been accepted while closing");
    },
    (error) => {
      equal(error.code, "ECONNREFUSED");
    },
  );
  const { status, text } = await completed;
  equal(status, 200);
  equal(
    text,
    Array.from({ length: 10 }, (_, index) => `line ${index + 1}\n`).join(""),
  );
  await exit;
  match(output(), /Shutting down\nClosed\n$/u);
  return exit;
}

/** The `whoami` of the proxy example, with the `Host` of a local proxy */
async function whoami(url, headers) {
  const { port } = new URL(url);
  const response = await exchange(`${url}/whoami`, {
    headers: { Host: `localhost:${port}`, ...headers },
  });
  return { status: response.status, response };
}

async function xForwarded({ url }) {
  const { status, response } = await whoami(url, {
    "X-Forwarded-For": "203.0.113.7, 10.1.2.3",
    "X-Forwarded-Proto": "https",
    "X-Forwarded-Host": "example.com",
    "X-Request-Id": "req-1",
  });
  equal(status, 200);
  equal(response.headers["x-request-id"], "req-1");
  deepEqual(json(response), {
    ip: "203.0.113.7",
    ips: ["203.0.113.7", "10.1.2.3", "127.0.0.1"],
    protocol: "https:",
    host: "example.com",
    url: "https://example.com/whoami",
    id: "req-1",
  });
  // The client is the first address that is not a proxy: the addresses on its
  // left were sent by the client
  const spoofed = await whoami(url, {
    "X-Forwarded-For": "10.9.9.9, 198.51.100.4, 10.1.2.3",
  });
  deepEqual(json(spoofed.response).ips, [
    "198.51.100.4",
    "10.1.2.3",
    "127.0.0.1",
  ]);
  // The other family is ignored
  const other = await whoami(url, { Forwarded: "for=203.0.113.9" });
  equal(json(other.response).ip, "127.0.0.1");
  // A host that is not allowed
  const host = await whoami(url, { "X-Forwarded-Host": "evil.example" });
  equal(host.status, 400);
}

async function forwarded({ url }) {
  const { status, response } = await whoami(url, {
    Forwarded:
      "for=203.0.113.7;proto=https;host=example.com, for=10.1.2.3;proto=http",
  });
  equal(status, 200);
  const { id, ...rest } = json(response);
  equal(response.headers["x-request-id"], id);
  // `proto` and `host` of the element of the farthest trusted proxy
  deepEqual(rest, {
    ip: "203.0.113.7",
    ips: ["203.0.113.7", "10.1.2.3", "127.0.0.1"],
    protocol: "https:",
    host: "example.com",
    url: "https://example.com/whoami",
  });
  const ipv6 = await whoami(url, {
    Forwarded: 'for="[2001:db8::1]:4711";proto=https;host=example.com',
  });
  equal(json(ipv6.response).ip, "2001:db8::1");
  const other = await whoami(url, { "X-Forwarded-For": "203.0.113.9" });
  equal(json(other.response).ip, "127.0.0.1");
  const host = await whoami(url, {
    Forwarded: "for=198.51.100.4;host=evil.example",
  });
  equal(host.status, 400);
}

async function securityHeaders({ url }) {
  const page = await exchange(`${url}/`, {});
  equal(page.status, 200);
  const { headers } = page;
  const [, nonce] =
    /script-src 'nonce-(?<nonce>[A-Za-z0-9+/=]{24})' 'strict-dynamic'/u.exec(
      headers["content-security-policy"],
    ) ?? [];
  ok(nonce, headers["content-security-policy"]);
  match(headers["content-security-policy"], /frame-ancestors 'none'/u);
  ok(page.body.toString().includes(`<script nonce="${nonce}">`));
  equal(headers["x-content-type-options"], "nosniff");
  equal(headers["referrer-policy"], "no-referrer");
  equal(headers["cross-origin-opener-policy"], "same-origin");
  ok(absent(headers, "strict-transport-security"));
  // A new nonce for every request
  const again = await exchange(`${url}/`, {});
  ok(!again.headers["content-security-policy"].includes(nonce));
  // Over HTTPS (at the proxy): HSTS
  const secure = await exchange(`${url}/api/status`, {
    headers: { "X-Forwarded-Proto": "https" },
  });
  equal(
    secure.headers["strict-transport-security"],
    "max-age=31536000; includeSubDomains",
  );
  // The error replies too
  const missing = await exchange(`${url}/missing`, {});
  equal(missing.status, 404);
  equal(missing.headers["x-content-type-options"], "nosniff");
  match(missing.headers["content-security-policy"], /default-src 'self'/u);
}

/**
 * The examples: `file` (`examples/<file>.ts`), the environment of its process
 * (`env(dir)`, with a private temporary directory) and its check, which may stop
 * the example itself (it then returns the promise of `stop()`)
 */
export const examples = [
  { name: "hello", file: "hello", check: hello },
  { name: "routing", file: "routing", check: routing },
  { name: "body", file: "body", check: bodyCheck },
  {
    name: "multipart",
    file: "multipart",
    env: (dir) => ({ UPLOAD_DIR: dir }),
    check: multipartCheck,
  },
  { name: "sse", file: "sse", check: sse },
  { name: "shutdown", file: "shutdown", check: shutdownCheck },
  {
    name: "proxy (x-forwarded)",
    file: "proxy",
    env: () => ({ PROXY_HEADERS: "x-forwarded" }),
    check: xForwarded,
  },
  {
    name: "proxy (forwarded)",
    file: "proxy",
    env: () => ({ PROXY_HEADERS: "forwarded" }),
    check: forwarded,
  },
  {
    name: "security-headers",
    file: "security-headers",
    check: securityHeaders,
  },
];

/**
 * A free port of 127.0.0.1, for an example: it listens without a host (`::`),
 * and its clients connect to 127.0.0.1. `PORT=0` could give it a port that a
 * foreign process listens on at 127.0.0.1, which those connections would reach
 */
async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return String(port);
}

/**
 * Starts an example (`command` with `args`), checks it, stops it with SIGTERM
 * and checks that it has exited with code 0 and an empty stderr
 */
export async function runExample(example, { command, args, cwd }) {
  const dir = mkdtempSync(join(tmpdir(), "binden-example-"));
  const free = await freePort();
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, PORT: free, ...example.env?.(dir) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  let stopping = null;
  const stop = () => {
    stopping ??= (() => {
      child.kill("SIGTERM");
      return exited;
    })();
    return stopping;
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, deadline);
  try {
    const port = await new Promise((resolve, reject) => {
      const listening = () => {
        const found = /Listening on http:\/\/localhost:(?<port>\d+)\n/u.exec(
          stdout,
        );
        if (found !== null) {
          child.stdout.off("data", listening);
          resolve(found.groups.port);
        }
      };
      child.stdout.on("data", listening);
      exited.then(({ code, signal }) => {
        reject(
          new Error(`Exited before listening (${code ?? signal}): ${stderr}`),
        );
      }, reject);
    });
    await example.check({
      url: `http://127.0.0.1:${port}`,
      dir,
      stop,
      output: () => stdout,
    });
    const { code, signal } = await stop();
    deepEqual(
      { code, signal, stderr },
      { code: 0, signal: null, stderr: "" },
      `${example.name}: the exit and the stderr of the example`,
    );
  } catch (error) {
    throw new Error(
      `Example ${example.name} (${args.at(-1)}) has failed:\n${stdout}${stderr}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await exited;
    rmSync(dir, { force: true, recursive: true });
  }
}
