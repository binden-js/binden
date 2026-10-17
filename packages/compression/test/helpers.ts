import { type AddressInfo, connect } from "node:net";
import { Binden, type IBindenOptions, type IMiddleware } from "binden";
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  createServer,
  request,
} from "node:http";
import { Logger } from "@binden/logger";
import type { Transform } from "node:stream";
import { once } from "node:events";
import zlib from "node:zlib";

/** Resolves after `ms` milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The result of a promise, which must settle within `ms` milliseconds. The
 * default only guards against a hang, with a deadline that a loaded machine
 * does not reach: a test that asserts a timing passes its own
 */
export async function within<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    reject(new Error(`Not settled within ${ms} ms`));
  }, ms);
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves after a turn of the pending I/O (a 5 ms timer, then two turns of
 * `setImmediate()`): once a stall of the process (e.g. a loaded machine) has
 * passed, the timers run before the I/O that has come meanwhile is read, the
 * system may not have delivered it yet (e.g. the end of a loopback
 * connection, which macOS delivers asynchronously), and the `close` of a
 * socket whose end is read then is emitted only once the first turn has run
 * (in the close callbacks of the event loop), so that silence (or an expired
 * deadline) is judged only after all three
 */
export async function ioTurn(): Promise<void> {
  await sleep(5);
  for (let turn = 0; turn < 2; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/**
 * Resolves once `check()` holds (polled every 5 ms), or rejects once it has
 * not within `ms` milliseconds, judged after a turn of the pending I/O (see
 * `ioTurn()`): a poller that ends by itself, whoever waits for it, so that a
 * failure never keeps the process of a test alive
 */
export async function pollUntil(
  check: () => boolean,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      await ioTurn();
      if (check()) {
        return;
      }
      throw new Error(`Not true within ${ms} ms: ${String(check)}`);
    }
    await sleep(5);
  }
}

/**
 * Asserts that two buffers have the same bytes (without the diff of large
 * buffers, which takes the time of a hang)
 */
export function sameBytes(actual: Buffer, expected: Buffer): void {
  if (!actual.equals(expected)) {
    throw new Error(
      `Different bytes: ${actual.length} bytes instead of ${expected.length}`,
    );
  }
}

/** A compressible body of `size` bytes */
export function text(size: number): string {
  return "Some text to compress. ".repeat(Math.ceil(size / 23)).slice(0, size);
}

/** The compressors that `createGzip()` of `node:zlib` creates while `fn` runs */
export async function gzips(
  fn: (created: readonly zlib.Gzip[]) => Promise<void>,
): Promise<zlib.Gzip[]> {
  const original = Object.getOwnPropertyDescriptor(zlib, "createGzip");
  const create = original?.value as typeof zlib.createGzip;
  const created: zlib.Gzip[] = [];
  Object.defineProperty(zlib, "createGzip", {
    ...original,
    value: (options?: zlib.ZlibOptions): zlib.Gzip => {
      const compressor = create(options);
      created.push(compressor);
      return compressor;
    },
  });
  try {
    await fn(created);
  } finally {
    Object.defineProperty(zlib, "createGzip", original as PropertyDescriptor);
  }
  return created;
}

/** The functions of `node:zlib` that create the compressor of each coding */
const creators = [
  "createBrotliCompress",
  "createDeflate",
  "createGzip",
  "createZstdCompress",
] as const;

/** The compressors of every coding that `node:zlib` creates while `fn` runs */
export async function compressors(
  fn: () => Promise<void>,
): Promise<Transform[]> {
  const created: Transform[] = [];
  const originals = creators.map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(zlib, name)] as [
        string,
        PropertyDescriptor,
      ],
  );
  for (const [name, original] of originals) {
    const create = original.value as (options?: object) => Transform;
    Object.defineProperty(zlib, name, {
      ...original,
      value: (options?: object): Transform => {
        const compressor = create(options);
        created.push(compressor);
        return compressor;
      },
    });
  }
  try {
    await fn();
  } finally {
    for (const [name, original] of originals) {
      Object.defineProperty(zlib, name, original);
    }
  }
  return created;
}

/** `undefined`, which the linter does not let the tests write */
export const none = ({} as { value?: undefined }).value;

const decoders = new Map<string, (body: Buffer) => Buffer>([
  ["br", (body): Buffer => zlib.brotliDecompressSync(body)],
  ["deflate", (body): Buffer => zlib.inflateSync(body)],
  ["gzip", (body): Buffer => zlib.gunzipSync(body)],
  ["zstd", (body): Buffer => zlib.zstdDecompressSync(body)],
]);

/** Decompresses a body of a content coding (none without one) */
export function decode(
  coding: string[] | string | undefined,
  body: Buffer,
): Buffer {
  if (typeof coding === "undefined") {
    return body;
  }
  const decoder = decoders.get(String(coding));
  if (!decoder) {
    throw new Error(`Unexpected coding: ${String(coding)}`);
  }
  return decoder(body);
}

/** A logger whose records are kept */
export interface ICaptured {
  readonly logger: Logger;
  /** The messages logged so far, with their level */
  readonly records: { level: unknown; msg: unknown }[];
  /** The records logged so far, whole */
  readonly entries: Record<string, unknown>[];
  /** Resolves once `count` records have been written (within 5 s) */
  waitFor(count: number): Promise<void>;
}

