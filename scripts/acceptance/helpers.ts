// What the scenarios of the acceptance share. Each scenario is a process of its
// own (run by `scenarios.test.mjs`): it serves an application and is its own
// client, prints what it has observed as JSON, and exits by itself once nothing is
// left (an open handle is a timeout). A crash, an `unhandledRejection` or a warning
// is its exit code and stderr.
import { type Binden, BindenAbortError, BindenError } from "binden";
import {
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
  request,
} from "node:http";
import { fstatSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

/** Fails the scenario once `ms` have passed: a hang must not block the runner */
export function deadline(ms: number): void {
  setTimeout(() => {
    process.stderr.write(`Timed out after ${ms} ms\n`);
    process.exit(2);
  }, ms).unref();
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Polls `condition` until it holds, or fails after `ms` */
export async function eventually(
  condition: () => boolean,
  message: string,
  ms = 5000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error(`Timed out: ${message}`);
    }
    await sleep(10);
  }
}

/** Serves an application on a free port */
export async function serve(
  app: Binden,
): Promise<{ server: ReturnType<Binden["createServer"]>; port: number }> {
  const server = app.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

/** A response, read to its end */
export interface IReply {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

/** Reads a response to its end */
export async function read(response: IncomingMessage): Promise<IReply> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(chunk as Buffer);
  }
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    body: Buffer.concat(chunks),
  };
}

/** Starts a request (on a connection of its own, unless an `agent` is given) */
export function start(
  port: number,
  path: string,
  options: RequestOptions = {},
): { client: ClientRequest; response: Promise<IncomingMessage> } {
  const client = request({
    agent: false,
    ...options,
    host: "127.0.0.1",
    port,
    path,
  });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    // Every error: a client may go away on purpose once it has its response
    client.once("response", resolve).on("error", reject);
  });
  // Observed: the response of a client that goes away is not awaited
  response.catch(() => null);
  return { client, response };
}

/** A request and its response, read to its end */
export async function exchange(
  port: number,
  path: string,
  options: RequestOptions = {},
  body: Buffer | string = "",
): Promise<IReply & { reused: boolean }> {
  const { client, response } = start(port, path, options);
  client.end(body);
  const reply = await read(await response);
  return { ...reply, reused: client.reusedSocket };
}

/** The reason of an aborted signal, or `null` */
export function reasonOf(signal: AbortSignal): string | null {
  if (!signal.aborted) {
    return null;
  }
  const { reason } = signal as { reason: unknown };
  return reason instanceof BindenAbortError ? reason.reason : "other";
}

/**
 * The codes of a write to a connection that the client has closed (a write
 * still in a compressor is called back with `ERR_STREAM_DESTROYED` once the
 * response has closed)
 */
const disconnected = new Set([
  "ECONNRESET",
  "EPIPE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/**
 * What a promise has settled with: `resolved`, `<status> <code>` of a
 * `BindenError`, `closed` for the connection closed by the client (the error
 * depends on the version of Node.js), or the name and code of another error
 */
export async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error: unknown) {
    if (error instanceof BindenError) {
      return `${error.status} ${error.code ?? "-"}`;
    } else if (error instanceof BindenAbortError) {
      return `aborted ${error.reason}`;
    }
    if (error instanceof Error) {
      const { code } = error as { code?: unknown };
      if (typeof code !== "string") {
        return error.name;
      }
      return disconnected.has(code) ? "closed" : `${error.name} ${code}`;
    }
    return typeof error;
  }
}

/**
 * The regular files that the process has open (POSIX), by device and inode: a
 * file that is still open once its request is over (e.g. a removed temporary
 * file, which a descriptor keeps) is a leak
 */
export function openFiles(): Set<string> {
  const dir = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  const files = new Set<string>();
  for (const fd of readdirSync(dir)) {
    try {
      const stats = fstatSync(Number(fd));
      if (stats.isFile()) {
        files.add(`${stats.dev}:${stats.ino}`);
      }
    } catch {
      // Closed since (e.g. the descriptor of the listing itself)
    }
  }
  return files;
}

/**
 * Waits until every regular file that the process has open was already open
 * before (`openFiles()`): a file that another task closes meanwhile (e.g. a
 * cache of tsx) does not count
 */
export function closed(before: Set<string>, name: string): Promise<void> {
  return eventually(
    () => [...openFiles()].every((file) => before.has(file)),
    `${name}: the files that it has opened are closed`,
  );
}

/** A multipart body of a form, and its `Content-Type` */
export async function multipart(
  form: FormData,
): Promise<{ body: Buffer; type: string }> {
  const encoded = new Request("http://localhost/", {
    method: "POST",
    body: form,
  });
  return {
    body: Buffer.from(await encoded.arrayBuffer()),
    type: encoded.headers.get("content-type") ?? "",
  };
}
