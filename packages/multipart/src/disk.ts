import { type WriteStream, constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IFileInfo } from "./options.js";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

/** A file of the disk storage: what it declares, and where it is stored */
export interface IStoredFile extends IFileInfo {
  /**
   * Where the file is: a file of its own (`0600`, named by a random UUID) in
   * a private directory (`0700`) of the request, which is removed with it
   * once the response is closed, or where it has been persisted
   */
  readonly path: string;
  /** Its size in bytes */
  readonly size: number;
  /** Whether it has been truncated to `fileSize` */
  readonly truncated: boolean;
  /**
   * Moves the file to `target` (which must not exist: a file or a symbolic
   * link there is an `EEXIST` error), so that it is kept once the response
   * is closed: by a hard link, or a copy to another file system. Persisting
   * it again to the same path does nothing, to another one throws.
   */
  persist(target: string): Promise<void>;
}

/** The body that the disk storage sets: the fields and the stored files, by name, in their order */
export interface IStoredForm {
  /** The values of the fields, by name */
  readonly fields: Map<string, string[]>;
  /** The stored files, by the name of their field */
  readonly files: Map<string, IStoredFile[]>;
}

/** The operations of the file system of the disk storage (replaced by the tests) */
export interface IFileSystem {
  /** Creates the private directory of a request (see `fs.mkdtemp()`) */
  mkdtemp(prefix: string): Promise<string>;
  /** Opens a file (see `fs.open()`) */
  open(path: string, flags: number, mode: number): Promise<FileHandle>;
  /** Creates a hard link (see `fs.link()`) */
  link(existing: string, target: string): Promise<void>;
  /** Copies a file (see `fs.copyFile()`) */
  copyFile(source: string, target: string, mode: number): Promise<void>;
  /** Removes a file (see `fs.unlink()`) */
  unlink(path: string): Promise<void>;
  /** Removes an empty directory (see `fs.rmdir()`) */
  rmdir(path: string): Promise<void>;
}

/** A stream of the content of a file (`truncated` once it has been cut to `fileSize`) */
export type IFileStream = Readable & { truncated?: boolean };

/** Ignores an error that is reported otherwise */
function ignore(): void {
  // Reported otherwise
}

/** The `code` of a system error */
function codeOf(error: unknown): unknown {
  return (error as NodeJS.ErrnoException).code;
}

