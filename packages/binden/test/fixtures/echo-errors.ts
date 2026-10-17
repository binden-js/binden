// Run by `release.test.ts`: the request of a response, sent as its body (an
// echo), without a listener of `error` of the application. Node.js schedules
// the error of a request (e.g. of a client that aborts) once it has found a
// listener: the guard of the request listens before the send removes its own
// one, so that an error scheduled then does not crash the process, and the
// guard logs it at `debug` (the send never destroys the request). Modes:
// `write` (a write of the response fails while the request aborts: Node.js
// emits its error on the next turn) and `rst` or `fin` (the client of an echo
// that the application has paused resets or closes its connection once the
// send has failed, its body being longer than the `Content-Length` of the
// response). Prints how the send has settled and the listeners of `error`
// left on the request once it has closed, then the level and the code of
// what the guard has logged.
import {
  Binden,
  BindenResponse,
  type Context,
  releasedFailure,
} from "../../index.js";
import { type Socket, connect } from "node:net";
import { Duplex } from "node:stream";
import { IncomingMessage } from "node:http";
import { capture } from "../helpers.js";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

/** Settles after `ms` milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** How a send has settled: `resolved`, or the code (or the message) of its error */
function outcomeOf(promise: Promise<void>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: unknown) => {
      const { code, message } = error as { code?: unknown; message: string };
      return typeof code === "string" ? code : message;
    },
  );
}

const [mode = "write"] = process.argv.slice(2);

if (mode === "write") {
  // A connection whose writes complete once they are told so
  let complete: ((error?: Error | null) => void) | null = null;
  const wire = new Duplex({
    read(): void {
      // Nothing comes
    },
    write(_chunk, _encoding, callback): void {
      complete = callback;
    },
  }).on("error", () => {
    // Destroyed below
  });
  const request = new IncomingMessage(wire as unknown as Socket);
  Object.assign(request, {
    method: "POST",
    complete: false,
    headers: { "content-length": "10" },
    httpVersionMajor: 1,
    httpVersionMinor: 1,
  });
  const response = new BindenResponse(request);
  response.assignSocket(wire as unknown as Socket);
  const sent = outcomeOf(response.send(request));
  request.push(Buffer.from("abc"));
  // Once its first chunk is written
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  wire.destroy();
  request.destroy(new Error("Request aborted"));
  process.nextTick(() => {
    complete?.(new Error("Write aborted"));
  });
  const outcome = await sent;
  // The guard is removed on the turn after the close
  await sleep(10);
  process.stdout.write(`${outcome} ${request.listenerCount("error")}\n`);
} else {
  const captured = capture();
  const settled = Promise.withResolvers<[string, IncomingMessage]>();
  const app = new Binden({ logger: captured.logger }).use(
    async (context: Context) => {
      const { request, response } = context;
      // Its buffered body is longer than the length of the response
      request.pause();
      response.setHeader("Content-Length", "10");
      settled.resolve([await outcomeOf(context.send(request)), request]);
      // The response stays open until its client goes away (its request is
      // aborted then): never by a listener of `error` (e.g. of `once()`)
      await new Promise((resolve) => {
        request.on("close", resolve);
      });
    },
  );
  const server = app.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => {
    // Reset below
  });
  await once(socket, "connect");
  socket.write(
    "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000000\r\n\r\n",
  );
  socket.write(Buffer.alloc(4000, 0x61));
  const [outcome, request] = await settled.promise;
  if (mode === "rst") {
    socket.resetAndDestroy();
  } else {
    socket.destroy();
  }
  const record = await captured.waitFor(releasedFailure);
  // The guard is removed on the turn after the close
  await sleep(10);
  server.close();
  process.stdout.write(
    `${outcome} ${request.listenerCount("error")}\n${String(record.level)} ${String((record.failure as { code?: unknown }).code)}\n`,
  );
}
