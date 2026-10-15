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
import { once } from "node:events";
import zlib from "node:zlib";

/** Resolves after `ms` milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The result of a promise, which must settle within `ms` milliseconds */
export async function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
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
    get records(): { level: unknown; msg: unknown }[] {
      return lines.map((line) => {
        const { level, msg } = JSON.parse(line) as Record<string, unknown>;
        return { level, msg };
      });
    },
    waitFor: async (count: number): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (lines.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`${lines.length} records: ${lines.join("")}`);
        }
        await sleep(5);
      }
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
  server.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://localhost:${port}`,
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
        { agent: false, headers, method, signal: AbortSignal.timeout(5000) },
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
  const socket = connect(Number(new URL(url).port), "localhost");
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
  await within(closed, 5000);
  const received = Buffer.concat(chunks);
  const index = received.indexOf("\r\n\r\n");
  return {
    head: received.subarray(0, index).toString(),
    body: received.subarray(index + 4),
  };
}
