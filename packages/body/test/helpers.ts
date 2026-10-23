import { Agent, request } from "undici";
import { Binden, type Context, type IMiddleware } from "binden";
import type { AddressInfo } from "node:net";
import type { ILogger } from "@binden/logger";
import { Readable } from "node:stream";
import type { Server } from "node:http";
import { once } from "node:events";

/** A server of the tests */
export interface IServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/** What a reply of `echo` tells of `request.body` */
export interface ISummary {
  type: "buffer" | "form" | "json" | "text" | "undefined";
  value?: unknown;
}

/** `request.body` as JSON: its type and its value */
export function summarize(body: unknown): ISummary {
  if (typeof body === "undefined") {
    return { type: "undefined" };
  } else if (Buffer.isBuffer(body)) {
    return { type: "buffer", value: body.toString("hex") };
  } else if (body instanceof URLSearchParams) {
    return { type: "form", value: [...body] };
  } else if (typeof body === "string") {
    return { type: "text", value: body };
  }
  return { type: "json", value: body };
}

/** Replies with the summary of `request.body` */
export function echo(context: Context): Promise<void> {
  return context.json({ ...summarize(context.request.body) });
}

/** Listens with an app (closing every connection on `close()`) */
export async function listen(app: Binden): Promise<IServer> {
  const server: Server = app.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    },
  };
}

/** Serves the middlewares, then `echo` */
export function serve(...middlewares: IMiddleware[]): Promise<IServer> {
  return listen(new Binden().use(...middlewares, echo));
}

/** A reply: its status, its `Connection` header and its body (as JSON) */
export interface IReply {
  status: number;
  connection: unknown;
  body: unknown;
}

/** The body of a request: a chunked one when it is a stream */
export type IBody = Buffer | Readable | string;

/**
 * Sends a request (`POST` by default) within 5 seconds, on a connection that
 * the client would keep: the `Connection` of the reply is the choice of the
 * server
 */
export async function send(
  url: string,
  body: IBody | null,
  headers: Record<string, string> = {},
  method = "POST",
): Promise<IReply> {
  const dispatcher = new Agent();
  try {
    const response = await request(url, {
      method,
      headers,
      body,
      dispatcher,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.body.text();
    return {
      status: response.statusCode,
      connection: response.headers.connection,
      body: text === "" ? null : (JSON.parse(text) as unknown),
    };
  } finally {
    await dispatcher.destroy();
  }
}

/** The chunks of a body, sent one at a time (as a chunked body) */
export function chunked(...chunks: Buffer[]): Readable {
  return Readable.from(chunks, { objectMode: false });
}

/** Settles after `ms` milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The value of a promise, or a failure once `ms` milliseconds have passed. The
 * default only guards against a hang, with a deadline that a loaded machine
 * does not reach: a test that asserts a timing passes its own
 */
export async function within<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const expire = (): void => {
    reject(new Error(`Not settled within ${ms} ms`));
  };
  signal.addEventListener("abort", expire, { once: true });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    signal.removeEventListener("abort", expire);
  }
}

/** Never settles */
export function never(): Promise<never> {
  return new Promise(() => {
    // Never settles
  });
}

/** The levels of a logger */
export type ILevel = "debug" | "error" | "fatal" | "info" | "trace" | "warn";

/** A logger that keeps everything that it gets, as JSON */
export class Recorder implements ILogger {
  public readonly lines: [ILevel, string, string][] = [];

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

  public child(): ILogger {
    return this;
  }

  /** The messages of a level */
  public messages(level: ILevel): string[] {
    return this.lines
      .filter(([lineLevel]) => lineLevel === level)
      .map(([, message]) => message);
  }

  #log(level: ILevel, message: string, extra?: Record<string, unknown>): void {
    this.lines.push([level, message, JSON.stringify(extra ?? {})]);
  }
}
