import {
  BindenAbortError,
  BindenError,
  type Context,
  Middleware,
  formatStack,
  formatting,
  serializers,
} from "binden";
import {
  DiskStore,
  type IFileStream,
  type IStoredFile,
  cleanedUp,
  storedForm,
} from "./disk.js";
import {
  type IFileFilter,
  type IFileInfo,
  type IMode,
  type IMultipartConfig,
  type IMultipartOptions,
  type IParserOptions,
  type IStreamFile,
  type IStreamStorage,
  validateOptions,
} from "./options.js";
import { type ILimitName, type IParseInfo, startParse } from "./info.js";
import busboy, {
  type Busboy,
  type BusboyConfig,
  type FieldInfo,
  type FileInfo,
} from "busboy";
import { MultipartFile } from "./file.js";
import type { Readable } from "node:stream";
import { filenameOf } from "./filename.js";
import { race } from "./race.js";
import { tmpdir } from "node:os";

/** The logger of a context */
type ILog = Context["log"];

/** What a parse uses of its context, each read once (see `Multipart#start()`) */
interface IExchange {
  /** Given to the callbacks of the options, and asked for the cleanup (disk) */
  readonly context: Context;
  readonly request: Context["request"];
  readonly response: Context["response"];
  readonly signal: AbortSignal;
  readonly headers: Context["request"]["headers"];
  /** A child of `context.log` */
  readonly log: ILog;
}

/**
 * The first failure of a late call of the context, formatted: the rejection
 * of the parse (what is thrown may be anything, an error or not)
 */
interface IFailure {
  readonly error: Error;
}

/** A part, in the order of the request (a file once it has been read) */
interface ISlot {
  readonly name: string;
  value: IStoredFile | MultipartFile | string | null;
}

/** The methods whose requests have no body to parse */
const methods: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "TRACE",
]);

/** A boundary (RFC 2046, section 5.1.1): 1 to 70 characters, without a trailing space */
const boundaries = /^[\w'()+,\-./:=? ]{0,69}[\w'()+,\-./:=?]$/u;

/** Observes an error that is reported otherwise */
function ignore(): void {
  // Observed
}

/** The media type of a `Content-Type` header, in lowercase */
function mediaType(header: string | undefined): string {
  return (header ?? "").split(";", 1)[0].trim().toLowerCase();
}

/**
 * Whether a `Content-Encoding` header has no content coding but `identity`:
 * the parser does not decode a body
 */
function identity(header: string | undefined): boolean {
  return (header ?? "").split(",").every((element) => {
    const coding = element.trim().toLowerCase();
    return coding === "" || coding === "identity";
  });
}

/** Busboy for a request, or the error of its configuration */
function create(config: BusboyConfig): Busboy | Error {
  try {
    return busboy(config);
  } catch (error: unknown) {
    return error as Error;
  }
}

/**
 * The error of an aborted request: a client that has gone away is a
 * `400 Bad Request` (`aborted`), a deadline or a shutdown is the reason of
 * `context.signal` (as for `@binden/body`)
 */
function abortError(reason: unknown): BindenAbortError | BindenError {
  if (reason instanceof BindenAbortError && reason.reason !== "client_closed") {
    return reason;
  }
  const message = "The request has been aborted";
  return new BindenError(400, { message, code: "aborted", cause: reason });
}

/** The error of a failed callback: a `BindenError` as is, any other a `500` */
function failure(error: unknown, message: string): BindenError {
  return error instanceof BindenError
    ? error
    : new BindenError(500, { message, cause: error });
}

/** The content of a file */
async function collect(stream: Readable): Promise<Buffer<ArrayBuffer>[]> {
  const chunks: Buffer<ArrayBuffer>[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer<ArrayBuffer>);
  }
  return chunks;
}

/**
 * The parse of one request: its body is read until it is complete, or until
 * it is refused (once)
 */
