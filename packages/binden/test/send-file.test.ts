/* eslint-disable init-declarations */
import { BindenError, type ISendFileOptions } from "../index.js";
import { type IReply, type ITestServer, listen } from "./http.js";
import {
  after,
  afterEach,
  before,
  beforeEach,
  mock,
  suite,
  test,
} from "node:test";
import { deepStrictEqual, ok } from "node:assert";
import fsp, {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, posix, relative, win32 } from "node:path";
import { preconditionsOf, relativeSegments, within } from "../src/send-file.js";
import type { IncomingMessage } from "node:http";
import { contentTypeOf } from "../src/mime.js";
import { kSeal } from "../src/seal.js";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";

interface IServed extends IReply {
  /** `null` once `sendFile()` has resolved, otherwise its error */
  readonly error: unknown;
}

const posixOnly = { skip: process.platform === "win32" };
const windowsOnly = { skip: process.platform !== "win32" };

suite("sendFile", () => {
  // `tmp/public` is the root, next to files and directories outside of it
  let tmp: string;
  let root: string;
  let server: ITestServer;
  const html = "<p>index</p>";

  before(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), "binden-send-file-")));
    root = join(tmp, "public");
    await mkdir(join(root, "dir"), { recursive: true });
    await mkdir(join(root, ".hidden"));
    await mkdir(join(tmp, "private"));
    await mkdir(join(tmp, "public-old"));
    const files: [string, string][] = [
      ["public/index.html", html],
      ["public/style.CSS", "p {}"],
      ["public/data.unknown", "data"],
      ["public/noext", "noext"],
      ["public/a%20b", "encoded"],
      ["public/.secret", "secret"],
      ["public/.hidden/file.txt", "hidden"],
      ["public/dir/nested.txt", "nested"],
      ["outside.txt", "outside"],
      ["private/secret.txt", "private"],
      ["public-old/file.txt", "old"],
    ];
    for (const [path, content] of files) {
      await writeFile(join(tmp, path), content);
    }
    const links: [string, string][] = [
      ["index.html", "public/link-inside"],
      ["../outside.txt", "public/link-outside"],
      ["../private", "public/link-dir-outside"],
      ["../public-old/file.txt", "public/link-old"],
      [".secret", "public/link-dot"],
      [".", "public/self"],
      ["loop2", "public/loop1"],
      ["loop1", "public/loop2"],
    ];
    for (const [target, path] of links) {
      await symlink(target, join(tmp, path));
    }
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    server = await listen();
  });

  afterEach(async () => {
    mock.restoreAll();
    syncBuiltinESMExports();
    await server.close();
  });

  /** Requests a file of `sendFile(path, options)`: an error is replied with its status */
  const serve = async (
    path: URL | string,
    options?: ISendFileOptions,
    request: Parameters<ITestServer["request"]>[0] = {},
  ): Promise<IServed> => {
    let error: unknown = null;
    const handled = server.handle(async (_request, response) => {
      try {
        await response.sendFile(path, options);
      } catch (reason: unknown) {
        error = reason;
        ok(!response.started);
        const status = reason instanceof BindenError ? reason.status : 500;
        await response.status(status).send();
      }
    });
    const reply = await server.request(request);
    deepStrictEqual(await handled, null);
    return { ...reply, error };
  };

  /** The status of `sendFile(path, { root, ...options })` */
  const status = async (
    path: URL | string,
    options: ISendFileOptions = {},
  ): Promise<number> => (await serve(path, { root, ...options })).status;

  test("relativeSegments()", () => {
    const cases: [string, string[] | null, string[] | null][] = [
      // [path, POSIX, Windows]
      ["a/b.txt", ["a", "b.txt"], ["a", "b.txt"]],
      ["a\\b.txt", ["a\\b.txt"], ["a", "b.txt"]],
      [".a/b", [".a", "b"], [".a", "b"]],
      ["a:b", ["a:b"], null],
      ["C:x", ["C:x"], null],
      ["/a", null, null],
      ["\\a", ["\\a"], null],
      ["C:\\a", ["C:\\a"], null],
      ["C:/a", ["C:", "a"], null],
      ["\\\\server\\share\\a", ["\\\\server\\share\\a"], null],
      ["//server/share/a", null, null],
      ["", null, null],
      ["a//b", null, null],
      ["a/", null, null],
      ["a\\\\b", ["a\\\\b"], null],
      [".", null, null],
      ["./a", null, null],
      ["a/../b", null, null],
      ["..", null, null],
      ["a\\..\\b", ["a\\..\\b"], null],
      ["a\0b", null, null],
      ["..a/b..", ["..a", "b.."], ["..a", "b.."]],
    ];
    for (const [path, onPosix, onWindows] of cases) {
      deepStrictEqual(relativeSegments(path, false), onPosix, `POSIX ${path}`);
      deepStrictEqual(
        relativeSegments(path, true),
        onWindows,
        `Windows ${path}`,
      );
    }
  });

  test("within()", () => {
    deepStrictEqual(within("/srv/public", "/srv/public/a/b", posix), [
      "a",
      "b",
    ]);
    deepStrictEqual(within("/srv/public", "/srv/public/..a", posix), ["..a"]);
    // Not by a prefix
    deepStrictEqual(within("/srv/public", "/srv/public-old/a", posix), null);
    deepStrictEqual(within("/srv/public", "/srv/public", posix), null);
    deepStrictEqual(within("/srv/public", "/srv", posix), null);
    deepStrictEqual(within("/srv/public", "/etc/passwd", posix), null);
    deepStrictEqual(within("C:\\root", "C:\\root\\a\\b", win32), ["a", "b"]);
    // Another drive
    deepStrictEqual(within("C:\\root", "D:\\root\\a", win32), null);
    deepStrictEqual(within("C:\\root", "C:\\root-old\\a", win32), null);
    // The platform by default
    deepStrictEqual(within(root, join(root, "a")), ["a"]);
  });

  test("contentTypeOf()", () => {
    const cases: [string, string][] = [
      ["index.html", "text/html; charset=utf-8"],
      ["/a/b/STYLE.CSS", "text/css; charset=utf-8"],
      ["app.mjs", "text/javascript; charset=utf-8"],
      ["data.json", "application/json"],
      ["image.svg", "image/svg+xml"],
      ["font.woff2", "font/woff2"],
      ["module.wasm", "application/wasm"],
      ["file.unknown", "application/octet-stream"],
      ["noext", "application/octet-stream"],
      [".bashrc", "application/octet-stream"],
      ["constructor", "application/octet-stream"],
      ["a.constructor", "application/octet-stream"],
    ];
    for (const [name, type] of cases) {
      deepStrictEqual(contentTypeOf(name), type, name);
    }
  });

  test("with `root`", async () => {
    const {
      status: code,
      headers,
      body,
      error,
    } = await serve("index.html", {
      root,
    });
    deepStrictEqual([code, error, body.toString()], [200, null, html]);
    const stats = await stat(join(root, "index.html"));
    const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    deepStrictEqual(
      {
        "content-type": headers["content-type"],
        "content-length": headers["content-length"],
        etag: headers.etag,
        "x-content-type-options": headers["x-content-type-options"],
        "accept-ranges": headers["accept-ranges"],
      },
      {
        "content-type": "text/html; charset=utf-8",
        "content-length": `${html.length}`,
        etag,
        "x-content-type-options": "nosniff",
        "accept-ranges": "bytes",
      },
    );
    ok(typeof headers["last-modified"] === "string");

    const nested = await serve("dir/nested.txt", { root: pathToFileURL(root) });
    deepStrictEqual([nested.status, nested.body.toString()], [200, "nested"]);
    deepStrictEqual(
      nested.headers["content-type"],
      "text/plain; charset=utf-8",
    );
    // A filesystem path: not URL-decoded
    deepStrictEqual(
      (await serve("a%20b", { root })).body.toString(),
      "encoded",
    );
    // A relative `root`
    const relativeRoot = relative(process.cwd(), root);
    deepStrictEqual(await status("index.html", { root: relativeRoot }), 200);
  });

  test("with `root` (404 outside of it)", async () => {
    for (const path of [
      "/etc/passwd",
      join(root, "index.html"),
      "../outside.txt",
      "dir/../index.html",
      "./index.html",
      "",
      "dir/",
      "dir//nested.txt",
      "index\0.html",
      // Symbolic links that lead out (also to a directory whose name starts
      // with the name of the root)
      "link-outside",
      "link-dir-outside/secret.txt",
      "link-old",
      // The root itself, and directories
      "self",
      "dir",
      // Missing (`ENOENT`, `ENOTDIR`, `ENAMETOOLONG`, `ELOOP`)
      "missing.txt",
      "index.html/x",
      "x".repeat(1024),
      "loop1",
    ]) {
      const { status: code, error } = await serve(path, { root });
      deepStrictEqual(code, 404, path);
      ok(error instanceof BindenError, path);
    }
    // A symbolic link that stays inside
    const inside = await serve("link-inside", { root });
    deepStrictEqual([inside.status, inside.body.toString()], [200, html]);
    // Named by the path that is asked for
    deepStrictEqual(inside.headers["content-type"], "application/octet-stream");
  });

  test("with `root` (`dotfiles`)", async () => {
    for (const path of [".secret", ".hidden/file.txt", "link-dot"]) {
      deepStrictEqual(await status(path), 404, path);
      deepStrictEqual(await status(path, { dotfiles: "ignore" }), 404, path);
      deepStrictEqual(await status(path, { dotfiles: "deny" }), 403, path);
      deepStrictEqual(await status(path, { dotfiles: "allow" }), 200, path);
    }
    // Before looking for the file
    deepStrictEqual(await status(".missing", { dotfiles: "deny" }), 403);
    deepStrictEqual(await status(".missing", { dotfiles: "allow" }), 404);
  });

  test("with `root` (invalid)", async () => {
    const checks: [URL | string, ISendFileOptions, Error][] = [
      [
        pathToFileURL(join(root, "index.html")),
        { root },
        new TypeError("With `root`, the path must be a relative string"),
      ],
      [
        "index.html",
        { root: "" },
        new TypeError("`root` is not a non-empty string or a URL"),
      ],
      [
        "index.html",
        { root: 1 as unknown as string },
        new TypeError("`root` is not a non-empty string or a URL"),
      ],
      [
        "index.html",
        { root: new URL("https://example.com/") },
        new TypeError("Protocol https: is not supported"),
      ],
    ];
    for (const [path, options, expected] of checks) {
      const { status: code, error } = await serve(path, options);
      deepStrictEqual([code, error], [500, expected]);
    }
    // A root that does not exist is not a missing file
    const { status: code, error } = await serve("index.html", {
      root: join(tmp, "missing"),
    });
    deepStrictEqual(code, 500);
    deepStrictEqual((error as { code?: unknown }).code, "ENOENT");
  });

  test("with `root` (errors of opening the file)", async () => {
    const opening = async (code: string): Promise<IServed> => {
      const failing = Object.assign(new Error(code), { code });
      mock.method(fsp, "open", () => Promise.reject(failing));
      syncBuiltinESMExports();
      try {
        return await serve("index.html", { root });
      } finally {
        mock.restoreAll();
        syncBuiltinESMExports();
      }
    };
    // E.g. a directory on Windows
    const directory = await opening("EISDIR");
    deepStrictEqual(directory.status, 404);
    ok(directory.error instanceof BindenError);
    deepStrictEqual(
      (directory.error.cause as { code?: unknown }).code,
      "EISDIR",
    );
    // Not a missing file
    const denied = await opening("EACCES");
    deepStrictEqual(denied.status, 500);
    deepStrictEqual((denied.error as { code?: unknown }).code, "EACCES");
  });

  test(
    "with `root` (a file replaced by a symbolic link once resolved)",
    posixOnly,
    async () => {
      const target = join(root, "swapped.txt");
      await writeFile(target, "swapped");
      const { realpath: original } = fsp;
      mock.method(fsp, "realpath", async (path: string) => {
        const real = await original(path);
        if (real === target) {
          // Between the check and the open
          await unlink(target);
          await symlink(join(tmp, "outside.txt"), target);
        }
        return real;
      });
      syncBuiltinESMExports();
      try {
        const { status: code, body } = await serve("swapped.txt", { root });
        deepStrictEqual([code, body.toString()], [404, ""]);
      } finally {
        mock.restoreAll();
        syncBuiltinESMExports();
        await rm(target);
      }
    },
  );

  test("with `root` (a backslash is a character)", posixOnly, async () => {
    await writeFile(join(root, "back\\slash"), "backslash");
    try {
      deepStrictEqual(
        (await serve("back\\slash", { root })).body.toString(),
        "backslash",
      );
    } finally {
      await rm(join(root, "back\\slash"));
    }
  });

  test("with `root` (Windows)", windowsOnly, async () => {
    deepStrictEqual(
      (await serve("dir\\nested.txt", { root })).body.toString(),
      "nested",
    );
    for (const path of [
      "\\index.html",
      "C:index.html",
      "index.html:stream",
      "dir\\..\\index.html",
    ]) {
      deepStrictEqual(await status(path), 404, path);
    }
    // A junction that leads out
    await symlink(join(tmp, "private"), join(root, "junction"), "junction");
    try {
      deepStrictEqual(await status("junction\\secret.txt"), 404);
    } finally {
      await rm(join(root, "junction"));
    }
  });

  test("without `root` (a trusted path)", async () => {
    const served = await serve(join(root, "a%20b"));
    deepStrictEqual([served.status, served.body.toString()], [200, "encoded"]);
    // Dotfiles and symbolic links are not checked
    deepStrictEqual((await serve(join(root, ".secret"))).status, 200);
    deepStrictEqual((await serve(join(root, "link-outside"))).status, 200);
    const url = await serve(pathToFileURL(join(root, "style.CSS")));
    deepStrictEqual(url.headers["content-type"], "text/css; charset=utf-8");
    const { status: code, error } = await serve(1 as unknown as string);
    deepStrictEqual(
      [code, error],
      [500, new TypeError("The path is not a string or a URL")],
    );
    // A missing file is an error of the application, not a 404
    const missing = await serve(join(root, "missing.txt"));
    deepStrictEqual(missing.status, 500);
    deepStrictEqual((missing.error as { code?: unknown }).code, "ENOENT");
  });

  test("options (invalid)", async () => {
    const checks: [ISendFileOptions, Error][] = [
      [
        { etag: 1 as unknown as boolean },
        new TypeError("`etag` is not a boolean"),
      ],
      [
        { last_modified: "no" as unknown as boolean },
        new TypeError("`last_modified` is not a boolean"),
      ],
      [
        { immutable: 1 as unknown as boolean, max_age: 1 },
        new TypeError("`immutable` is not a boolean"),
      ],
      [
        { dotfiles: "hide" as "deny" },
        new TypeError("`dotfiles` is not one of allow, deny and ignore"),
      ],
      [
        { validator: "abc" },
        new TypeError("`validator` is not a strong entity-tag"),
      ],
      [
        { validator: `W/"abc"` },
        new TypeError("`validator` is not a strong entity-tag"),
      ],
      [
        { validator: `"a"b"` },
        new TypeError("`validator` is not a strong entity-tag"),
      ],
      [
        { cache_control: "no-store", max_age: 1 },
        new TypeError("`cache_control` excludes `max_age` and `immutable`"),
      ],
      [
        { cache_control: "no-store", immutable: false },
        new TypeError("`cache_control` excludes `max_age` and `immutable`"),
      ],
      [
        { cache_control: "no-store\r\nX: y" },
        new TypeError("`cache_control` is not a valid field value"),
      ],
      [
        { cache_control: "" },
        new TypeError("`cache_control` is not a valid field value"),
      ],
      [{ max_age: 1.5 }, new TypeError("`max_age` is not an integer")],
      [
        { max_age: "1" as unknown as number },
        new TypeError("`max_age` is not an integer"),
      ],
      [{ max_age: -1 }, new RangeError("`max_age` is negative")],
      [{ immutable: true }, new TypeError("`immutable` needs `max_age`")],
      [{ content_type: "text" }, new TypeError("Invalid media type: text")],
      [
        { content_type: true as unknown as string },
        new TypeError("`content_type` is not a string or `false`"),
      ],
    ];
    for (const [options, expected] of checks) {
      const { status: code, error } = await serve(
        join(root, "index.html"),
        options,
      );
      deepStrictEqual([code, error], [500, expected]);
    }
  });

  test("options (`ETag`)", async () => {
    const file = join(root, "index.html");
    const send = async (
      options: ISendFileOptions,
      headers: Record<string, string> = {},
      etag = "",
    ): Promise<[number, unknown, string]> => {
      const handled = server.handle(async (_request, response) => {
        if (etag) {
          response.setHeader("ETag", etag);
        }
        await response.sendFile(file, options);
      });
      const reply = await server.request({ headers });
      deepStrictEqual(await handled, null);
      return [reply.status, reply.headers.etag ?? null, reply.body.toString()];
    };
    const stats = await stat(file);
    const weak = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    const range = { Range: "bytes=0-1" };

    deepStrictEqual(await send({}), [200, weak, html]);
    deepStrictEqual(await send({}, { "If-None-Match": weak }), [304, weak, ""]);
    // A weak tag does not satisfy `If-Range`
    deepStrictEqual(await send({}, { ...range, "If-Range": weak }), [
      200,
      weak,
      html,
    ]);
    deepStrictEqual(await send({ etag: false }), [200, null, html]);
    deepStrictEqual(await send({ etag: false }, { "If-None-Match": "*" }), [
      304,
      null,
      "",
    ]);
    // The `ETag` of the application stays
    deepStrictEqual(await send({}, {}, `"app"`), [200, `"app"`, html]);
    // A strong validator of the application
    const validator = `"sha-abc"`;
    deepStrictEqual(await send({ validator }, {}, `"app"`), [
      200,
      validator,
      html,
    ]);
    deepStrictEqual(
      await send(
        { validator, etag: false },
        { ...range, "If-Range": validator },
      ),
      [206, validator, html.slice(0, 2)],
    );
    deepStrictEqual(await send({ validator }, { "If-Match": validator }), [
      200,
      validator,
      html,
    ]);
    deepStrictEqual(await send({ validator }, { "If-None-Match": validator }), [
      304,
      validator,
      "",
    ]);
  });

  test("`304` has the length of the whole file, `412` is empty", async () => {
    const file = join(root, "index.html");
    const length = `${Buffer.byteLength(html)}`;
    const send = async (
      method: string,
      headers: Record<string, string>,
    ): Promise<[number, unknown, unknown, number]> => {
      const { status: code, ...reply } = await serve(
        file,
        {},
        { method, headers },
      );
      return [
        code,
        reply.headers["content-length"],
        reply.headers["content-type"],
        reply.body.length,
      ];
    };
    const type = "text/html; charset=utf-8";
    for (const method of ["GET", "HEAD"]) {
      deepStrictEqual(
        await send(method, { "If-None-Match": "*", Range: "bytes=0-1" }),
        [304, length, type, 0],
        method,
      );
    }
    // Not of the file: empty, also for `HEAD`
    for (const method of ["GET", "HEAD"]) {
      const [code, failed, , size] = await send(method, { "If-Match": `"x"` });
      deepStrictEqual([code, failed, size], [412, "0", 0], method);
    }
  });

  test("the status set before: the preconditions of a 2xx (or 412), the ranges of a 200", async () => {
    const size = `${Buffer.byteLength(html)}`;
    const check = async (
      code: number,
      method: string,
      headers: Record<string, string> = {},
    ): Promise<[number, string, string | null]> => {
      const handled = server.handle(async (_request, response) => {
        await response.status(code).sendFile("index.html", { root });
      });
      const reply = await server.request({ method, headers });
      deepStrictEqual(await handled, null);
      return [
        reply.status,
        reply.body.toString(),
        reply.headers["content-length"] ?? null,
      ];
    };
    const conditions: Record<string, string>[] = [
      {},
      { "If-None-Match": "*" },
      { "If-Modified-Since": "Wed, 01 Jan 2031 00:00:00 GMT" },
      { "If-Match": `"nope"` },
      { "If-Unmodified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" },
      { Range: "bytes=0-2" },
    ];
    // A redirect or an error (e.g. a page of an error) is sent whole with its
    // status, whatever the preconditions and the ranges (RFC 9110, section
    // 13.2.1), with the length of the file for `HEAD`
    for (const code of [302, 404, 503]) {
      for (const headers of conditions) {
        const name = `${code} ${JSON.stringify(headers)}`;
        deepStrictEqual(
          await check(code, "GET", headers),
          [code, html, size],
          name,
        );
        deepStrictEqual(
          await check(code, "HEAD", headers),
          [code, "", size],
          name,
        );
      }
    }
    // Another method with a 2xx keeps its preconditions, without ranges
    for (const method of ["POST", "PUT"]) {
      deepStrictEqual(await check(201, method), [201, html, size]);
      deepStrictEqual(await check(201, method, { Range: "bytes=0-2" }), [
        201,
        html,
        size,
      ]);
      for (const headers of conditions.slice(1, 5)) {
        // `If-Modified-Since` applies to `GET` and `HEAD` only
        const expected: [number, string, string | null] =
          "If-Modified-Since" in headers ? [201, html, size] : [412, "", "0"];
        deepStrictEqual(await check(201, method, headers), expected);
      }
      deepStrictEqual(await check(204, method), [204, "", null]);
      deepStrictEqual(await check(204, method, { "If-None-Match": "*" }), [
        412,
        "",
        "0",
      ]);
    }
    // Neither selected nor modified by `OPTIONS` and `TRACE`: their
    // preconditions are ignored (RFC 9110, section 13.2.1)
    for (const method of ["OPTIONS", "TRACE"]) {
      for (const headers of conditions) {
        deepStrictEqual(
          await check(200, method, headers),
          [200, html, size],
          `${method} ${JSON.stringify(headers)}`,
        );
      }
      deepStrictEqual(await check(201, method, { "If-Match": `"x"` }), [
        201,
        html,
        size,
      ]);
    }
    // A 2xx of `GET` other than 200 keeps its preconditions, without ranges
    deepStrictEqual(await check(203, "GET", { Range: "bytes=0-2" }), [
      203,
      html,
      size,
    ]);
    deepStrictEqual(await check(203, "GET", { "If-None-Match": "*" }), [
      304,
      "",
      size,
    ]);
    deepStrictEqual(await check(412, "GET", { "If-Match": `"nope"` }), [
      412,
      "",
      "0",
    ]);
    deepStrictEqual(await check(200, "GET", { Range: "bytes=0-2" }), [
      206,
      html.slice(0, 3),
      "3",
    ]);
  });

  test("a `304` that is late writes nothing", async () => {
    const handled = server.handle(async (_request, response) => {
      let late = true;
      const sent = response.sendFile(join(root, "index.html"));
      // Sealed while the file is opened
      response[kSeal](() => !late);
      await sent;
      late = false;
      ok(!response.headersSent);
      response.statusCode = 503;
      response.end();
    });
    const reply = await server.request({ headers: { "If-None-Match": "*" } });
    deepStrictEqual(await handled, null);
    deepStrictEqual(reply.status, 503);
  });

  test("options (`last_modified`)", async () => {
    const file = join(tmp, "outside.txt");
    // A strong `Last-Modified`
    const seconds = Math.floor(Date.now() / 1000) * 1000 - 3600 * 1000;
    await utimes(file, new Date(seconds), new Date(seconds));
    const lm = new Date(seconds).toUTCString();
    const old = new Date(seconds - 1000).toUTCString();
    const range = { Range: "bytes=0-1" };
    const send = async (
      options: ISendFileOptions,
      headers: Record<string, string>,
    ): Promise<[number, unknown]> => {
      const served = await serve(file, options, { headers });
      return [served.status, served.headers["last-modified"] ?? null];
    };

    deepStrictEqual(await send({}, { "If-Modified-Since": lm }), [304, lm]);
    deepStrictEqual(await send({}, { "If-Unmodified-Since": old }), [412, lm]);
    deepStrictEqual(await send({}, { ...range, "If-Range": lm }), [206, lm]);
    // Without it, the dates do not apply
    const none = { last_modified: false };
    deepStrictEqual(await send(none, {}), [200, null]);
    deepStrictEqual(await send(none, { "If-Modified-Since": lm }), [200, null]);
    deepStrictEqual(await send(none, { "If-Unmodified-Since": old }), [
      200,
      null,
    ]);
    deepStrictEqual(await send(none, { ...range, "If-Range": lm }), [
      200,
      null,
    ]);
  });

  test("options (`Cache-Control`)", async () => {
    const file = join(root, "index.html");
    const cacheControl = async (
      options: ISendFileOptions,
      headers: Record<string, string> = {},
    ): Promise<[number, unknown]> => {
      const served = await serve(file, options, { headers });
      return [served.status, served.headers["cache-control"] ?? null];
    };
    deepStrictEqual(await cacheControl({}), [200, null]);
    deepStrictEqual(await cacheControl({ cache_control: "no-cache" }), [
      200,
      "no-cache",
    ]);
    deepStrictEqual(await cacheControl({ max_age: 0 }), [
      200,
      "public, max-age=0",
    ]);
    deepStrictEqual(
      await cacheControl({ max_age: 31536000, immutable: true }),
      [200, "public, max-age=31536000, immutable"],
    );
    deepStrictEqual(await cacheControl({ max_age: 60, immutable: false }), [
      200,
      "public, max-age=60",
    ]);
    // Also on `304 Not Modified`
    deepStrictEqual(
      await cacheControl({ max_age: 60 }, { "If-None-Match": "*" }),
      [304, "public, max-age=60"],
    );
  });

  test("options (`content_type`)", async () => {
    const type = async (
      path: string,
      options: ISendFileOptions = {},
      set = "",
    ): Promise<unknown> => {
      const handled = server.handle(async (_request, response) => {
        if (set) {
          response.setHeader("Content-Type", set);
        }
        await response.sendFile(join(root, path), options);
      });
      const { headers } = await server.request();
      deepStrictEqual(await handled, null);
      return headers["content-type"] ?? null;
    };
    deepStrictEqual(await type("style.CSS"), "text/css; charset=utf-8");
    deepStrictEqual(await type("data.unknown"), "application/octet-stream");
    deepStrictEqual(await type("noext"), "application/octet-stream");
    deepStrictEqual(
      await type("noext", { content_type: " Text/Plain; Charset=ISO-8859-1" }),
      "text/plain; charset=iso-8859-1",
    );
    deepStrictEqual(await type("index.html", { content_type: false }), null);
    // The `Content-Type` of the application stays
    deepStrictEqual(await type("index.html", {}, "text/x-app"), "text/x-app");
    deepStrictEqual(
      await type("index.html", { content_type: false }, "text/x-app"),
      "text/x-app",
    );
    deepStrictEqual(
      await type("index.html", { content_type: "text/x-option" }, "text/x-app"),
      "text/x-option",
    );
  });
});

suite("preconditionsOf", () => {
  test("CONNECT, OPTIONS and TRACE ignore the conditional fields (RFC 9110, 13.2.1)", () => {
    const conditions: Record<string, string>[] = [
      { "if-none-match": "*" },
      { "if-match": `"x"` },
      { "if-unmodified-since": "Thu, 01 Jan 1970 00:00:00 GMT" },
    ];
    const lm = new Date("2020-01-01T00:00:00Z");
    for (const headers of conditions) {
      for (const method of ["CONNECT", "OPTIONS", "TRACE"]) {
        const request = { method, headers } as unknown as IncomingMessage;
        deepStrictEqual(preconditionsOf(request, `"e"`, lm), null, method);
      }
      // The other methods evaluate them
      for (const method of ["POST", "DELETE"]) {
        const request = { method, headers } as unknown as IncomingMessage;
        deepStrictEqual(preconditionsOf(request, `"e"`, lm), 412, method);
      }
    }
  });
});
