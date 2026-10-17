import { Agent, type IncomingMessage, request as httpRequest } from "node:http";
import { BindenError, type Context } from "binden";
import { type TestContext, describe, it } from "node:test";
import { basename, dirname, join } from "node:path";
import {
  body,
  eventually,
  part,
  post,
  serve,
  sleep,
  type,
  within,
} from "./helpers.js";
import { deepEqual, equal, ok } from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import multipart, { type IStoredFile, type IStoredForm } from "../index.js";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";

const uuid =
  /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const posix = process.platform !== "win32";

/** A directory of the test, removed after it */
async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "binden-multipart-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The stored files of the form, in their order */
function filesOf(context: Context): IStoredFile[] {
  return [...(context.request.body as IStoredForm).files.values()].flat();
}

/** A form of two fields and two files */
const form = body(
  part('name="a"', "1"),
  part('name="file"; filename="../../etc/passwd"', "Hello"),
  part('name="a"', "2"),
  part('name="file"; filename="b.png"', "World", ["Content-Type: image/png"]),
);

describe("Multipart (disk storage)", () => {
  it("stores the files in a private directory, which is removed after the response", async (t) => {
    const seen: unknown[] = [];
    const paths: string[] = [];
    const { url } = await serve(t, [
      multipart({ storage: {} }),
      async (context: Context): Promise<void> => {
        const { fields, files } = context.request.body as IStoredForm;
        seen.push([...fields], [...files.keys()]);
        for (const file of filesOf(context)) {
          const { field, filename, mime_type, encoding, size, truncated } =
            file;
          const dir = dirname(file.path);
          paths.push(file.path, dir);
          seen.push([
            field,
            filename,
            mime_type,
            encoding,
            size,
            truncated,
            await readFile(file.path, "utf8"),
            uuid.test(basename(file.path)),
            dir.startsWith(join(tmpdir(), "binden-multipart-")),
            posix ? (await stat(dir)).mode & 0o777 : 0o700,
            posix ? (await stat(file.path)).mode & 0o777 : 0o600,
          ]);
        }
        await context.send();
      },
    ]);

    const reply = await post(url, form);

    equal(reply.status, 200);
    deepEqual(seen, [
      [["a", ["1", "2"]]],
      ["file"],
      [
        "file",
        "passwd",
        "text/plain",
        "7bit",
        5,
        false,
        "Hello",
        true,
        true,
        0o700,
        0o600,
      ],
      [
        "file",
        "b.png",
        "image/png",
        "7bit",
        5,
        false,
        "World",
        true,
        true,
        0o700,
        0o600,
      ],
    ]);
    await eventually(() => paths.every((path) => !existsSync(path)));
  });

  it("stores the files under `storage.dir`", async (t) => {
    const dir = await directory(t);
    const parents: string[] = [];
    const { url } = await serve(t, [
      multipart({ storage: { dir } }),
      async (context: Context): Promise<void> => {
        for (const file of filesOf(context)) {
          parents.push(dirname(dirname(file.path)));
        }
        await context.send();
      },
    ]);

    const reply = await post(url, form);

    equal(reply.status, 200);
    deepEqual(parents, [dir, dir]);
    await eventually(async () => (await readdir(dir)).length === 0);
  });

  it("resolves a relative `storage.dir` when the middleware is created", async (t) => {
    const dir = await directory(t);
    const cwd = process.cwd();
    process.chdir(dir);
    const parser = multipart({ storage: { dir: "uploads" } });
    const uploads = join(process.cwd(), "uploads");
    process.chdir(cwd);
    await mkdir(uploads);
    const parents: string[] = [];
    const { url } = await serve(t, [
      parser,
      async (context: Context): Promise<void> => {
        for (const file of filesOf(context)) {
          parents.push(dirname(dirname(file.path)));
        }
        await context.send();
      },
    ]);

    const reply = await post(url, form);

    equal(reply.status, 200);
    deepEqual(parents, [uploads, uploads]);
  });

  it("persists the files that are moved to a path of their own", async (t) => {
    const dir = await directory(t);
    const target = join(dir, "kept.txt");
    const outcomes: unknown[] = [];
    let temp = "";
    const { url } = await serve(t, [
      multipart({ storage: {} }),
      async (context: Context): Promise<void> => {
        const [file] = filesOf(context);
        temp = file.path;
        await file.persist(target);
        await file.persist(join(dir, ".", "kept.txt"));
        await file
          .persist(join(dir, "other.txt"))
          .catch((error: unknown) => outcomes.push((error as Error).message));
        outcomes.push(file.path, existsSync(temp));
        await context.send();
      },
    ]);

    const reply = await post(url, form);

    equal(reply.status, 200);
    deepEqual(outcomes, [
      "The file has already been persisted elsewhere",
      target,
      false,
    ]);
    await eventually(() => !existsSync(dirname(temp)));
    equal(await readFile(target, "utf8"), "Hello");
    deepEqual(await readdir(dir), ["kept.txt"]);
  });

  it("never replaces an existing file or link when it persists a file", async (t) => {
    const dir = await directory(t);
    const existing = join(dir, "existing.txt");
    const link = join(dir, "link.txt");
    await writeFile(existing, "Existing");
    await symlink(join(dir, "missing.txt"), link);
    const codes: unknown[] = [];
    const { url } = await serve(t, [
      multipart({ storage: {} }),
      async (context: Context): Promise<void> => {
        const [file] = filesOf(context);
        for (const target of [existing, link, join(dir, "none", "a.txt")]) {
          await file.persist(target).catch((error: unknown) => {
            codes.push((error as NodeJS.ErrnoException).code);
          });
        }
        // Still owned by the storage: it can be persisted elsewhere
        await file.persist(join(dir, "kept.txt"));
        await context.send();
      },
    ]);

    const reply = await post(url, form);

    equal(reply.status, 200);
    deepEqual(codes, ["EEXIST", "EEXIST", "ENOENT"]);
    equal(await readFile(existing, "utf8"), "Existing");
    equal(await readFile(join(dir, "kept.txt"), "utf8"), "Hello");
  });

  it("refuses to persist a file once the response is closed", async (t) => {
    const { promise: outcome, resolve } = Promise.withResolvers<unknown>();
    const { url } = await serve(t, [
      multipart({ storage: {} }),
      async (context: Context): Promise<void> => {
        const [file] = filesOf(context);
        context.response.once("close", () => {
          setTimeout(() => {
            file.persist(join(tmpdir(), "binden-never")).then(resolve, resolve);
          }, 50);
        });
        await context.send();
      },
    ]);

    equal((await post(url, form)).status, 200);
    const error = await within(outcome);

    ok(error instanceof Error);
    equal(error.message, "The file has been removed");
  });

  it("stores a body received before the cleanup, refuses the files that come after it", async (t) => {
    const dir = await directory(t);
    const { promise: settled, resolve: settle } =
      Promise.withResolvers<unknown>();
    const { promise: cleaned, resolve: clean } = Promise.withResolvers<null>();
    const parser = multipart({ storage: { dir } });
    const { url } = await serve(t, [
      async (context: Context): Promise<void> => {
        // Not awaited: the response is closed before the body is received
        parser.run(context).then(settle, settle);
        context.onCleanup(() => {
          clean(null);
        });
        await context.send("early");
      },
    ]);

    // Kept alive: the server reads the rest of the body after its reply
    const agent = new Agent({ keepAlive: true });
    t.after(() => {
      agent.destroy();
    });
    const client = httpRequest(url, {
      method: "POST",
      agent,
      headers: { "Content-Type": type, "Content-Length": form.length },
    });
    client.on("error", () => {
      // The test closes the connection
    });
    client.flushHeaders();
    const [response] = (await within(once(client, "response"))) as [
      IncomingMessage,
    ];
    response.resume();
    await within(cleaned);
    // The whole body, once the cleanup of the request has started
    client.end(form);
    const error = await within(settled);
    client.destroy();

    ok(error instanceof BindenError);
    deepEqual(
      [error.status, error.message, (error.cause as Error).message],
      [
        500,
        "A file cannot be stored once the cleanup of the request has started",
        "The request has been completed",
      ],
    );
    deepEqual(await readdir(dir), []);
  });

  it("keeps a persisted file when the client goes away", async (t) => {
    const dir = await directory(t);
    const target = join(dir, "kept.txt");
    const { promise: persisted, resolve } = Promise.withResolvers<string>();
    const { url } = await serve(t, [
      multipart({ storage: {} }),
      async (context: Context): Promise<void> => {
        const [file] = filesOf(context);
        await file.persist(target);
        resolve(file.path);
        // Never replies: the client goes away
        await new Promise((settle) => {
          context.signal.addEventListener("abort", settle);
        });
      },
    ]);

    const client = httpRequest(url, {
      method: "POST",
      headers: { "Content-Type": type },
    });
    client.on("error", () => {
      // The connection is closed on purpose
    });
    client.end(form);
    await within(persisted);
    client.destroy();
    await sleep(50);

    equal(await readFile(target, "utf8"), "Hello");
  });

  it("tells the size and the truncation of the files (`throw_limits: false`)", async (t) => {
    const seen: unknown[] = [];
    const { url } = await serve(t, [
      multipart({
        storage: {},
        throw_limits: false,
        config: { limits: { fileSize: 3 } },
      }),
      async (context: Context): Promise<void> => {
        for (const { size, truncated, path } of filesOf(context)) {
          seen.push([size, truncated, await readFile(path, "utf8")]);
        }
        await context.send();
      },
    ]);

    const reply = await post(
      url,
      body(
        part('name="a"; filename="a.txt"', "Hello"),
        part('name="b"; filename="b.txt"', "Hi"),
      ),
    );

    equal(reply.status, 200);
    deepEqual(seen, [
      [3, true, "Hel"],
      [2, false, "Hi"],
    ]);
  });

  it("does not store the skipped files", async (t) => {
    const dir = await directory(t);
    const seen: unknown[] = [];
    const { url } = await serve(t, [
      multipart({
        storage: { dir },
        filtered: "skip",
        file_filter: ({ mime_type }) => mime_type === "image/png",
      }),
      async (context: Context): Promise<void> => {
        const files = filesOf(context);
        seen.push(files.map(({ filename }) => filename));
        const [file] = files;
        seen.push((await readdir(dirname(file.path))).length);
        await context.send();
      },
    ]);

    const reply = await post(url, form);

    equal(reply.status, 200);
    deepEqual(seen, [["b.png"], 1]);
    await eventually(async () => (await readdir(dir)).length === 0);
  });

  it("removes the files of a refused or aborted request", async (t) => {
    const dir = await directory(t);
    const { url } = await serve(t, [
      multipart({ storage: { dir }, limit: 1 << 16 }),
    ]);
    const data = body(
      part('name="a"; filename="a.txt"', "a"),
      part('name="b"; filename="b.bin"', "b".repeat(1 << 17)),
    );

    // Refused by `limit` in the middle of the second file
    const reply = await new Promise<number | undefined>((resolve, reject) => {
      const client = httpRequest(url, {
        method: "POST",
        headers: { "Content-Type": type, "Transfer-Encoding": "chunked" },
        signal: AbortSignal.timeout(10_000),
      });
      client
        .once("response", (response) => {
          response.resume();
          resolve(response.statusCode);
          client.destroy();
        })
        .once("error", reject)
        .write(data.slice(0, 2048));
      setTimeout(() => {
        client.write(data.slice(2048));
      }, 50);
    });
    equal(reply, 413);
    await eventually(async () => (await readdir(dir)).length === 0);

    // Aborted by the client in the middle of the second file
    const client = httpRequest(url, {
      method: "POST",
      headers: { "Content-Type": type, "Transfer-Encoding": "chunked" },
    });
    client.on("error", () => {
      // The connection is closed on purpose
    });
    client.write(data.slice(0, 2048));
    await eventually(async () => (await readdir(dir)).length === 1);
    await sleep(20);
    client.destroy();
    await eventually(async () => (await readdir(dir)).length === 0);
  });

  it("replies `500` when the files cannot be stored", async (t) => {
    const dir = await directory(t);
    const missing = join(dir, "missing");
    const { url } = await serve(t, [multipart({ storage: { dir: missing } })]);

    const reply = await post(url, form);

    equal(reply.status, 500);
    equal(existsSync(missing), false);
  });

  it("passes the errors of `persist()` to the application", async (t) => {
    const errors: unknown[] = [];
    const { url } = await serve(t, [
      multipart({ storage: {} }),
      async (context: Context): Promise<void> => {
        const [file] = filesOf(context);
        for (const target of ["", 1]) {
          await file
            .persist(target as string)
            .catch((error: unknown) => errors.push(error));
        }
        throw new BindenError(409);
      },
    ]);

    equal((await post(url, form)).status, 409);
    deepEqual(errors, [
      new TypeError("`target` is not a non-empty string"),
      new TypeError("`target` is not a non-empty string"),
    ]);
  });
});