class Parser {
  readonly #context: Context;
  readonly #request: Context["request"];
  readonly #response: Context["response"];
  readonly #signal: AbortSignal;
  readonly #headers: Context["request"]["headers"];
  readonly #log: ILog;
  readonly #info: IParseInfo;
  readonly #config: IMultipartConfig;
  readonly #throw_limits: boolean;
  readonly #limit: number;
  readonly #file_filter: IFileFilter | null;
  readonly #filtered: "reject" | "skip";
  readonly #mode: IMode;
  /** Aborted once the parse is over: what it awaits is abandoned */
  readonly #stop = new AbortController();
  readonly #deferred = Promise.withResolvers<null>();
  readonly #slots: ISlot[] = [];
  readonly #tasks: Promise<void>[] = [];
  readonly #streams = new Set<Readable>();
  readonly #detach: (() => void)[] = [];
  #busboy: Busboy | null = null;
  #store: DiskStore | null = null;
  #over = false;
  #failure: IFailure | null = null;

  public constructor(
    { context, request, response, signal, headers, log }: IExchange,
    info: IParseInfo,
    {
      config,
      throw_limits,
      limit,
      file_filter,
      filtered,
      mode,
    }: IParserOptions,
  ) {
    this.#context = context;
    this.#request = request;
    this.#response = response;
    this.#signal = signal;
    this.#headers = headers;
    this.#log = log;
    this.#info = info;
    this.#config = config;
    this.#throw_limits = throw_limits;
    this.#limit = limit;
    this.#file_filter = file_filter;
    this.#filtered = filtered;
    this.#mode = mode;
  }

  /**
   * Settles once the body is parsed (`request.body`), or refused: what the
   * context throws (as the parse starts, or later) refuses it with that
   * error, formatted (see `#failed()`)
   */
  public run(): Promise<null> {
    try {
      this.#begin();
    } catch (error: unknown) {
      this.#failed(error);
    }
    return this.#deferred.promise;
  }

