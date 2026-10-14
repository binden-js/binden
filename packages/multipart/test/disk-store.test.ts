import { DiskStore, type IFileSystem } from "../src/disk.js";
import { PassThrough, Readable } from "node:stream";
import { type TestContext, describe, it } from "node:test";
import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { eventually, sleep, within } from "./helpers.js";
import fs, {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** The file system, with some of its operations replaced */
function system(overrides: Partial<IFileSystem> = {}): IFileSystem {
  return {
    mkdtemp: (prefix) => fs.mkdtemp(prefix),
    open: (path, flags, mode) => fs.open(path, flags, mode),
    link: (existing, target) => fs.link(existing, target),
    copyFile: (source, target, mode) => fs.copyFile(source, target, mode),
    unlink: (path) => fs.unlink(path),
    rmdir: (path) => fs.rmdir(path),
    ...overrides,
  };
}

/** An error of the system */
function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** A store of a test, and its directory */
interface ITestStore {
  readonly root: string;
  readonly store: DiskStore;
}

/** A store under a directory of the test (removed after it) */
async function create(
  t: TestContext,
  overrides: Partial<IFileSystem> = {},
): Promise<ITestStore> {
  const root = await mkdtemp(join(tmpdir(), "binden-multipart-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DiskStore(
    root,
    () => {
      // Run by the tests (`store.cleanup()`)
    },
    system(overrides),
  );
  return { root, store };
}

const info = {
  field: "file",
  filename: "file.txt",
  mime_type: "text/plain",
  encoding: "7bit",
};

/** A stream of a content */
function content(text: string): Readable {
  return Readable.from([Buffer.from(text)]);
}

describe("DiskStore", () => {
  it("registers its cleanup, then opens new private files in a directory of its own", async (t) => {
    const calls: unknown[] = [];
    const root = await mkdtemp(join(tmpdir(), "binden-multipart-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let cleanup = (): Promise<void> => Promise.resolve();
    const store = new DiskStore(
      root,
      (registered) => {
        calls.push("register");
        cleanup = registered;
      },
      system({
        mkdtemp: (prefix) => {
          calls.push(["mkdtemp", prefix]);
          return fs.mkdtemp(prefix);
        },
        open: (path, flags, mode) => {
          calls.push(["open", flags, mode]);
          return fs.open(path, flags, mode);
        },
      }),
    );

    const file = store.add(info, content("Hello"));
    await file.written;

    const { O_CREAT, O_EXCL, O_WRONLY } = constants;
    deepEqual(calls, [
      "register",
      ["mkdtemp", join(root, "binden-multipart-")],
      ["open", O_CREAT | O_EXCL | O_WRONLY, 0o600],
    ]);
    deepEqual(
      [file.size, file.truncated, await readFile(file.path, "utf8")],
      [5, false, "Hello"],
    );
    await cleanup();
    deepEqual(await readdir(root), []);
  });

  it("persists a file once it is written", async (t) => {
    const { root, store } = await create(t);
    const stream = new PassThrough();
    const target = join(root, "kept.txt");

    const file = store.add(info, stream);
    const persisted = file.persist(target);
    stream.write("Hel");
    await sleep(10);
    stream.end("lo");
    await within(persisted);

    deepEqual([file.path, await readFile(target, "utf8")], [target, "Hello"]);
  });

  it("copies a file to another file system", async (t) => {
    const { root, store } = await create(t, {
      link: () => Promise.reject(failure("EXDEV")),
    });
    const target = join(root, "kept.txt");

    const file = store.add(info, content("Hello"));
    await file.written;
    const temp = file.path;
    await file.persist(target);
    await store.cleanup();

    deepEqual(await readdir(root), ["kept.txt"]);
    equal(await readFile(target, "utf8"), "Hello");
    ok(temp !== target);
  });

  it("removes what a failed copy has written, and keeps the file", async (t) => {
    let copies = 0;
    const { root, store } = await create(t, {
      link: () => Promise.reject(failure("EXDEV")),
      copyFile: async (source, target, mode) => {
        copies += 1;
        if (copies === 1) {
          await writeFile(target, "Hel");
          throw failure("ENOSPC");
        }
        await fs.copyFile(source, target, mode);
      },
    });
    const target = join(root, "kept.txt");

    const file = store.add(info, content("Hello"));
    await rejects(file.persist(target), failure("ENOSPC"));
    deepEqual((await readdir(root)).includes("kept.txt"), false);
    await file.persist(target);

    equal(await readFile(target, "utf8"), "Hello");
  });

  it("never removes the existing target of a copy", async (t) => {
    const { root, store } = await create(t, {
      link: () => Promise.reject(failure("EXDEV")),
    });
    const target = join(root, "existing.txt");
    await writeFile(target, "Existing");

    const file = store.add(info, content("Hello"));
    await rejects(file.persist(target), { code: "EEXIST" });

    equal(await readFile(target, "utf8"), "Existing");
  });

  it("throws the error of a copy, also when what it has written cannot be removed", async (t) => {
    const { root, store } = await create(t, {
      link: () => Promise.reject(failure("EXDEV")),
      copyFile: () => Promise.reject(failure("ENOSPC")),
      unlink: async (path) => {
        if (path.endsWith("kept.txt")) {
          throw failure("EACCES");
        }
        await fs.unlink(path);
      },
    });

    const file = store.add(info, content("Hello"));

    await rejects(file.persist(join(root, "kept.txt")), failure("ENOSPC"));
  });

  it("leaves the temporary file of a persisted file that cannot be removed to the cleanup", async (t) => {
    let failed = false;
    const { root, store } = await create(t, {
      unlink: async (path) => {
        if (!failed) {
          failed = true;
          throw failure("EBUSY");
        }
        await fs.unlink(path);
      },
    });
    const target = join(root, "kept.txt");

    const file = store.add(info, content("Hello"));
    await file.written;
    const temp = file.path;
    await file.persist(target);
    const left = await readFile(temp, "utf8");
    // A hard link: the same file
    const linked = (await stat(temp)).ino === (await stat(target)).ino;
    await store.cleanup();

    deepEqual([file.path, left, linked], [target, "Hello", true]);
    deepEqual(await readdir(root), ["kept.txt"]);
  });

  it("waits for a file being persisted before it removes the files", async (t) => {
    const { promise: gate, resolve: open } = Promise.withResolvers<null>();
    const { root, store } = await create(t, {
      link: async (existing, target) => {
        await gate;
        await fs.link(existing, target);
      },
    });
    const target = join(root, "kept.txt");

    const file = store.add(info, content("Hello"));
    await file.written;
    const persisted = file.persist(target);
    await sleep(10);
    const cleaned = store.cleanup();
    await sleep(10);
    open(null);
    await within(Promise.all([persisted, cleaned]));

    deepEqual(await readdir(root), ["kept.txt"]);
    equal(await readFile(target, "utf8"), "Hello");
  });

  it("does not persist nor add a file once it has been cleaned up", async (t) => {
    const { root, store } = await create(t);

    const file = store.add(info, content("Hello"));
    await file.written;
    await store.cleanup();

    await rejects(
      file.persist(join(root, "kept.txt")),
      new Error("The file has been removed"),
    );
    throws(
      () => store.add(info, content("Hello")),
      new Error("The storage has been cleaned up"),
    );
    deepEqual(await readdir(root), []);
  });

  it("does not persist a file that has not been written", async (t) => {
    const { root, store } = await create(t);
    const stream = new PassThrough();

    // Observed, like the streams of busboy
    stream.on("error", () => {
      // Reported by the write
    });
    const file = store.add(info, stream);
    stream.destroy(new Error("A failure"));

    await rejects(file.persist(join(root, "kept.txt")), new Error("A failure"));
  });

  it("reports every failure of its cleanup", async (t) => {
    const { store } = await create(t, {
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        const close = handle.close.bind(handle);
        handle.close = async (): Promise<void> => {
          await close();
          throw failure("EIO");
        };
        return handle;
      },
      unlink: () => Promise.reject(failure("EACCES")),
      rmdir: () => Promise.reject(failure("ENOTEMPTY")),
    });

    const file = store.add(info, content("Hello"));
    await rejects(file.written, failure("EIO"));
    const error = await store.cleanup().catch((thrown: unknown) => thrown);

    ok(error instanceof AggregateError);
    deepEqual(
      error.errors.map((each: NodeJS.ErrnoException) => each.code),
      ["EIO", "EACCES", "ENOTEMPTY"],
    );
  });

  it("stops the writes that are opening a file", async (t) => {
    const { promise: gate, resolve: open } = Promise.withResolvers<null>();
    const { root, store } = await create(t, {
      open: async (path, flags, mode) => {
        await gate;
        return fs.open(path, flags, mode);
      },
    });

    const file = store.add(info, content("Hello"));
    await eventually(async () => (await readdir(root)).length === 1);
    const cleaned = store.cleanup();
    open(null);

    await rejects(file.written, new Error("The storage has been cleaned up"));
    await within(cleaned);
    deepEqual(await readdir(root), []);
  });

  it("stops the writes in progress", async (t) => {
    const { root, store } = await create(t);
    const stream = new PassThrough();

    const file = store.add(info, stream);
    stream.write("Hel");
    await eventually(() => file.path !== "");
    await within(store.cleanup());

    await rejects(file.written);
    deepEqual(await readdir(root), []);
  });

  it("removes nothing when its directory cannot be created", async (t) => {
    const { store } = await create(t, {
      mkdtemp: () => Promise.reject(failure("ENOENT")),
    });

    const file = store.add(info, content("Hello"));

    await rejects(file.written, failure("ENOENT"));
    await within(store.cleanup());
  });
});