/** Removes a file, unless it does not exist */
async function unlinkIfExists(
  system: IFileSystem,
  path: string,
): Promise<void> {
  try {
    await system.unlink(path);
  } catch (error: unknown) {
    if (codeOf(error) !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * A file that the disk storage writes. Persisting it and removing it are
 * serialized: one waits for the other, so that the cleanup of the request
 * never removes a file that is being (or has been) persisted.
 */
export class StoredFile implements IStoredFile {
  /** The name of the field of the file */
  public readonly field: string;
  /** The name that the client has given to the file (metadata only) */
  public readonly filename: string;
  /** The media type that the client has declared */
  public readonly mime_type: string;
  /** The transfer encoding that the client has declared */
  public readonly encoding: string;
  /** Settles once the file is written (and its descriptor closed) */
  public readonly written: Promise<void>;
  readonly #system: IFileSystem;
  /** The temporary file, until it is removed */
  #temp: string | null = null;
  /** Where the file has been persisted */
  #target: string | null = null;
  #path = "";
  #size = 0;
  #truncated = false;
  #handle: FileHandle | null = null;
  #output: WriteStream | null = null;
  #stopped = false;
  #lock: Promise<void> = Promise.resolve();

  /** Starts writing the stream of a file part to a new file of the directory */
  public constructor(
    { field, filename, mime_type, encoding }: IFileInfo,
    system: IFileSystem,
    directory: Promise<string>,
    stream: IFileStream,
  ) {
    this.field = field;
    this.filename = filename;
    this.mime_type = mime_type;
    this.encoding = encoding;
    this.#system = system;
    this.written = this.#write(directory, stream);
  }

  /** Where the file is (see `IStoredFile.path`) */
  public get path(): string {
    return this.#path;
  }

  /** The size of the file in bytes */
  public get size(): number {
    return this.#size;
  }

  /** Whether the file has been truncated to `fileSize` */
  public get truncated(): boolean {
    return this.#truncated;
  }

  /**
   * Moves the file to `target` (see `IStoredFile.persist()`): a `TypeError` for
   * a target that is not a non-empty string
   */
  public async persist(target: string): Promise<void> {
    if (typeof target !== "string" || target === "") {
      throw new TypeError("`target` is not a non-empty string");
    }
    const path = resolve(target);
    await this.written;
    await this.#exclusive(async () => {
      if (this.#target !== null) {
        if (this.#target !== path) {
          throw new Error("The file has already been persisted elsewhere");
        }
        return;
      }
      const temp = this.#temp;
      if (temp === null) {
        throw new Error("The file has been removed");
      }
      await this.#move(temp, path);
      // Owned by the application from now on: never removed by the cleanup
      this.#target = path;
      this.#path = path;
      try {
        await this.#system.unlink(temp);
        this.#temp = null;
      } catch {
        // The cleanup removes it
      }
    });
  }

  /** Stops writing the file (its content is no longer read) */
  public stop(): void {
    this.#stopped = true;
    this.#output?.destroy();
  }

  /** Closes the descriptor of the file, if it is open */
  public async close(): Promise<void> {
    await this.#handle?.close();
  }

  /** Removes the temporary file, unless it has been persisted: it can no longer be persisted */
  public remove(): Promise<void> {
    return this.#exclusive(async () => {
      const temp = this.#temp;
      this.#temp = null;
      if (temp !== null) {
        await unlinkIfExists(this.#system, temp);
      }
    });
  }

  /** Writes the content into a new private file of the directory */
  async #write(directory: Promise<string>, stream: IFileStream): Promise<void> {
    const path = join(await directory, randomUUID());
    const { O_CREAT, O_EXCL, O_WRONLY } = constants;
    const handle = await this.#system.open(
      path,
      O_CREAT | O_EXCL | O_WRONLY,
      0o600,
    );
    // Created by the storage: removed by its cleanup
    this.#handle = handle;
    this.#temp = path;
    this.#path = path;
    if (this.#stopped) {
      throw new Error("The storage has been cleaned up");
    }
    const output = handle.createWriteStream();
    this.#output = output;
    await pipeline(stream, output);
    await handle.close();
    this.#size = output.bytesWritten;
    this.#truncated = stream.truncated === true;
  }

  /**
   * Moves the file: a hard link (which fails on an existing target), or a
   * copy that never replaces one to another file system. A copy that fails
   * removes what it has written.
   */
  async #move(source: string, target: string): Promise<void> {
    try {
      await this.#system.link(source, target);
      return;
    } catch (error: unknown) {
      if (codeOf(error) !== "EXDEV") {
        throw error;
      }
    }
    try {
      await this.#system.copyFile(source, target, constants.COPYFILE_EXCL);
    } catch (error: unknown) {
      if (codeOf(error) !== "EEXIST") {
        await unlinkIfExists(this.#system, target).catch(ignore);
      }
      throw error;
    }
  }

  /** Runs `fn` once the operations started before it have settled */
  #exclusive(fn: () => Promise<void>): Promise<void> {
    const run = this.#lock.then(fn);
    this.#lock = run.catch(ignore);
    return run;
  }
}

/**
 * The files of a request on the disk, in a private directory (`0700`) that
 * is created with the first one, and removed by the cleanup of the request
 * with every file that has not been persisted
 */
export class DiskStore {
  readonly #system: IFileSystem;
  readonly #directory: Promise<string>;
  readonly #files: StoredFile[] = [];
  #cleaned = false;

  /**
   * Registers the cleanup (with `register`, e.g. `context.onCleanup`) and
   * then creates the directory under `root`
   */
  public constructor(
    root: string,
    register: (cleanup: () => Promise<void>) => void,
    system: IFileSystem = fs,
  ) {
    this.#system = system;
    register(() => this.cleanup());
    this.#directory = system.mkdtemp(join(root, "binden-multipart-"));
    // Observed: the writes report it
    this.#directory.catch(ignore);
  }

  /**
   * Writes a file into the directory (see `StoredFile.written`): none once
   * the cleanup has started, which would leave it behind
   */
  public add(info: IFileInfo, stream: IFileStream): StoredFile {
    if (this.#cleaned) {
      throw new Error("The storage has been cleaned up");
    }
    const file = new StoredFile(info, this.#system, this.#directory, stream);
    this.#files.push(file);
    return file;
  }

  /**
   * Stops the writes and waits for them, closes the descriptors, removes the
   * files that have not been persisted, then the directory. Every step is
   * tried: their failures are thrown together.
   */
  public async cleanup(): Promise<void> {
    this.#cleaned = true;
    const errors: unknown[] = [];
    for (const file of this.#files) {
      file.stop();
    }
    await Promise.allSettled(this.#files.map(({ written }) => written));
    for (const file of this.#files) {
      await file.close().catch((error: unknown) => errors.push(error));
    }
    for (const file of this.#files) {
      await file.remove().catch((error: unknown) => errors.push(error));
    }
    const directory = await this.#directory.catch(() => null);
    if (directory !== null) {
      await this.#system
        .rmdir(directory)
        .catch((error: unknown) => errors.push(error));
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "The files have not all been removed");
    }
  }
}
