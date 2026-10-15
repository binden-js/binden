// A small benchmark of binden (see README.md): it forks the server, then
// sends the requests of every scenario over keep-alive connections for a
// while, and prints the requests per second and the latencies.
//
//   npm run bench -- --duration 10 --connections 64 --scenario json
import { Agent, request } from "node:http";
import { fork } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    duration: { type: "string", default: "5" },
    connections: { type: "string", default: "32" },
    scenario: { type: "string", multiple: true },
  },
});
const duration = Number(values.duration) * 1000;
const connections = Number(values.connections);
if (!(duration > 0) || !Number.isSafeInteger(connections) || connections < 1) {
  throw new RangeError("`--duration` and `--connections` must be positive");
}

/** A JSON body of about 1 KiB */
const body = JSON.stringify({
  items: Array.from({ length: 16 }, (_, id) => ({ id, name: `item ${id}` })),
  text: "x".repeat(512),
});

/** The requests of the scenarios */
const scenarios = [
  { name: "hello", method: "GET", path: "/hello" },
  { name: "json", method: "GET", path: "/json" },
  { name: "params", method: "GET", path: "/users/42/posts/hello%20world" },
  {
    name: "body",
    method: "POST",
    path: "/echo",
    headers: { "content-type": "application/json" },
    body,
  },
  {
    name: "compression",
    method: "GET",
    path: "/large",
    headers: { "accept-encoding": "br, gzip" },
  },
].filter(({ name }) => !values.scenario || values.scenario.includes(name));

/** Sends a request and reads its response: its status, or an error */
function send(agent, port, { method, path, headers = {}, body: data }) {
  return new Promise((resolve) => {
    const req = request(
      { agent, port, host: "127.0.0.1", method, path, headers },
      (res) => {
        res.on("data", () => null);
        res.on("end", () => resolve(res.statusCode));
        res.on("error", () => resolve(0));
      },
    );
    req.on("error", () => resolve(0));
    req.end(data);
  });
}

/** Runs a scenario: the count of the requests, of the errors, and the latencies */
async function run(port, scenario) {
  const agent = new Agent({ keepAlive: true, maxSockets: connections });
  const latencies = [];
  let errors = 0;
  const deadline = performance.now() + duration;
  const connection = async () => {
    while (performance.now() < deadline) {
      const start = performance.now();
      const status = await send(agent, port, scenario);
      latencies.push(performance.now() - start);
      if (status < 200 || status > 299) {
        errors += 1;
      }
    }
  };
  // Warm up, then measure
  await send(agent, port, scenario);
  const started = performance.now();
  await Promise.all(Array.from({ length: connections }, connection));
  const elapsed = (performance.now() - started) / 1000;
  agent.destroy();
  latencies.sort((a, b) => a - b);
  const at = (q) =>
    latencies[
      Math.min(latencies.length - 1, Math.floor(q * latencies.length))
    ] ?? 0;
  return {
    scenario: scenario.name,
    "req/s": Math.round(latencies.length / elapsed),
    "p50 ms": at(0.5).toFixed(2),
    "p99 ms": at(0.99).toFixed(2),
    errors,
  };
}

const server = fork(new URL("server.mjs", import.meta.url), {
  stdio: "inherit",
});
try {
  const [{ port }] = await once(server, "message");
  const results = [];
  for (const scenario of scenarios) {
    results.push(await run(port, scenario));
  }
  const columns = Object.keys(results[0] ?? {});
  const rows = [
    columns,
    ...results.map((result) => columns.map((c) => String(result[c]))),
  ];
  const widths = columns.map((_, i) =>
    Math.max(...rows.map((row) => row[i].length)),
  );
  process.stdout.write(
    `Node.js ${process.version}, ${connections} connections, ${duration / 1000} s per scenario\n`,
  );
  for (const row of rows) {
    process.stdout.write(
      `${row.map((cell, i) => cell.padStart(widths[i])).join("  ")}\n`,
    );
  }
} finally {
  server.disconnect();
}
