/* eslint-disable init-declarations */
import { Compression, skipCompression } from "../index.js";
import { type Context, bodyHeaders } from "binden";
import {
  type IReceived,
  type IServed,
  fetchRaw,
  gzips,
  none,
  serve,
  text,
} from "./helpers.js";
import { after, afterEach, before, suite, test } from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import zlib from "node:zlib";

/** The status and the headers that tell the representation of a response */
function representation({
  status,
  headers,
  raw,
}: IReceived): Record<string, unknown> {
  return {
    status,
    encoding: headers["content-encoding"],
    vary: headers.vary,
    etag: headers.etag,
    length: headers["content-length"],
    bytes: raw.length,
  };
}

/** Sends a request with `Accept-Encoding` (none when `null`) */
function accepting(
  url: string,
  header: string | null,
  { path = "/", method = "GET", headers = {} } = {},
): Promise<IReceived> {
  return fetchRaw(url, {
    path,
    method,
    headers:
      header === null ? headers : { ...headers, "Accept-Encoding": header },
  });
}

const methods = ["GET", "HEAD"] as const;

suite("The representation that the request accepts", () => {
  let tmp: string;
  let empty: string;
  let precompressed: string;
  const content = text(4096);
  const gzipped = zlib.gzipSync(content);
  const servers: IServed[] = [];

  const start = async (
    etag: boolean,
    handler: (context: Context) => Promise<void>,
  ): Promise<string> => {
    const served = await serve({ etag }, new Compression(), handler);
    servers.push(served);
    return served.url;
  };

  before(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), "binden-compression-")));
    empty = join(tmp, "empty.txt");
    precompressed = join(tmp, "file.txt.gz");
    await writeFile(empty, "");
    await writeFile(precompressed, gzipped);
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
  });

  test("a response without a body, whatever the request accepts", async () => {
    const url = await start(true, async (context: Context) => {
      const { response } = context;
      switch (context.url.pathname) {
        case "/204":
          await response.status(204).send("ignored");
          break;
        case "/205":
          await response.status(205).send();
          break;
        case "/string":
          await response.send("");
          break;
        case "/buffer":
          await response.send(Buffer.alloc(0));
          break;
        case "/file":
          await response.sendFile(empty);
          break;
        case "/encoded":
          response.setHeader("Content-Encoding", "gzip");
          await response.send();
          break;
        default:
          await response.send();
      }
    });
    for (const path of [
      "/204",
      "/205",
      "/",
      "/string",
      "/buffer",
      "/file",
      "/encoded",
    ]) {
      for (const header of ["identity;q=0", "*;q=0", "gzip;q=0", ""]) {
        for (const method of methods) {
          const received = await accepting(url, header, { path, method });
          const status = Number(path.slice(1)) || 200;
          deepStrictEqual(
            [received.status, received.headers.vary, received.raw.length],
            [status, none, 0],
            `${method} ${path} ${header}`,
          );
          deepStrictEqual(
            received.headers["content-encoding"],
            path === "/encoded" ? "gzip" : none,
          );
        }
      }
    }
  });

  test("threshold, filter, `skipCompression()`, `no-transform` and ranges: as it is when acceptable, otherwise `406`", async () => {
    const url = await start(false, async (context: Context) => {
      const { response } = context;
      const { pathname } = context.url;
      response.setHeader("Content-Type", "text/plain");
      if (pathname === "/small") {
        await response.send("small");
        return;
      } else if (pathname === "/image") {
        response.setHeader("Content-Type", "image/png");
      } else if (pathname === "/skip") {
        skipCompression(response);
      } else if (pathname === "/no-transform") {
        response.setHeader("Cache-Control", "no-transform");
      } else if (pathname === "/range") {
        response
          .status(206)
          .setHeader("Content-Range", `bytes 0-4095/${content.length * 2}`);
      }
      await response.send(content);
    });
    const cases: [string | null, number][] = [
      [null, 200],
      ["", 200],
      ["gzip", 200],
      ["br, identity;q=0.5", 200],
      ["identity", 200],
      ["identity;q=0", 406],
      ["gzip, identity;q=0", 406],
      ["*;q=0", 406],
      ["*;q=0, gzip", 406],
    ];
    for (const path of [
      "/small",
      "/image",
      "/skip",
      "/no-transform",
      "/range",
    ]) {
      for (const [header, status] of cases) {
        const [get, head] = await Promise.all(
          methods.map(async (method) =>
            accepting(url, header, { path, method }),
          ),
        );
        const size = path === "/small" ? 5 : content.length;
        const expected = {
          status: status === 200 && path === "/range" ? 206 : status,
          encoding: none,
          vary: "Accept-Encoding",
          etag: none,
          length: `${status === 200 ? size : 0}`,
          bytes: status === 200 ? size : 0,
        };
        deepStrictEqual(
          representation(get),
          expected,
          `GET ${path} ${String(header)}`,
        );
        deepStrictEqual(
          representation(head),
          { ...expected, bytes: 0 },
          `HEAD ${path} ${String(header)}`,
        );
      }
    }
  });

  test("the codings that the request accepts, by their weight (`q=0` refuses one)", async () => {
    const url = await start(false, async (context: Context) => {
      await context.text(content);
    });
    const cases: [string, number, string | undefined][] = [
      ["gzip;q=0", 200, none],
      ["gzip;q=0, *", 200, "br"],
      ["br;q=0, gzip", 200, "gzip"],
      ["*;q=0, deflate", 200, "deflate"],
      ["x-gzip;q=0.5, identity;q=0", 200, "gzip"],
      ["identity;q=0, *;q=0.5", 200, "br"],
      ["br;q=0, gzip;q=0, deflate;q=0", 200, none],
      ["br;q=0, gzip;q=0, deflate;q=0, identity;q=0", 406, none],
      ["br;q=0, *;q=0", 406, none],
      ["identity;q=0", 406, none],
    ];
    for (const [header, status, coding] of cases) {
      for (const method of methods) {
        const received = await accepting(url, header, { method });
        deepStrictEqual(
          [
            received.status,
            received.headers["content-encoding"],
            received.headers.vary,
          ],
          [status, coding, "Accept-Encoding"],
          `${method} ${header}`,
        );
        deepStrictEqual(
          received.body,
          method === "GET" && status === 200 ? content : "",
        );
      }
    }
  });

  test("an encoded response: as it is when the request accepts its coding (any without the header), otherwise `406`", async () => {
    const validator = `"v1"`;
    const url = await start(true, async (context: Context) => {
      const { response } = context;
      response.setHeader("Content-Encoding", "gzip");
      response.setHeader("Content-Type", "text/plain");
      switch (context.url.pathname) {
        case "/file":
          await response.sendFile(precompressed, { validator });
          break;
        case "/stream":
          response.setHeader("Content-Length", gzipped.length);
          await response.send(Readable.from([gzipped]));
          break;
        default:
          // The dynamic `ETag`
          await response.send(gzipped);
      }
    });
    const tags = new Map<string, string>();
    const accepted = [null, "gzip", "x-gzip", "*", "br, gzip;q=0.1"];
    const refused = ["", "gzip;q=0", "br", "identity", "*;q=0", "*, gzip;q=0"];
    for (const path of ["/", "/file", "/stream"]) {
      for (const method of methods) {
        for (const header of accepted) {
          const created = await gzips(async () => {
            const received = await accepting(url, header, { path, method });
            const { etag } = received.headers;
            deepStrictEqual(
              representation(received),
              {
                status: 200,
                encoding: "gzip",
                vary: "Accept-Encoding",
                // Kept strong: the bytes are not changed
                etag: path === "/stream" ? none : etag,
                length: `${gzipped.length}`,
                bytes: method === "GET" ? gzipped.length : 0,
              },
              `${method} ${path} ${String(header)}`,
            );
            if (method === "GET") {
              // Not coded twice
              deepStrictEqual(received.body, content);
            }
            if (typeof etag === "string") {
              deepStrictEqual(etag.startsWith("W/"), false);
              tags.set(path, etag);
            }
          });
          deepStrictEqual(created.length, 0);
        }
        for (const header of refused) {
          deepStrictEqual(
            representation(await accepting(url, header, { path, method })),
            {
              status: 406,
              encoding: none,
              vary: "Accept-Encoding",
              etag: none,
              length: "0",
              bytes: 0,
            },
            `${method} ${path} ${header}`,
          );
        }
      }
    }

    // The preconditions of the representation as it is, and its ranges
    for (const path of ["/", "/file"]) {
      const tag = String(tags.get(path));
      for (const method of methods) {
        const status = async (
          header: string,
          headers: Record<string, string>,
        ): Promise<unknown[]> => {
          const received = await accepting(url, header, {
            path,
            method,
            headers,
          });
          return [received.status, received.headers["content-encoding"]];
        };
        deepStrictEqual(await status("gzip", { "If-Match": tag }), [
          200,
          "gzip",
        ]);
        // Empty: without the coding of the body
        deepStrictEqual(await status("gzip", { "If-Match": `"other"` }), [
          412,
          none,
        ]);
        deepStrictEqual(await status("gzip", { "If-None-Match": tag }), [
          304,
          "gzip",
        ]);
        // `406` first
        deepStrictEqual(await status("br", { "If-None-Match": tag }), [
          406,
          none,
        ]);
        deepStrictEqual(await status("br", { "If-Match": `"other"` }), [
          406,
          none,
        ]);
      }
    }
    const partial = await accepting(url, "gzip", {
      path: "/file",
      headers: { Range: "bytes=0-9", "If-Range": validator },
    });
    deepStrictEqual(
      [
        partial.status,
        partial.headers["content-encoding"],
        partial.headers["content-range"],
      ],
      [206, "gzip", `bytes 0-9/${gzipped.length}`],
    );
    deepStrictEqual(partial.raw, gzipped.subarray(0, 10));
  });
  test("an empty replacement has none of the headers of the body that it replaces, as an error reply of binden", async () => {
    const errors: unknown[] = [];
    // Valid values of the headers of a body (any other is "x"): not
    // encoded, so that the `filter` decides
    const values: Record<string, string> = {
      "Content-Encoding": "identity",
      "Content-Length": "4",
      "Content-Range": "bytes 0-3/8",
      "Content-Type": "text/plain",
      ETag: '"e"',
      "Last-Modified": new Date(0).toUTCString(),
      Trailer: "X-T",
      "Transfer-Encoding": "chunked",
    };
    const served = await serve(
      {
        app: {
          error_handler: (context: Context, error: unknown): void => {
            errors.push((error as { code?: unknown }).code);
            context.response.destroy();
          },
        },
      },
      new Compression({
        threshold: 0,
        filter: (context: Context): boolean => {
          if (context.url.pathname === "/failed") {
            throw new Error("Failed filter");
          }
          return true;
        },
      }),
      (context: Context) => {
        const { response } = context;
        context.done = true;
        if (context.url.pathname === "/trailer") {
          // The reproduction of the review
          response.setHeader("Trailer", "X-T");
        } else {
          for (const name of [...bodyHeaders, "Accept-Ranges"]) {
            // A range is never compressed (nor filtered)
            if (
              name !== "Content-Range" ||
              context.url.pathname !== "/failed"
            ) {
              response.setHeader(name, values[name] ?? "x");
            }
          }
        }
        response.end("body");
      },
    );
    servers.push(served);
    const removed = [...bodyHeaders, "Accept-Ranges"]
      .map((name) => name.toLowerCase())
      .filter((name) => name !== "content-length");
    for (const [path, header, status] of [
      ["/trailer", "*;q=0", 406],
      ["/", "*;q=0", 406],
      ["/failed", "gzip", 500],
    ] as const) {
      for (const method of methods) {
        const received = await accepting(served.url, header, { path, method });
        deepStrictEqual(
          [
            received.status,
            received.headers["content-length"],
            received.raw.length,
            received.headers.vary,
            removed.filter((name) => name in received.headers),
          ],
          [status, "0", 0, status === 406 ? "Accept-Encoding" : none, []],
          `${method} ${path}`,
        );
      }
    }
    deepStrictEqual(errors, []);
  });

  test("a representation that the request refuses is never sent (the reproductions of the review)", async () => {
    const tag = `"v1"`;
    const file = join(tmp, "file.txt");
    await writeFile(file, content);
    const fixed = new Compression({ format: "gzip" });
    const filtered = new Compression({ filter: (): boolean => false });
    const negotiated = new Compression();
    const served = await serve(
      {},
      (context: Context) => {
        // The compression of each route
        const { pathname } = context.url;
        const compression =
          pathname === "/fixed"
            ? fixed
            : pathname === "/filtered"
              ? filtered
              : negotiated;
        compression.run(context);
      },
      async (context: Context) => {
        const { pathname } = context.url;
        await (pathname === "/small"
          ? context.text("small")
          : pathname === "/file"
            ? context.response.sendFile(file, { validator: tag })
            : context.text(content));
      },
    );
    servers.push(served);
    const cases: [
      string,
      Record<string, string>,
      number,
      string | undefined,
    ][] = [
      ["/fixed", { "Accept-Encoding": "gzip;q=0, identity" }, 200, none],
      ["/small", { "Accept-Encoding": "identity;q=0" }, 406, none],
      ["/filtered", { "Accept-Encoding": "identity;q=0" }, 406, none],
      [
        "/file",
        { "Accept-Encoding": "gzip, identity;q=0", "If-Match": tag },
        412,
        none,
      ],
    ];
    for (const [path, headers, status, coding] of cases) {
      for (const method of methods) {
        const received = await fetchRaw(served.url, { path, method, headers });
        deepStrictEqual(
          [received.status, received.headers["content-encoding"]],
          [status, coding],
          `${method} ${path}`,
        );
      }
    }
  });
});
