import {
  DiskStore,
  type IFileSystem,
  StoredFile,
  storedForm,
} from "../src/disk.js";
import { PassThrough, Readable } from "node:stream";
import { type ReadStream, constants } from "node:fs";
import { type TestContext, describe, it } from "node:test";
import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { eventually, never, sleep, within } from "./helpers.js";
import fs, {
  type FileHandle,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** The file system, with some of its operations replaced */
function system(overrides: Partial<IFileSystem> = {}): IFileSystem {
  return {
    mkdtemp: (prefix) => fs.mkdtemp(prefix),
    open: (path, flags, mode) => fs.open(path, flags, mode),
    link: (existing, target) => fs.link(existing, target),
    lstat: (path, options) => fs.lstat(path, options),
    unlink: (path) => fs.unlink(path),
    rmdir: (path) => fs.rmdir(path),
    ...overrides,
  };
}

const posix = process.platform !== "win32";

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

  it("copies a file where there cannot be a hard link", async (t) => {
    for (const code of ["EXDEV", "EPERM", "ENOTSUP", "EMLINK"]) {
      const { root, store } = await create(t, {
        link: () => Promise.reject(failure(code)),
      });
      const target = join(root, "kept.txt");

      const file = store.add(info, content("Hello"));
      await file.written;
      const temp = file.path;
      await file.persist(target);
      await store.cleanup();

      const { mode, nlink } = await stat(target);
      deepEqual(
        [
          await readdir(root),
          await readFile(target, "utf8"),
          posix ? mode & 0o777 : 0o600,
          nlink,
        ],
        [["kept.txt"], "Hello", 0o600, 1],
      );
      ok(temp !== target);
    }
  });

  it("throws the other errors of a hard link, without a copy", async (t) => {
    const { root, store } = await create(t, {
      link: () => Promise.reject(failure("EACCES")),
    });

    const file = store.add(info, content("Hello"));
    await rejects(file.persist(join(root, "kept.txt")), failure("EACCES"));

    equal((await readdir(root)).includes("kept.txt"), false);
  });

  it("removes what a failed copy has written, and keeps the file", async (t) => {
    let copies = 0;
    const { root, store } = await create(t, {
      link: () => Promise.reject(failure("EXDEV")),
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        if (flags === constants.O_RDONLY && (copies += 1) === 1) {
          // Fails once a part has been written
          handle.createReadStream = (): ReadStream =>
            Readable.from(
              (async function* chunks(): AsyncGenerator<Buffer> {
                yield Buffer.from("Hel");
                await sleep(10);
                throw failure("EIO");
              })(),
            ) as ReadStream;
        }
        return handle;
      },
    });
    const target = join(root, "kept.txt");

    const file = store.add(info, content("Hello"));
    await rejects(file.persist(target), failure("EIO"));
    equal((await readdir(root)).includes("kept.txt"), false);
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

  it("never removes a target that it has not created, also when the file is gone", async (t) => {
    let temp = "";
    const { root, store } = await create(t, {
      // The temporary file disappears before the copy
      link: async () => {
        await fs.unlink(temp);
        throw failure("EXDEV");
      },
    });
    const existing = join(root, "existing.txt");
    await writeFile(existing, "Existing");

    for (const target of [existing, join(root, "new.txt")]) {
      const file = store.add(info, content("Hello"));
      await file.written;
      temp = file.path;
      await rejects(file.persist(target), {
        code: target === existing ? "EEXIST" : "ENOENT",
      });
    }

    deepEqual(
      [
        (await readdir(root)).filter((name) => name.endsWith(".txt")),
        await readFile(existing, "utf8"),
      ],
      [["existing.txt"], "Existing"],
    );
  });

  it("never removes a file or a link that has replaced its target during a failed copy", async (t) => {
    const replacements = posix ? ["file", "link"] : ["file"];
    for (const replacement of replacements) {
      let target = "";
      let moved = "";
      const { root, store } = await create(t, {
        link: () => Promise.reject(failure("EXDEV")),
        open: async (path, flags, mode) => {
          if (flags === constants.O_RDONLY) {
            // Another process replaces the file of the copy, which then fails
            if (replacement === "file") {
              await writeFile(moved, "Another");
              await rename(moved, target);
            } else {
              await rename(target, moved);
              await symlink(moved, target);
            }
            throw failure("EIO");
          }
          return fs.open(path, flags, mode);
        },
      });
      target = join(root, "kept.txt");
      moved = join(root, "moved.txt");

      const file = store.add(info, content("Hello"));
      await rejects(file.persist(target), failure("EIO"));

      ok(
        replacement === "file"
          ? (await readFile(target, "utf8")) === "Another"
          : (await lstat(target)).isSymbolicLink(),
        replacement,
      );
    }
  });

  it("closes the descriptors of a copy, whether it succeeds or fails", async (t) => {
    const handles: FileHandle[] = [];
    let fail = "";
    const { root, store } = await create(t, {
      link: () => Promise.reject(failure("EXDEV")),
      open: async (path, flags, mode) => {
        if (fail === "open" && flags === constants.O_RDONLY) {
          throw failure("EMFILE");
        }
        const handle = await fs.open(path, flags, mode);
        handles.push(handle);
        if (fail === "read" && flags === constants.O_RDONLY) {
          handle.createReadStream = (): ReadStream =>
            Readable.from(
              (async function* chunks(): AsyncGenerator<Buffer> {
                yield Buffer.from("Hel");
                await sleep(10);
                throw failure("EIO");
              })(),
            ) as ReadStream;
        }
        return handle;
      },
    });

    for (const failing of ["", "read", "open"]) {
      fail = failing;
      const file = store.add(info, content("Hello"));
      await file.persist(join(root, `${failing}.txt`)).catch(() => null);
    }

    // The temporary files, and for each copy its target and (once it can be
    // opened) its source
    equal(handles.length, 8);
    deepEqual(
      handles.map(({ fd }) => fd),
      handles.map(() => -1),
    );
  });

  it("fails a copy that cannot close its file, and removes it", async (t) => {
    const { root, store } = await create(t, {
      link: () => Promise.reject(failure("EXDEV")),
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        if (path.endsWith("kept.txt")) {
          const close = handle.close.bind(handle);
          handle.close = async (): Promise<void> => {
            await close();
            throw failure("EIO");
          };
        }
        return handle;
      },
    });

    const file = store.add(info, content("Hello"));
    await rejects(file.persist(join(root, "kept.txt")), failure("EIO"));

    equal((await readdir(root)).includes("kept.txt"), false);
  });

  it("leaves the file of a copy that cannot tell what it has created", async (t) => {
    const { root, store } = await create(t, {
      link: () => Promise.reject(failure("EXDEV")),
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        if (path.endsWith("kept.txt")) {
          handle.stat = (): Promise<never> => Promise.reject(failure("EIO"));
        }
        return handle;
      },
    });

    const file = store.add(info, content("Hello"));
    await rejects(file.persist(join(root, "kept.txt")), failure("EIO"));

    // It cannot be told from a file that has replaced it
    equal((await readdir(root)).includes("kept.txt"), true);
  });

  it("throws the error of a copy, also when what it has written cannot be removed", async (t) => {
    const { root, store } = await create(t, {
      link: () => Promise.reject(failure("EXDEV")),
      open: async (path, flags, mode) => {
        if (flags === constants.O_RDONLY) {
          throw failure("EIO");
        }
        return fs.open(path, flags, mode);
      },
      unlink: async (path) => {
        if (path.endsWith("kept.txt")) {
          throw failure("EACCES");
        }
        await fs.unlink(path);
      },
    });

    const file = store.add(info, content("Hello"));

    await rejects(file.persist(join(root, "kept.txt")), failure("EIO"));
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

/**
 * The steps of the iterators of arrays while `fn` runs: a spread copies an
 * array with them, one step for each element
 */
function arraySteps(fn: () => void): number {
  const prototype = Object.getPrototypeOf([][Symbol.iterator]()) as Record<
    "next",
    (...args: unknown[]) => unknown
  >;
  const original = prototype.next;
  let steps = 0;
  prototype.next = function next(this: unknown, ...args: unknown[]): unknown {
    steps += 1;
    return original.apply(this, args);
  };
  try {
    fn();
  } finally {
    prototype.next = original;
  }
  return steps;
}

describe("storedForm()", () => {
  it("collects the fields and the stored files by name, in their order", () => {
    const file = new StoredFile(info, system(), never(), content(""));
    const other = new StoredFile(info, system(), never(), content(""));

    const { fields, files } = storedForm([
      { name: "a", value: "1" },
      { name: "file", value: file },
      { name: "skipped", value: null },
      { name: "a", value: "2" },
      { name: "b", value: "3" },
      { name: "file", value: other },
    ]);

    deepEqual(
      [[...fields], [...files.keys()], files.get("file")],
      [
        [
          ["a", ["1", "2"]],
          ["b", ["3"]],
        ],
        ["file"],
        [file, other],
      ],
    );
  });

  it("takes a time linear in the count of the parts of a name", () => {
    const count = 2000;
    const file = new StoredFile(info, system(), never(), content(""));
    const parts = Array.from({ length: count }, (_, index) => ({
      name: index % 2 === 0 ? "field" : "file",
      value: index % 2 === 0 ? String(index) : file,
    }));

    let form = storedForm([]);
    const steps = arraySteps(() => {
      form = storedForm(parts);
    });

    // One step for each part, by the loop over them: a copy of the values
    // of a name for each value would take a million more
    ok(steps <= 2 * count, `${steps} steps`);
    deepEqual(
      [form.fields.get("field")?.length, form.files.get("file")?.length],
      [count / 2, count / 2],
    );
  });
});