  /** Starts to read the body, unless it can be refused at once */
  #begin(): void {
    const request = this.#request;
    const signal = this.#signal;
    const headers = this.#headers;
    if (signal.aborted) {
      this.#abort();
      return;
    }
    const onAbort = (): void => {
      this.#late(() => {
        this.#abort();
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.#detach.push(() => {
      signal.removeEventListener("abort", onAbort);
    });

    if (!identity(headers["content-encoding"])) {
      // Busboy would parse the coded bytes
      const message = "The body has a content coding, which is not decoded";
      this.#refuse(new BindenError(415, { message }));
      return;
    }

    const boundary = request.content_type?.boundary ?? "";
    if (!boundaries.test(boundary)) {
      // Busboy would not find the parts
      const message = "The `boundary` is missing or invalid";
      this.#refuse(new BindenError(400, { message }));
      return;
    }

    const length = Number(headers["content-length"] ?? 0);
    if (length > this.#limit) {
      this.#tooLarge();
      return;
    }

    const parser = create({ ...this.#config, headers });
    if (parser instanceof Error) {
      this.#malformed(parser);
      return;
    }
    this.#busboy = parser;
    parser
      .on("error", (cause: unknown) => {
        this.#malformed(cause);
      })
      .on(
        "field",
        (name: string | undefined, value: string | undefined, info) => {
          this.#onField(name, value, info);
        },
      )
      .on("file", (name: string | undefined, stream, info) => {
        this.#onFile(parser, name, stream, info);
      })
      .once("fieldsLimit", () => {
        this.#countReached("fields");
      })
      .once("filesLimit", () => {
        this.#countReached("files");
      })
      .once("partsLimit", () => {
        this.#countReached("parts");
      })
      .once("close", () => {
        Promise.all(this.#tasks).then(() => {
          this.#complete();
        }, ignore);
      });

    if (this.#limit !== Number.POSITIVE_INFINITY) {
      let received = 0;
      const count = (chunk: Buffer): void => {
        received += chunk.byteLength;
        if (received > this.#limit) {
          this.#tooLarge();
        }
      };
      // Before busboy, which does not see what is over the limit
      request.on("data", count);
      this.#detach.push(() => {
        request.off("data", count);
      });
    }
    // A closed connection aborts the signal (`pipe` does not tell busboy)
    request.pipe(parser);
    this.#watch();
  }

  /**
   * Watches the connection: once the response has finished, `context.signal`
   * is no longer aborted when the client goes away, and Node.js no longer
   * tells the request, but the connection closes (before, the signal is
   * aborted first). A body that has been received whole is still read.
   */
  #watch(): void {
    const request = this.#request;
    const { socket } = request;
    const closed = (): void => {
      this.#late(() => {
        if (!request.complete) {
          this.#refuse(abortError(null));
        }
      });
    };
    socket.once("close", closed);
    this.#detach.push(() => {
      socket.off("close", closed);
    });
  }

  #onField(
    name: string | undefined,
    value: string | undefined,
    { valueTruncated }: FieldInfo,
  ): void {
    // A part without a name (or with an empty one) is named `""`
    const field = name ?? "";
    if (this.#over) {
      return;
    } else if (typeof value === "undefined") {
      // Busboy decodes only some charsets (e.g. not `koi8-r`)
      const message = "The charset of a field is not supported";
      this.#refuse(new BindenError(415, { message }));
      return;
    } else if (valueTruncated) {
      this.#info.truncated_fields.push(field);
      if (this.#throw_limits) {
        this.#limitReached("fieldSize");
        return;
      }
    }
    this.#slots.push({ name: field, value });
  }

  #onFile(
    parser: Busboy,
    name: string | undefined,
    stream: IFileStream,
    { filename, encoding, mimeType }: FileInfo,
  ): void {
    // Observed: busboy reports the errors of its streams itself
    stream.on("error", ignore);
    if (this.#over) {
      stream.resume();
      return;
    }
    this.#streams.add(stream);
    stream.once("close", () => {
      this.#streams.delete(stream);
      if (!stream.readableEnded && !parser.destroyed) {
        // E.g. `on_file` has destroyed it: busboy does not go on without it
        const message = "The stream of a file has been closed before its end";
        this.#late(() => {
          this.#refuse(failure(stream.errored, message));
        });
      }
    });
    stream.once("limit", () => {
      this.#limitReached("fileSize");
    });
    const info: IFileInfo = {
      field: name ?? "",
      filename: filenameOf(filename),
      mime_type: mimeType,
      encoding,
    };
    const slot: ISlot = { name: info.field, value: null };
    this.#slots.push(slot);
    this.#tasks.push(
      this.#file(info, stream, slot).catch((error: unknown) => {
        // E.g. `file_filter` has failed (the parser has already refused the
        // request when its stream has failed), also with a value whose check
        // throws (e.g. a revoked proxy)
        this.#late(() => {
          this.#refuse(failure(error, "A file has not been handled"));
        });
      }),
    );
  }

  /** Reads a file that `file_filter` accepts (the content of the others is discarded) */
  async #file(
    info: IFileInfo,
    stream: IFileStream,
    slot: ISlot,
  ): Promise<void> {
    if (!(await this.#accepts(info))) {
      if (this.#filtered === "reject") {
        const message = "A file has been refused by `file_filter`";
        throw new BindenError(415, { message });
      }
      stream.resume();
      return;
    } else if (this.#mode.kind === "stream") {
      await this.#stream(this.#mode.on_file, info, stream);
      return;
    } else if (this.#mode.kind === "disk") {
      slot.value = await this.#disk(this.#mode.dir, info, stream);
      return;
    }
    const chunks = await collect(stream);
    slot.value = new MultipartFile(chunks, info.filename, {
      type: info.mime_type,
      truncated: stream.truncated === true,
    });
  }

  /**
   * Streams a file to `on_file` (awaited until the parse is over): what it
   * has not read once it has settled is read and discarded
   */
  async #stream(
    on_file: IStreamStorage["on_file"],
    info: IFileInfo,
    stream: IFileStream,
  ): Promise<void> {
    const file: IStreamFile = {
      ...info,
      stream,
      truncated: () => stream.truncated === true,
    };
    await race(() => on_file(file, this.#context), this.#stop.signal);
    if (!stream.readableEnded) {
      stream.unpipe();
      stream.resume();
    }
  }

  /**
   * Stores a file on the disk, in the private directory of the request
   * (created with its first file, and removed with its cleanup): a `500`
   * once the cleanup of the request has started (see `cleanedUp()`)
   */
  async #disk(
    dir: string | null,
    info: IFileInfo,
    stream: IFileStream,
  ): Promise<IStoredFile> {
    if (this.#store === null) {
      const context = this.#context;
      let onCleanup: unknown = null;
      try {
        onCleanup = Reflect.get(context, "onCleanup");
      } catch (error: unknown) {
        // A read of the context, which refuses the parse with what it throws
        this.#failed(error);
        throw error;
      }
      try {
        this.#store = new DiskStore(dir ?? tmpdir(), (cleanup) => {
          Reflect.apply(onCleanup as Context["onCleanup"], context, [cleanup]);
        });
      } catch (error: unknown) {
        // `onCleanup()` throws once the cleanup has started
        throw cleanedUp(formatStack(error as Error));
      }
    }
    const file = this.#store.add(info, stream);
    await file.written;
    return file;
  }

  /** Whether `file_filter` accepts a file (awaited until the parse is over) */
  async #accepts(info: IFileInfo): Promise<boolean> {
    const filter = this.#file_filter;
    if (filter === null) {
      return true;
    }
    const accepted: unknown = await race(
      () => filter({ ...info }, this.#context),
      this.#stop.signal,
    );
    if (typeof accepted !== "boolean") {
      throw formatStack(
        new TypeError("`file_filter` has not returned a boolean"),
      );
    }
    return accepted;
  }

  /** A limit on the count of the parts: the parts over it are dropped */
  #countReached(limit: ILimitName): void {
    this.#info.limits_hit.push(limit);
    this.#limitReached(limit);
  }

  /** A limit of busboy (refused with `throw_limits`, otherwise truncated) */
  #limitReached(limit: string): void {
    if (this.#throw_limits) {
      const message = `The \`${limit}\` limit has been reached`;
      this.#refuse(new BindenError(413, { message }));
    }
  }

  #tooLarge(): void {
    const message = "The body is larger than `limit`";
    this.#refuse(new BindenError(413, { message }));
  }

  #malformed(cause: unknown): void {
    const message = "The body is not a valid `multipart/form-data`";
    this.#refuse(new BindenError(400, { message, cause }));
  }

  /**
   * The request is aborted (see `context.signal`): the client has gone away
   * (`400`), or the deadline has passed or the server is shutting down (the
   * reason of the signal)
   */
  #abort(): void {
    this.#refuse(abortError(this.#signal.reason));
  }

  /** Refuses the request with an error of the parser (see `#halt()`) */
  #refuse(error: BindenAbortError | BindenError): void {
    this.#halt(
      error,
      error instanceof BindenError
        ? { status: error.status }
        : { reason: error.reason },
    );
  }

  /**
   * A call of the context (of its request, its response, its signal or its
   * logger), or a check of what it gives, has thrown: the parse is refused
   * with what it has thrown (the first failure, see `#record()`)
   */
  #failed(error: unknown): void {
    const failed = this.#record(error).error;
    this.#halt(failed, { failure: serializers.error(failed) });
  }

  /** Keeps the first failure of the context, formatted: the rejection */
  #record(error: unknown): IFailure {
    this.#failure ??= { error: formatStack(error as Error) };
    return this.#failure;
  }

  /** A call of the context while the parse stops (or ends): its failure is kept */
  #guard(call: () => void): void {
    try {
      call();
    } catch (error: unknown) {
      this.#record(error);
    }
  }

  /** A callback (e.g. of the signal or of the request): its failure refuses the parse */
  #late(call: () => void): void {
    try {
      call();
    } catch (error: unknown) {
      this.#failed(error);
    }
  }

  /**
   * Refuses the request: the body is not read further, nor parsed. The
   * connection is kept until the reply, which closes it, unless the headers
   * of the response have already been sent. A send whose headers are not
   * sent yet (e.g. of a stream that has not given its first chunk) is left
   * to the framework: its reply (or the `503` that cancels it at the
   * deadline) closes the connection. What the context throws meanwhile does
   * not stop the cleanup: the first failure is the rejection.
   */
  #halt(error: Error, logged: Record<string, unknown>): void {
    if (this.#over) {
      return;
    }
    this.#end();
    this.#stop.abort(error);
    const request = this.#request;
    const response = this.#response;
    const reader = this.#busboy;
    if (reader) {
      this.#guard(() => {
        request.unpipe(reader);
      });
    }
    this.#guard(() => {
      if (response.headersSent) {
        // The reply cannot tell the error
        request.destroy();
      } else {
        request.pause();
        response.setHeader("Connection", "close");
      }
    });
    // Not while busboy emits the event that has refused the request: it would
    // go on with a stream that it no longer has
    process.nextTick(() => {
      this.#busboy?.destroy();
      for (const stream of this.#streams) {
        stream.destroy();
      }
    });
    this.#guard(() => {
      this.#log.debug("The multipart body has been refused", logged);
    });
    this.#deferred.reject(this.#failure === null ? error : this.#failure.error);
  }

  /** The body has been parsed: every file has been read */
  #complete(): void {
    if (this.#over) {
      return;
    }
    this.#end();
    const request = this.#request;
    const body =
      this.#mode.kind === "disk" ? storedForm(this.#slots) : this.#form();
    this.#guard(() => {
      request.body = body;
    });
    const kept = this.#failure;
    if (kept === null) {
      this.#deferred.resolve(null);
    } else {
      this.#deferred.reject(kept.error);
    }
  }

  /** The fields and the files in memory (skipped ones excluded) */
  #form(): FormData {
    const form = new FormData();
    for (const { name, value } of this.#slots) {
      if (typeof value === "string" || value instanceof MultipartFile) {
        form.append(name, value);
      }
    }
    return form;
  }

  #end(): void {
    this.#over = true;
    for (const detach of this.#detach) {
      this.#guard(detach);
    }
  }
}

