import {
  BindenError,
  type Context,
  type IMiddlewareParams,
  Middleware,
} from "binden";
import busboy, {
  type Busboy,
  type BusboyConfig,
  type FieldInfo,
  type FileInfo,
} from "busboy";
import type { Readable } from "node:stream";

/** The configuration of busboy (its `headers` are those of the request) */
export type IMultipartConfig = Omit<BusboyConfig, "headers">;

/** The options of `Multipart` */
export interface IMultipartOptions extends IMiddlewareParams {
  /** The configuration of busboy, e.g. its `limits` */
  config?: IMultipartConfig | undefined;
  /**
   * Whether a request that reaches a limit of `config.limits` is refused
   * with `413 Content Too Large` (`true`), instead of truncated
   */
  throw_limits?: boolean | undefined;
  /**
   * The largest body in bytes, all of its parts included (no limit by
   * default): a larger one is not read further, and gets a
   * `413 Content Too Large`, whatever `throw_limits`
   */
  limit?: number | undefined;
}

/** The logger of a context */
type ILog = Context["log"];

/** A file stream of busboy */
type IFileStream = Readable & { truncated?: boolean };

/** A part, in the order of the request (a file once it has been read) */
interface ISlot {
  readonly name: string;
  value: File | string | null;
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

/** The requests that have been parsed, or are being parsed */
const parsed = new WeakSet<object>();

/** Observes an error that is reported otherwise */
function ignore(): void {
  // Observed
}

/** The media type of a `Content-Type` header, in lowercase */
function mediaType(header: string | undefined): string {
  return (header ?? "").split(";", 1)[0].trim().toLowerCase();
}

/** Busboy for a request, or the error of its configuration */
function create(config: BusboyConfig): Busboy | Error {
  try {
    return busboy(config);
  } catch (error: unknown) {
    return error as Error;
  }
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
  readonly #log: ILog;
  readonly #config: IMultipartConfig;
  readonly #throw_limits: boolean;
  readonly #limit: number;
  readonly #deferred = Promise.withResolvers<null>();
  readonly #slots: ISlot[] = [];
  readonly #tasks: Promise<void>[] = [];
  readonly #streams = new Set<Readable>();
  readonly #detach: (() => void)[] = [];
  #busboy: Busboy | null = null;
  #over = false;

  public constructor(
    context: Context,
    log: ILog,
    {
      config,
      throw_limits,
      limit,
    }: { config: IMultipartConfig; throw_limits: boolean; limit: number },
  ) {
    this.#context = context;
    this.#log = log;
    this.#config = config;
    this.#throw_limits = throw_limits;
    this.#limit = limit;
  }

  /** Settles once the body is parsed (`request.body`), or refused */
  public run(): Promise<null> {
    const { request, signal } = this.#context;
    if (signal.aborted) {
      this.#abort();
      return this.#deferred.promise;
    }
    const onAbort = (): void => {
      this.#abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.#detach.push(() => {
      signal.removeEventListener("abort", onAbort);
    });

    const boundary = request.content_type?.boundary ?? "";
    if (!boundaries.test(boundary)) {
      // Busboy would not find the parts
      const message = "The `boundary` is missing or invalid";
      this.#refuse(new BindenError(400, { message }));
      return this.#deferred.promise;
    }

    const length = Number(request.headers["content-length"] ?? 0);
    if (length > this.#limit) {
      this.#tooLarge();
      return this.#deferred.promise;
    }

    const parser = create({ ...this.#config, headers: request.headers });
    if (parser instanceof Error) {
      this.#malformed(parser);
      return this.#deferred.promise;
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
        this.#onFile(name, stream, info);
      })
      .once("fieldsLimit", () => {
        this.#limitReached("fields");
      })
      .once("filesLimit", () => {
        this.#limitReached("files");
      })
      .once("partsLimit", () => {
        this.#limitReached("parts");
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
    return this.#deferred.promise;
  }

  #onField(
    name: string | undefined,
    value: string | undefined,
    { valueTruncated }: FieldInfo,
  ): void {
    if (this.#over) {
      return;
    } else if (typeof value === "undefined") {
      // Busboy decodes only some charsets (e.g. not `koi8-r`)
      const message = "The charset of a field is not supported";
      this.#refuse(new BindenError(415, { message }));
      return;
    } else if (valueTruncated && this.#throw_limits) {
      this.#limitReached("fieldSize");
      return;
    }
    // A part without a name (or with an empty one) is named `""`
    this.#slots.push({ name: name ?? "", value });
  }

  #onFile(
    name: string | undefined,
    stream: IFileStream,
    { filename, mimeType }: FileInfo,
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
    });
    stream.once("limit", () => {
      this.#limitReached("fileSize");
    });
    const slot: ISlot = { name: name ?? "", value: null };
    this.#slots.push(slot);
    this.#tasks.push(
      collect(stream).then(
        (chunks) => {
          slot.value = new File(chunks, String(filename), { type: mimeType });
        },
        // The parser reports why the stream has failed
        ignore,
      ),
    );
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
   * The request is aborted (see `context.signal`): e.g. the client has gone
   * away, or the deadline has passed
   */
  #abort(): void {
    const message = "The request has been aborted";
    const cause: unknown = this.#context.signal.reason;
    this.#refuse(new BindenError(400, { message, code: "aborted", cause }));
  }

  /**
   * Refuses the request: the body is not read further, nor parsed. The
   * connection is kept until the reply to the error, which closes it,
   * unless its response has already started.
   */
  #refuse(error: BindenError): void {
    if (this.#over) {
      return;
    }
    this.#end();
    const { request, response } = this.#context;
    if (this.#busboy) {
      request.unpipe(this.#busboy);
    }
    if (response.started) {
      // The reply cannot tell the error
      request.destroy();
    } else {
      request.pause();
      if (!response.headersSent) {
        response.setHeader("Connection", "close");
      }
    }
    // Not while busboy emits the event that has refused the request: it would
    // go on with a stream that it no longer has
    process.nextTick(() => {
      this.#busboy?.destroy();
      for (const stream of this.#streams) {
        stream.destroy();
      }
    });
    this.#log.debug("The multipart body has been refused", {
      status: error.status,
    });
    this.#deferred.reject(error);
  }

  /** The body has been parsed: every file has been read */
  #complete(): void {
    if (this.#over) {
      return;
    }
    this.#end();
    const form = new FormData();
    for (const { name, value } of this.#slots) {
      if (value !== null) {
        form.append(name, value);
      }
    }
    this.#context.request.body = form;
    this.#deferred.resolve(null);
  }

  #end(): void {
    this.#over = true;
    for (const detach of this.#detach) {
      detach();
    }
  }
}

