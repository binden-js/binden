// Run by `created-errors.test.ts` (and the tests of the refusals that it
// keeps) with `--expose-gc`: an error that binden creates and throws, rejects
// with or hands over must not keep the request nor the response once the
// application keeps it without reading its stack. Modes: `argument` (the
// `TypeError` of `response.status(99)`, caught by the middleware), `dotfile`
// (the `403` that `sendFile()` rejects with for a dotfile it denies), `hidden`
// (its `404` for a dotfile it ignores), `outside` (its `404` for a path that
// leaves its root), `url` (the `400` that `context.url` throws for an invalid
// `Host`), `redirect` (the `TypeError` of `response.redirect()` for a location
// that is not a URL), `json` (the `TypeError` that `JSON.stringify()` throws in
// `response.json()` for a nested `bigint`), `detached` (the `TypeError` of
// `response.send()` for a view of a detached `ArrayBuffer`), `form` (the
// `TypeError` of `response.form(null)`), `options` (of `response.redirect()`
// with `null` options), `stringify` (of `response.json()` with a `stringify`
// that is not a function), and the refusals of values that binden describes
// without converting them, or whose reading throws (`statusSymbol`,
// `statusNullProto`, `redirectStatusNullProto`, `typeSymbol`, `varySymbol`,
// `varyNull`, `setNull`, `sendEncodingNullProto`, `writeEncodingNullProto`,
// `clearSameSiteSymbol`, `clearSameSiteNull`, `clearExpiresProxy`,
// `jsonClass` and `jsonRevoked`: see `refusals`), caught by the middleware,
// and `throw` (the `BindenError` of `context.throw()`): the error handler
// keeps the error.
// Prints whether the responses and the requests are collected, and the kinds
// of the errors that the application keeps.
import { type AddressInfo, connect } from "node:net";
import {
  Binden,
  BindenRequest,
  BindenResponse,
  type Context,
} from "../../index.js";
import { HOST, capture } from "../helpers.js";
import { once } from "node:events";
import { queryObjects } from "node:v8";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const [mode = "argument"] = process.argv.slice(2);

/** A view of a detached `ArrayBuffer` (transferred) */
function detached(): Uint8Array {
  const bytes = new Uint8Array(4);
  bytes.buffer.transfer();
  return bytes;
}
/** A value of any type, given in place of the one that a method declares */
function given<T>(value: unknown): T {
  return value as T;
}

/** A class, whose constructor cannot be called as a function */
class Stringify {
  public readonly created = Date.now();
}

/** A function whose proxy has been revoked: calling it throws */
function revoked(): () => string {
  const { proxy, revoke } = Proxy.revocable(() => "{}", {});
  revoke();
  return proxy;
}

/**
 * The calls of the modes whose refusal the middleware catches (thrown or
 * rejected with): of a location that is not a URL, a nested `bigint`, a view
 * of a detached `ArrayBuffer`, and the arguments that JavaScript may give in
 * place of the declared ones (e.g. a `Symbol`, or an object without a
 * primitive value, which a conversion would refuse with an error of V8)
 */
const refusals: Partial<Record<string, (response: BindenResponse) => unknown>> =
  {
    redirect: (response) => response.redirect("http://[bad"),
    json: (response) => response.json({ big: 1n }),
    detached: (response) => response.send(detached()),
    form: (response) => response.form(null as unknown as URLSearchParams),
    options: (response) =>
      response.redirect("/", 302, null as unknown as { allow_external: false }),
    stringify: (response) =>
      response.json({}, 5 as unknown as (data: object) => string),
    statusSymbol: (response) => response.status(given(Symbol("status"))),
    statusNullProto: (response) => response.status(given(Object.create(null))),
    redirectStatusNullProto: (response) =>
      response.redirect("/", given(Object.create(null))),
    typeSymbol: (response) => response.type(given(Symbol("type"))),
    varySymbol: (response) => response.vary(given(Symbol("field"))),
    varyNull: (response) => response.vary(given(null)),
    setNull: (response) => response.set(given(null)),
    sendEncodingNullProto: (response) =>
      response.send("data", given(Object.create(null))),
    writeEncodingNullProto: (response) =>
      response.write("data", given(Object.create(null))),
    clearSameSiteSymbol: (response) =>
      response.clearCookie("a", { same_site: given(Symbol("same_site")) }),
    clearSameSiteNull: (response) =>
      response.clearCookie("a", { same_site: given(Object.create(null)) }),
    clearExpiresProxy: (response) =>
      response.clearCookie("a", given({ expires: new Proxy(new Date(0), {}) })),
    jsonClass: (response) => response.json({}, given(Stringify)),
    jsonRevoked: (response) => response.json({}, revoked()),
  };

const requests = 60;
const errors: unknown[] = [];

// Silent: a logger that formatted the errors would format their stacks
const { logger } = capture("silent");
const app = new Binden({
  logger,
  error_handler: (context: Context, error: unknown): Promise<void> => {
    errors.push(error);
    const { status } = error as { status?: unknown };
    return context.response
      .status(typeof status === "number" ? status : 500)
      .send();
  },
}).use((context: Context) => {
  const root = import.meta.dirname;
  switch (mode) {
    case "argument":
      try {
        context.response.status(99);
      } catch (error: unknown) {
        errors.push(error);
      }
      return context.response.status(400).send();
    case "dotfile":
      return context.response.sendFile(".env", { root, dotfiles: "deny" });
    case "hidden":
      return context.response.sendFile(".env", { root, dotfiles: "ignore" });
    case "outside":
      return context.response.sendFile("../../package.json", { root });
    case "url":
      return context.response.send(context.url.pathname);
    case "throw":
      return context.throw(418);
    default:
      return new Promise((resolve) => {
        // What the call throws rejects, as what it rejects with
        resolve(
          (refusals[mode] as (response: BindenResponse) => unknown)(
            context.response,
          ),
        );
      }).then(
        () => context.response.status(500).send(),
        (error: unknown) => {
          errors.push(error);
          return context.response.status(400).send();
        },
      );
  }
});

const server = app.createServer();
server.listen(0, HOST);
await once(server, "listening");
const { port } = server.address() as AddressInfo;
/** One request on a connection of its own */
const request = (): Promise<void> =>
  new Promise((resolve) => {
    const socket = connect(port, HOST);
    socket.on("error", () => {
      // E.g. a reset once the reply is complete
    });
    socket.resume();
    socket.once("close", () => {
      resolve();
    });
    // An invalid `Host` (with a space) for `url`
    const host = mode === "url" ? "bad host" : HOST;
    socket.write(
      `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
    );
  });
for (let sent = 0; sent < requests; sent += 10) {
  await Promise.all(Array.from({ length: 10 }, request));
}
server.closeAllConnections();
server.close();
await once(server, "close");
const gc = Reflect.get(globalThis, "gc") as () => void;
for (let round = 0; round < 3; round += 1) {
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  gc();
}
const responses = queryObjects(BindenResponse, { format: "count" });
const left = Math.max(
  responses,
  queryObjects(BindenRequest, { format: "count" }),
);
const kinds = new Set(
  errors.map((error) => {
    const { name, status } = error as { name?: unknown; status?: unknown };
    return typeof status === "number"
      ? `${String(name)} ${status}`
      : String(name);
  }),
);
process.stdout.write(
  `${left < requests / 10 ? "collected" : `kept ${left}`} ${errors.length} ${[...kinds].sort().join(", ")}\n`,
);
