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
import { deepStrictEqual, ok } from "node:assert/strict";
import fsp, { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";

interface IServed extends IReply {
  /** `null` once `sendFile()` has resolved, otherwise its error */
  readonly error: unknown;
}

const posixOnly = { skip: process.platform === "win32" };

suite("sendFile (kinds of files)", () => {
  let root: string;
  let server: ITestServer;

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "binden-kinds-")));
    await writeFile(join(root, "file.txt"), "file");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
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
    path: string,
    options?: ISendFileOptions,
  ): Promise<IServed> => {
    let error: unknown = null;
    const handled = server.handle(async (_request, response) => {
      try {
        await response.sendFile(path, options);
      } catch (reason: unknown) {
        error = reason;
        const status = reason instanceof BindenError ? reason.status : 500;
        await response.status(status).send();
      }
    });
    const reply = await server.request();
    deepStrictEqual(await handled, null);
    return { ...reply, error };
  };

  /** Counts the files that `sendFile()` opens */
  const counting = (): { count: number } => {
    const opened = { count: 0 };
    const { open: original } = fsp;
    mock.method(fsp, "open", async (...args: Parameters<typeof original>) => {
      opened.count += 1;
      return original(...args);
    });
    syncBuiltinESMExports();
    return opened;
  };

  test("a socket under `root` is not found", posixOnly, async () => {
    const path = join(root, "socket");
    const listening = createServer().listen(path);
    await once(listening, "listening");
    try {
      const opened = counting();
      const { status, error } = await serve("socket", { root });
      deepStrictEqual([status, opened.count], [404, 0]);
      ok(error instanceof BindenError);
    } finally {
      listening.close();
      await once(listening, "close");
    }
  });

  test("a FIFO under `root` is not found, nor opened", posixOnly, async () => {
    execFileSync("mkfifo", [join(root, "fifo")]);
    const opened = counting();
    deepStrictEqual((await serve("fifo", { root })).status, 404);
    deepStrictEqual(opened.count, 0);
  });

  test("a file that cannot be opened as a regular file under `root` is not found", async () => {
    const failing = (code: string): void => {
      mock.restoreAll();
      const error = Object.assign(new Error(code), { code });
      mock.method(fsp, "open", () => Promise.reject(error));
      syncBuiltinESMExports();
    };
    // E.g. replaced by a socket (`ENXIO`, or `EOPNOTSUPP` on macOS) or a
    // device without a driver (`ENODEV`) once checked
    for (const code of ["ENXIO", "EOPNOTSUPP", "ENODEV"]) {
      failing(code);
      const under = await serve("file.txt", { root });
      deepStrictEqual(under.status, 404, code);
      ok(under.error instanceof BindenError);
      deepStrictEqual((under.error.cause as { code?: unknown }).code, code);
      // A trusted path rejects with the error of the filesystem
      const trusted = await serve(join(root, "file.txt"));
      deepStrictEqual(
        [trusted.status, (trusted.error as { code?: unknown }).code],
        [500, code],
      );
    }
  });

  test(
    "a file replaced by a directory once checked is not found",
    posixOnly,
    async () => {
      await mkdir(join(root, "dir"));
      const { lstat: original } = fsp;
      // A regular file when checked, a directory when opened
      mock.method(fsp, "lstat", async (path: string) =>
        Object.assign(await original(path), { isFile: () => true }),
      );
      syncBuiltinESMExports();
      const { status, error } = await serve("dir", { root });
      deepStrictEqual(status, 404);
      ok(error instanceof BindenError);
    },
  );

  test("a file removed once its real path is resolved is not found", async () => {
    const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mock.method(fsp, "lstat", () => Promise.reject(error));
    syncBuiltinESMExports();
    const { status, error: reason } = await serve("file.txt", { root });
    deepStrictEqual(status, 404);
    ok(reason instanceof BindenError);
    deepStrictEqual(reason.cause, error);
  });
});