/**
 * Parses a `multipart/form-data` body (with busboy) into `request.body`; a
 * request of another media type is skipped (its body is not read)
 */
export class Multipart extends Middleware {
  readonly #config: IMultipartConfig;
  readonly #throw_limits: boolean;
  readonly #limit: number;

  public constructor({
    config = {},
    throw_limits = true,
    limit,
    ...rest
  }: IMultipartOptions = {}) {
    super(rest);
    if (
      typeof limit !== "undefined" &&
      !(Number.isSafeInteger(limit) && limit >= 0)
    ) {
      throw new TypeError("`limit` is not a non-negative integer");
    }
    this.#config = config;
    this.#throw_limits = throw_limits;
    this.#limit = limit ?? Number.POSITIVE_INFINITY;
  }

  /**
   * Parses the body of a `multipart/form-data` request: a limit gives a
   * `413`, and a malformed body (or boundary) a `400`
   */
  public async run(context: Context): Promise<void> {
    const { request } = context;
    const log = context.log.child({ middleware: Multipart.name });
    const { method = "GET", headers } = request;
    const type = mediaType(headers["content-type"]);

    if (methods.has(method)) {
      log.debug("The method has no body to parse", { method });
      return;
    } else if (type !== "multipart/form-data") {
      log.debug("The body is not `multipart/form-data`", { type });
      return;
    } else if (parsed.has(request)) {
      log.debug("The body has already been parsed");
      return;
    }
    parsed.add(request);

    await new Parser(context, log, {
      config: this.#config,
      throw_limits: this.#throw_limits,
      limit: this.#limit,
    }).run();
  }
}
