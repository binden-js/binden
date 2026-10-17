// The body parser, the multipart parser and the compression installed together as
// shared middlewares of the application: each parser handles its own media types and
// skips the others without reading them, so that JSON and forms reach their routes,
// another body is left to its route, and the routes require their own media type
// (415). Every request reuses one connection, after the refusals too.
import { Agent, type OutgoingHttpHeaders } from "node:http";
import { Binden, BindenError, type Context, Router } from "binden";
import { type IStoredForm, Multipart } from "@binden/multipart";
import { deadline, eventually, exchange, multipart, serve } from "./helpers.js";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { BodyParser } from "@binden/body";
import { Compression } from "@binden/compression";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";

deadline(20_000);

const MiB = 1024 * 1024;
const uploads = mkdtempSync(join(tmpdir(), "binden-acceptance-"));
process.once("exit", () => {
  rmSync(uploads, { recursive: true, force: true });
});

/** Refuses a request whose body is not of `type` */
function requireType(context: Context, type: string): void {
  if (context.request.content_type?.type !== type) {
    throw new BindenError(415);
  }
}

const app = new Binden({ timeout: 30_000 })
  .use(
    new Compression(),
    new BodyParser({ limit: MiB, encoded_limit: MiB }),
    new Multipart({
      limit: 10 * MiB,
      config: { limits: { fileSize: 5 * MiB, files: 10, fields: 100 } },
      storage: { dir: uploads },
    }),
  )
  .use(
    "/json",
    new Router().post((context) => {
      requireType(context, "application/json");
      return context.json({ received: context.request.body });
    }),
  )
  .use(
    "/upload",
    new Router().post((context) => {
      requireType(context, "multipart/form-data");
      const { fields, files } = context.request.body as IStoredForm;
      return context.json({
        fields: Object.fromEntries(fields),
        files: [...files.values()]
          .flat()
          .map(({ field, filename, size }) => ({ field, filename, size })),
      });
    }),
  )
  .use(
    "/raw",
    new Router().post(async (context) => {
      // Neither parser has read the body: the route reads it
      let size = 0;
      for await (const chunk of context.request) {
        size += (chunk as Buffer).length;
      }
      return context.json({
        parsed: typeof context.request.body !== "undefined",
        size,
      });
    }),
  );

const { server, port } = await serve(app);
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
const post = (
  path: string,
  headers: OutgoingHttpHeaders,
  body: Buffer | string,
): ReturnType<typeof exchange> =>
  exchange(port, path, { agent, method: "POST", headers }, body);

const results: Record<string, unknown> = {};

const item = { name: "tea", tags: Array.from({ length: 300 }, (_, i) => i) };
const json = await post(
  "/json",
  { "Content-Type": "application/json" },
  JSON.stringify(item),
);
results.json = {
  status: json.status,
  body: JSON.parse(json.body.toString()) as unknown,
  reused: json.reused,
};

// Compressed by the shared compression, on a connection of its own
const compressed = await exchange(
  port,
  "/json",
  {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept-Encoding": "gzip" },
  },
  JSON.stringify(item),
);
results.compressed = {
  status: compressed.status,
  encoding: compressed.headers["content-encoding"],
  body: JSON.parse(gunzipSync(compressed.body).toString()) as unknown,
};

const form = new FormData();
form.append("title", "Report");
form.append("document", new File(["a".repeat(4096)], "report.txt"));
const upload = await multipart(form);
const files = await post(
  "/upload",
  { "Content-Type": upload.type },
  upload.body,
);
results.upload = {
  status: files.status,
  body: JSON.parse(files.body.toString()) as unknown,
  reused: files.reused,
};

const raw = await post(
  "/raw",
  { "Content-Type": "application/octet-stream" },
  Buffer.alloc(100 * 1024),
);
results.raw = {
  status: raw.status,
  body: JSON.parse(raw.body.toString()) as unknown,
  reused: raw.reused,
};

// Each route refuses the media type of the other, once its parser has read it
const wrongJson = await post(
  "/json",
  { "Content-Type": upload.type },
  upload.body,
);
const wrongForm = await post(
  "/upload",
  { "Content-Type": "application/json" },
  "{}",
);
results.refused = [wrongJson, wrongForm].map(({ status, reused }) => ({
  status,
  reused,
}));

// The files that the routes have not kept are removed with their request
await eventually(
  () => readdirSync(uploads).length === 0,
  "the private directories are removed",
);
results.leftovers = readdirSync(uploads).length;

agent.destroy();
server.close();
process.stdout.write(`${JSON.stringify(results)}\n`);