/** A `Logger` whose records are kept */
export function capture(): ICaptured {
  const lines: string[] = [];
  const logger = new Logger({
    destination: {
      write(line: string): void {
        lines.push(line);
      },
    },
    level: "debug",
  });
  return {
    logger,
    get entries(): Record<string, unknown>[] {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    get records(): { level: unknown; msg: unknown }[] {
      return lines.map((line) => {
        const { level, msg } = JSON.parse(line) as Record<string, unknown>;
        return { level, msg };
      });
    },
    waitFor: async (count: number): Promise<void> => {
      await pollUntil(() => lines.length >= count).catch(() => {
        throw new Error(`${lines.length} records: ${lines.join("")}`);
      });
    },
  };
}

/** A listening server of an application */
export interface IServed {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

/** The options of `serve()` */
export interface IServeOptions {
  /** The options of the application */
  readonly app?: IBindenOptions | undefined;
  /** Responses with the dynamic `ETag` (the `etag` option of the application) */
  readonly etag?: boolean | undefined;
  /** `rejectNonStandardBodyWrites` of the server */
  readonly strict?: boolean | undefined;
}

/** Serves the middlewares on a free port */
export async function serve(
  { app: options = {}, etag = false, strict = false }: IServeOptions,
  ...middlewares: IMiddleware[]
): Promise<IServed> {
  const app = new Binden({ ...options, etag }).use(...middlewares);
  const server = createServer({
    ...app.serverOptions(),
    rejectNonStandardBodyWrites: strict,
  });
  server.on("request", app.callback(server));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** A response, as received */
export interface IReceived {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** The body as received */
  readonly raw: Buffer;
  /** The body, decompressed by its `Content-Encoding` (empty without a body) */
  readonly body: string;
}

/** The options of a request */
export interface IRequestOptions {
  readonly path?: string | undefined;
  readonly method?: string | undefined;
  readonly headers?: OutgoingHttpHeaders | undefined;
}

/** Sends a request (on a new connection), and reads its response within 5 s */
export function fetchRaw(
  url: string,
  { path = "/", method = "GET", headers = {} }: IRequestOptions = {},
): Promise<IReceived> {
  return within(
    new Promise<IReceived>((resolve, reject) => {
      const sent = request(
        new URL(path, url),
        { agent: false, headers, method, signal: AbortSignal.timeout(10_000) },
        (response: IncomingMessage) => {
          const chunks: Buffer[] = [];
          response
            .on("data", (chunk: Buffer) => chunks.push(chunk))
            .once("end", () => {
              const raw = Buffer.concat(chunks);
              const coding = response.headers["content-encoding"];
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                raw,
                get body(): string {
                  return raw.length === 0 ? "" : decode(coding, raw).toString();
                },
              });
            })
            .once("error", reject);
        },
      );
      sent.once("error", reject).end();
    }),
  );
}

/** The body of a chunked message, and whether it has its last chunk */
export function dechunk(raw: Buffer): { body: Buffer; complete: boolean } {
  const parts: Buffer[] = [];
  let rest = raw;
  for (;;) {
    const index = rest.indexOf("\r\n");
    if (index === -1) {
      return { body: Buffer.concat(parts), complete: false };
    }
    const size = Number.parseInt(rest.subarray(0, index).toString(), 16);
    if (size === 0) {
      return { body: Buffer.concat(parts), complete: true };
    }
    parts.push(rest.subarray(index + 2, index + 2 + size));
    rest = rest.subarray(index + 2 + size + 2);
  }
}

/**
 * Sends a request on a connection that is not read for `pause` milliseconds
 * (a slow client, or none when `0`), then reads everything until the server
 * closes it: the head of the response, and its body
 */
export async function exchange(
  url: string,
  pause = 0,
): Promise<{ head: string; body: Buffer }> {
  const socket = connect(Number(new URL(url).port), "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    "GET / HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n",
  );
  socket.pause();
  await sleep(pause);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const closed = once(socket, "close");
  socket.resume();
  await within(closed);
  const received = Buffer.concat(chunks);
  const index = received.indexOf("\r\n\r\n");
  return {
    head: received.subarray(0, index).toString(),
    body: received.subarray(index + 4),
  };
}

/** A response read from a connection: its head (lowercase names) and its body as sent */
export interface IRaw {
  readonly head: string;
  readonly body: Buffer;
}

/**
 * Writes requests on one connection and reads everything until the server
 * closes it (within 5 s): the responses, split by their head
 */
export async function converse(url: string, requests: string): Promise<IRaw[]> {
  const socket = connect(Number(new URL(url).port), "127.0.0.1");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const closed = once(socket, "close");
  socket.write(requests);
  try {
    await within(closed);
  } finally {
    socket.destroy();
  }
  const received = Buffer.concat(chunks);
  const responses: IRaw[] = [];
  let start = received.indexOf("HTTP/1.1 ");
  while (start !== -1) {
    const end = received.indexOf("\r\n\r\n", start);
    const next = received.indexOf("HTTP/1.1 ", end);
    responses.push({
      head: received.subarray(start, end).toString().toLowerCase(),
      body: received.subarray(end + 4, next === -1 ? received.length : next),
    });
    start = next;
  }
  return responses;
}

/**
 * The body of a response read from a connection (see `converse()`) by its
 * framing, which must be exact: its `Content-Length`, its chunks (with
 * nothing after the last one), or else all until the connection closed
 */
export function framed({ head, body }: IRaw): Buffer {
  const length = /\r\ncontent-length: (?<length>\d+)/u.exec(head)?.groups
    ?.length;
  if (head.includes("\r\ntransfer-encoding: chunked")) {
    const { body: data, complete } = dechunk(body);
    if (!complete || body.subarray(-5).toString() !== "0\r\n\r\n") {
      throw new Error(`Not framed by its chunks: ${body.toString("latin1")}`);
    }
    return data;
  } else if (typeof length !== "undefined" && Number(length) !== body.length) {
    throw new Error(`${body.length} bytes instead of ${length}`);
  }
  return body;
}