/**
 * Parses a `multipart/form-data` body (with busboy) into `request.body`; a
 * request of another media type is skipped (its body is not read)
 */
export class Multipart extends Middleware {
  readonly #options: IParserOptions;

  /**
   * Checks the options: a `TypeError` or a `RangeError` for an invalid one.
   * What reading them throws (e.g. a revoked proxy, or a getter that throws)
   * is formatted (see `formatting()`).
   */
  public constructor(options: IMultipartOptions = {}) {
    const { middleware, parser } = formatting(() => validateOptions(options));
    super(middleware);
    this.#options = parser;
  }

  /**
   * Parses the body of a `multipart/form-data` request: a limit gives a
   * `413`, a malformed body (or boundary) a `400`, a client that goes away a
   * `400` (`aborted`), a deadline or a shutdown the reason of the signal
   */
  public async run(context: Context): Promise<void> {
    // What reading the context throws (e.g. of a value that is not a
    // context) is formatted (see `formatting()`): it is read before anything
    // is awaited
    const parsing = formatting(() => this.#start(context));
    if (parsing !== null) {
      await parsing;
    }
  }

  /**
   * Starts the parse of the body of the request of a context (see `run()`):
   * `null` when it is not parsed
   */
  #start(context: Context): Promise<null> | null {
    // Each property of the context is read once
    const { request } = context;
    const log = context.log.child({ middleware: Multipart.name });
    const { method = "GET", headers } = request;
    const type = mediaType(headers["content-type"]);

    if (methods.has(method)) {
      log.debug("The method has no body to parse", { method });
      return null;
    } else if (type !== "multipart/form-data") {
      log.debug("The body is not `multipart/form-data`", { type });
      return null;
    }
    const info = startParse(request);
    if (info === null) {
      log.debug("The body has already been parsed");
      return null;
    }
    const { response, signal } = context;
    if (response.writableFinished) {
      // Node.js reads and discards what has not been read once the response
      // has finished: what is left of the body would be missing
      const message = "The body has been discarded once the response finished";
      log.error(message);
      throw new BindenError(500, { message });
    }
    const exchange = { context, request, response, signal, headers, log };
    return new Parser(exchange, info, this.#options).run();
  }
}
