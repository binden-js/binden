import {
  Agent,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
  request as httpRequest,
} from "node:http";
import { Binden, type IBindenOptions, type IMiddleware } from "binden";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { once } from "node:events";

/** A response as the client receives it */
export interface IReply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A server of an app, on a random port of 127.0.0.1 (never `::`, see binden) */
export interface ITestServer {
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

/** Starts the server of `app` */
export async function listen(app: Binden): Promise<ITestServer> {
  const server = app.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    server,
    async close(): Promise<void> {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** Starts the server of an app of `middlewares`, closed after the test */
export async function serve(
  t: TestContext,
  middlewares: readonly IMiddleware[],
  options: IBindenOptions = {},
): Promise<ITestServer> {
  const test = await listen(new Binden(options).use(...middlewares));
  t.after(() => test.close());
  return test;
}

/** Resolves after `ms` milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A promise that never settles (e.g. a callback that hangs) */
export function never<T = void>(): Promise<T> {
  return new Promise<T>(() => {
    // Never settles
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

/** Resolves once `check()` is true, which it must be within `ms` milliseconds */
export async function eventually(
  check: () => Promise<boolean> | boolean,
  ms = 2000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`Not true within ${ms} ms`);
    }
    await sleep(5);
  }
}

/** A boundary for the bodies of the tests */
export const boundary = "binden-boundary";

/** The `Content-Type` of the bodies of the tests */
export const type = `multipart/form-data; boundary=${boundary}`;

/** A part of a body: its headers, and its content */
export function part(
  disposition: string,
  content: string,
  headers: readonly string[] = [],
): string {
  return [
    `--${boundary}`,
    `Content-Disposition: form-data; ${disposition}`,
    ...headers,
    "",
    content,
  ].join("\r\n");
}

/** A complete body of parts */
export function body(...parts: string[]): string {
  return `${[...parts, `--${boundary}--`].join("\r\n")}\r\n`;
}

/** A body as `fetch()` encodes a form, and its `Content-Type` */
export async function encode(
  form: FormData,
): Promise<{ body: Buffer; type: string }> {
  const encoded = new Request("http://localhost/", {
    method: "POST",
    body: form,
  });
  return {
    body: Buffer.from(await encoded.arrayBuffer()),
    type: encoded.headers.get("Content-Type") ?? "",
  };
}

/** The options of `send()` */
export interface ISendOptions {
  readonly method?: string;
  readonly headers?: OutgoingHttpHeaders;
  readonly body?: Buffer | string;
  /** The agent of the connection (by default, one of its own that keeps it alive) */
  readonly agent?: Agent;
}

/** A request and its response, within 5 seconds */
function exchange(
  url: string,
  agent: Agent,
  { method, headers, body: data }: Required<Omit<ISendOptions, "agent">>,
): Promise<IReply> {
  const signal = AbortSignal.timeout(5000);
  return new Promise<IReply>((resolve, reject) => {
    httpRequest(url, { agent, method, headers, signal })
      .once("error", reject)
      .once("response", (response) => {
        const chunks: Buffer[] = [];
        response
          .on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          })
          .once("error", reject)
          .once("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString(),
            });
          });
      })
      .end(data);
  });
}

/**
 * Sends a request and settles with its response, within 5 seconds. The
 * connection is kept alive unless the server closes it (its `Connection`).
 */
export async function send(
  url: string,
  {
    method = "POST",
    headers = {},
    body: data = "",
    agent: shared,
  }: ISendOptions = {},
): Promise<IReply> {
  const agent = shared ?? new Agent({ keepAlive: true });
  try {
    return await exchange(url, agent, { method, headers, body: data });
  } finally {
    if (!shared) {
      agent.destroy();
    }
  }
}

/** Sends a body of parts (see `body()`) */
export function post(
  url: string,
  data: Buffer | string,
  headers: OutgoingHttpHeaders = {},
): Promise<IReply> {
  return send(url, {
    headers: { "Content-Type": type, ...headers },
    body: data,
  });
}

/**
 * Starts a request whose body is never complete (its `Content-Length` is
 * larger), and settles with the status and `Connection` of its response
 */
export function upload(url: string, ...chunks: string[]): Promise<unknown[]> {
  return new Promise<unknown[]>((resolve, reject) => {
    const client = httpRequest(url, {
      method: "POST",
      headers: { "Content-Type": type, "Content-Length": 1 << 20 },
      signal: AbortSignal.timeout(5000),
    });
    client
      .once("response", (response) => {
        response.resume();
        resolve([response.statusCode, response.headers.connection]);
        client.destroy();
      })
      .once("error", reject);
    for (const chunk of chunks) {
      client.write(chunk);
    }
  });
}

/** A logged record */
export interface IRecord {
  readonly level: string;
  readonly message: string;
  readonly bindings: Record<string, unknown>;
  readonly extra?: Record<string, unknown> | undefined;
}

type ILevel = "debug" | "error" | "fatal" | "info" | "trace" | "warn";

/** A logger that keeps its records (and the bindings of its children) */
export class RecordingLogger {
  public readonly records: IRecord[];
  readonly #bindings: Record<string, unknown>;

  public constructor(
    records: IRecord[] = [],
    bindings: Record<string, unknown> = {},
  ) {
    this.records = records;
    this.#bindings = bindings;
  }

  public fatal(message: string, extra?: Record<string, unknown>): void {
    this.#log("fatal", message, extra);
  }

  public error(message: string, extra?: Record<string, unknown>): void {
    this.#log("error", message, extra);
  }

  public warn(message: string, extra?: Record<string, unknown>): void {
    this.#log("warn", message, extra);
  }

  public info(message: string, extra?: Record<string, unknown>): void {
    this.#log("info", message, extra);
  }

  public debug(message: string, extra?: Record<string, unknown>): void {
    this.#log("debug", message, extra);
  }

  public trace(message: string, extra?: Record<string, unknown>): void {
    this.#log("trace", message, extra);
  }

  public child(bindings: Record<string, unknown>): RecordingLogger {
    return new RecordingLogger(this.records, {
      ...this.#bindings,
      ...bindings,
    });
  }

  #log(level: ILevel, message: string, extra?: Record<string, unknown>): void {
    this.records.push({ level, message, bindings: this.#bindings, extra });
  }
}
