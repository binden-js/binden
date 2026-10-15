import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { type IRepresentation, kRepresentation } from "./seal.js";
import native, { type PlatformPath, join } from "node:path";
import { BindenError } from "./error.js";
import { BindenRequest } from "./request.js";
import type { BindenResponse } from "./response.js";
import ContentRange from "./headers/content-range.js";
import ContentType from "./headers/content-type.js";
import IfModifiedSince from "./headers/if-modified-since.js";
import type { IncomingMessage } from "node:http";
import Range from "./headers/range.js";
import type { Readable } from "node:stream";
import { constants } from "node:fs";
import { contentTypeOf } from "./mime.js";
import { fileURLToPath } from "node:url";
import { parseHttpDate } from "./headers/http-date.js";
import { split } from "./headers/list.js";

/** The options of `BindenResponse.sendFile()` */
export interface ISendFileOptions {
  /**
   * The directory to serve the file from: the path must then be a relative
   * string (a filesystem path, not URL-encoded) that stays inside it
   */
  readonly root?: URL | string | undefined;
  /**
   * The files and directories whose name starts with a dot, under `root`:
   * `"ignore"` (404, the default), `"deny"` (403) or `"allow"`
   */
  readonly dotfiles?: "allow" | "deny" | "ignore" | undefined;
  /** A weak `ETag` from the size and the modification time (`true` by default) */
  readonly etag?: boolean | undefined;
  /** A strong `ETag` (e.g. `"<hash>"`) that the application guarantees for the file */
  readonly validator?: string | undefined;
  /** The `Last-Modified` header (`true` by default) */
  readonly last_modified?: boolean | undefined;
  /** The `Cache-Control` header (not with `max_age` or `immutable`) */
  readonly cache_control?: string | undefined;
  /** `Cache-Control: public, max-age=<seconds>` */
  readonly max_age?: number | undefined;
  /** Adds `immutable` to the `Cache-Control` of `max_age` */
  readonly immutable?: boolean | undefined;
  /**
   * The `Content-Type`: by default, from the extension of the file (or
   * `application/octet-stream`) unless the response has one; `false` leaves it
   */
  readonly content_type?: false | string | undefined;
}

/** The options of `sendFile()`, validated */
interface IFileOptions {
  readonly root: string | null;
  readonly dotfiles: "allow" | "deny" | "ignore";
  readonly etag: boolean;
  readonly validator: string | null;
  readonly last_modified: boolean;
  readonly cache_control: string | null;
  readonly content_type: false | string | null;
}

/** The file to open: its path (or URL), its name, and whether it is under `root` */
interface ILocation {
  readonly file: URL | string;
  readonly name: string;
  readonly contained: boolean;
}

const policies: ReadonlySet<unknown> = new Set(["allow", "deny", "ignore"]);

/** A strong entity-tag (RFC 9110, section 8.8.3) */
const strongTag = /^"[\x21\x23-\x7E]*"$/u;

/** A field value of visible ASCII characters, spaces and tabs */
const fieldValue = /^[\t\x20-\x7E]+$/u;

/**
 * The errors of a path that does not lead to a regular file (e.g. a socket,
 * which cannot be opened: `ENXIO`, or `EOPNOTSUPP` on macOS)
 */
const missing: ReadonlySet<unknown> = new Set([
  "EISDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "ENODEV",
  "ENOENT",
  "ENOTDIR",
  "ENXIO",
  "EOPNOTSUPP",
]);

const windows = process.platform === "win32";

/** Throws a `TypeError` unless the option is a boolean (or not set) */
function boolean(value: unknown, name: string): void {
  if (typeof value !== "undefined" && typeof value !== "boolean") {
    throw new TypeError(`\`${name}\` is not a boolean`);
  }
}

/** The absolute path of `root` (a non-empty path, or a `file:` URL) */
function parseRoot(root: unknown): string | null {
  if (typeof root === "undefined") {
    return null;
  } else if (root instanceof URL) {
    if (root.protocol !== "file:") {
      throw new TypeError(`Protocol ${root.protocol} is not supported`);
    }
    return fileURLToPath(root);
  } else if (typeof root !== "string" || root === "") {
    throw new TypeError("`root` is not a non-empty string or a URL");
  }
  return root;
}

/** Validates the options (a `TypeError` or a `RangeError` for invalid ones) */
function parseOptions({
  root,
  dotfiles = "ignore",
  etag = true,
  validator,
  last_modified = true,
  cache_control,
  max_age,
  immutable,
  content_type,
}: ISendFileOptions): IFileOptions {
  boolean(etag, "etag");
  boolean(last_modified, "last_modified");
  boolean(immutable, "immutable");
  if (!policies.has(dotfiles)) {
    throw new TypeError("`dotfiles` is not one of allow, deny and ignore");
  } else if (typeof validator !== "undefined" && !strongTag.test(validator)) {
    throw new TypeError("`validator` is not a strong entity-tag");
  } else if (
    typeof cache_control !== "undefined" &&
    (typeof max_age !== "undefined" || typeof immutable !== "undefined")
  ) {
    throw new TypeError("`cache_control` excludes `max_age` and `immutable`");
  } else if (
    typeof cache_control !== "undefined" &&
    !fieldValue.test(cache_control)
  ) {
    throw new TypeError("`cache_control` is not a valid field value");
  } else if (typeof max_age !== "undefined" && !Number.isSafeInteger(max_age)) {
    throw new TypeError("`max_age` is not an integer");
  } else if (typeof max_age !== "undefined" && max_age < 0) {
    throw new RangeError("`max_age` is negative");
  } else if (
    typeof immutable !== "undefined" &&
    typeof max_age === "undefined"
  ) {
    throw new TypeError("`immutable` needs `max_age`");
  }

  let type: false | string | null = null;
  if (typeof content_type === "string") {
    const parsed = ContentType.fromString(content_type);
    if (parsed === null) {
      throw new TypeError(`Invalid media type: ${content_type}`);
    }
    type = parsed.toString();
  } else if (content_type === false) {
    type = false;
  } else if (typeof content_type !== "undefined") {
    throw new TypeError("`content_type` is not a string or `false`");
  }

  return {
    root: parseRoot(root),
    dotfiles,
    etag,
    validator: validator ?? null,
    last_modified,
    cache_control:
      cache_control ??
      (typeof max_age === "undefined"
        ? null
        : `public, max-age=${max_age}${immutable === true ? ", immutable" : ""}`),
    content_type: type,
  };
}

/**
 * The segments of a path relative to `root`, split on `/` (and `\` on
 * Windows), or `null` when it is not one: an empty segment (also of an
 * absolute or UNC path), `.` or `..`, a NUL character, or (on Windows) a
 * drive letter or a stream (`:`)
 */
export function relativeSegments(path: string, win: boolean): string[] | null {
  const segments = path.split(win ? /[/\\]/u : "/");
  const valid = segments.every(
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      !segment.includes("\0") &&
      !(win && segment.includes(":")),
  );
  return valid ? segments : null;
}

/** Applies the `dotfiles` policy to the segments of a path */
function checkDotfiles(
  segments: readonly string[],
  dotfiles: IFileOptions["dotfiles"],
): void {
  if (dotfiles !== "allow" && segments.some((s) => s.startsWith("."))) {
    throw new BindenError(dotfiles === "deny" ? 403 : 404);
  }
}

/** A 404 error for a path that does not lead to a file, the error itself otherwise */
function notFound(error: unknown): unknown {
  return missing.has((error as { code?: unknown }).code)
    ? new BindenError(404, { cause: error })
    : error;
}

/**
 * The segments of the path of `file` relative to the directory `base` (both
 * real paths), or `null` when it is not inside it: by `path.relative()`, not
 * by a prefix (`/srv/public-old` is not inside `/srv/public`), nor on another
 * drive (Windows)
 */
export function within(
  base: string,
  file: string,
  platform: PlatformPath = native,
): string[] | null {
  const inside = platform.relative(base, file);
  const parts = inside.split(platform.sep);
  return inside === "" || parts[0] === ".." || platform.isAbsolute(inside)
    ? null
    : parts;
}

/**
 * The file of `path`: as it is without `root` (a trusted path, or a `file:`
 * URL), otherwise the real path of a relative path that stays inside the real
 * path of `root` (404 outside of it, for a symbolic link that leads out, or
 * for anything but a regular file: a socket, a device or a FIFO is not opened)
 */
async function locate(
  path: URL | string,
  { root, dotfiles }: IFileOptions,
): Promise<ILocation> {
  if (root === null) {
    if (path instanceof URL) {
      if (path.protocol !== "file:") {
        throw new TypeError(`Protocol ${path.protocol} is not supported`);
      }
      return {
        file: new URL(path.href),
        name: path.pathname,
        contained: false,
      };
    } else if (typeof path !== "string") {
      throw new TypeError("The path is not a string or a URL");
    }
    return { file: path, name: path, contained: false };
  } else if (typeof path !== "string") {
    throw new TypeError("With `root`, the path must be a relative string");
  }

  const segments = relativeSegments(path, windows);
  if (segments === null) {
    throw new BindenError(404);
  }
  checkDotfiles(segments, dotfiles);

  const base = await realpath(root);
  const file = await realpath(join(base, ...segments)).catch(
    (error: unknown) => {
      throw notFound(error);
    },
  );
  const parts = within(base, file);
  if (parts === null) {
    throw new BindenError(404);
  }
  // Also the real names (e.g. of a symbolic link to a dotfile)
  checkDotfiles(parts, dotfiles);
  const stats = await lstat(file).catch((error: unknown) => {
    throw notFound(error);
  });
  if (!stats.isFile()) {
    throw new BindenError(404);
  }
  return { file, name: path, contained: true };
}

/**
 * Opens a file without waiting for a writer of a FIFO (`O_NONBLOCK` is not
 * defined on Windows, which has no FIFOs) and, under `root`, without following
 * a symbolic link that replaced the file since its real path was resolved
 */
async function openFile({ file, contained }: ILocation): Promise<FileHandle> {
  const flags =
    constants.O_RDONLY |
    constants.O_NONBLOCK |
    (contained ? constants.O_NOFOLLOW : 0);
  try {
    return await open(file, flags);
  } catch (error: unknown) {
    throw contained ? notFound(error) : error;
  }
}

/**
 * Whether a list of entity-tags (or `*`, as the representation exists) matches
 * an `ETag`, by the strong or the weak comparison (RFC 9110, section 8.8.3.2)
 */
export function matches(
  list: string,
  etag: string | null,
  strong: boolean,
): boolean {
  if (list.trim() === "*") {
    return true;
  } else if (etag === null || (strong && etag.startsWith("W/"))) {
    return false;
  }
  const opaque = etag.replace(/^W\//u, "");
  return split(list, ",").some((value) => {
    const tag = value.trim();
    return strong ? tag === etag : tag.replace(/^W\//u, "") === opaque;
  });
}

/**
 * The `ETag` of a representation (`null` without one): a strong one becomes
 * weak when a library codes the body as it is sent, as it no longer stands
 * for the bytes that are sent (RFC 9110, section 8.8.3.3)
 */
export function tagOf(
  etag: unknown,
  { coding }: IRepresentation,
): string | null {
  if (typeof etag !== "string") {
    return null;
  }
  return coding === null || etag.startsWith("W/") ? etag : `W/${etag}`;
}

/**
 * The methods that neither select nor modify a representation, whose
 * conditional header fields are ignored (RFC 9110, section 13.2.1)
 */
const unconditional: ReadonlySet<string> = new Set([
  "CONNECT",
  "OPTIONS",
  "TRACE",
]);

/**
 * The status of a request whose precondition fails for a representation, in
 * the order of RFC 9110 (section 13.2.2), or `null` when they pass:
 * `If-Match` (or else `If-Unmodified-Since`) fails with `412`, then
 * `If-None-Match` (or else `If-Modified-Since`, for `GET` and `HEAD`) matches
 * with `304` for `GET` and `HEAD`, and `412` for the other methods. The
 * entity-tags are compared with the `ETag` of the representation (`null`
 * without one), the dates with its `Last-Modified` (ignored when `null`).
 * They are ignored for `CONNECT`, `OPTIONS` and `TRACE` (section 13.2.1).
 * Shared by `sendFile()` and the dynamic `ETag` of the responses.
 */
export function preconditionsOf(
  request: IncomingMessage,
  etag: string | null,
  lm: Date | null,
): 304 | 412 | null {
  const { method = "GET", headers } = request;
  if (unconditional.has(method)) {
    return null;
  }
  const read = method === "GET" || method === "HEAD";
  const ims =
    request instanceof BindenRequest
      ? request.if_modified_since
      : IfModifiedSince.fromString(headers["if-modified-since"]);
  const ifMatch = headers["if-match"];
  const ius = parseHttpDate(headers["if-unmodified-since"]?.trim() ?? "");
  const ifNoneMatch = headers["if-none-match"];
  if (typeof ifMatch === "string") {
    if (!matches(ifMatch, etag, true)) {
      return 412;
    }
  } else if (lm !== null && ius !== null && lm > ius) {
    return 412;
  }
  if (typeof ifNoneMatch === "string") {
    if (matches(ifNoneMatch, etag, false)) {
      return read ? 304 : 412;
    }
  } else if (read && lm !== null && ims !== null && lm <= ims.date) {
    return 304;
  }
  return null;
}

/**
 * Whether `If-Range`, when sent, matches the file (RFC 9110, section 13.1.5):
 * its strong `ETag`, or exactly its `Last-Modified` when that is a strong
 * validator
 */
function ifRange(
  raw: string[] | string | undefined,
  etag: unknown,
  lm: Date | null,
): boolean {
  // Sent more than once, it is invalid: it does not match
  const value = typeof raw === "string" ? raw.trim() : "";
  if (typeof raw === "undefined") {
    return true;
  } else if (value.startsWith(`"`) || value.startsWith("W/")) {
    // An entity-tag matches a strong `ETag` of the response only
    return etag === value && !value.startsWith("W/");
  }
  // An HTTP-date matches the `Last-Modified` exactly, when it is a strong
  // validator: at least a second before now (RFC 9110, section 8.8.2.2)
  const now = Math.floor(Date.now() / 1000) * 1000;
  return (
    lm !== null &&
    parseHttpDate(value)?.getTime() === lm.getTime() &&
    now - lm.getTime() >= 1000
  );
}

/**
 * The byte range of a file to send: `null` for the whole file (without a
 * range, or with several distinct ones: `multipart/byteranges` is not
 * supported), or `"unsatisfiable"` (RFC 9110, section 14.1.1)
 */
function byteRange(
  ranges: readonly Range[],
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (ranges.length === 0) {
    return null;
  }

  const satisfiable = ranges
    .flatMap(({ start, end }): [number, number][] => {
      if (start === null) {
        // A suffix: the last `end` bytes
        return end !== null && end > 0 && size > 0
          ? [[Math.max(0, size - end), size - 1]]
          : [];
      }
      return start < size ? [[start, Math.min(end ?? size, size - 1)]] : [];
    })
    .sort(([a], [b]) => a - b);
  const [first, ...rest] = satisfiable;

  if (typeof first === "undefined") {
    return "unsatisfiable";
  }

  // Overlapping or adjacent ranges are one range
  const [start] = first;
  let [, end] = first;
  for (const [nextStart, nextEnd] of rest) {
    if (nextStart > end + 1) {
      return null;
    }
    end = Math.max(end, nextEnd);
  }

  return start === 0 && end === size - 1 ? null : { start, end };
}

/** The validators, caching and representation headers of a file */
function setHeaders(
  response: BindenResponse,
  options: IFileOptions,
  name: string,
  lm: Date | null,
  { mtimeMs, size }: { mtimeMs: number; size: number },
): void {
  const { validator, etag, cache_control, content_type } = options;
  if (validator !== null) {
    response.setHeader("ETag", validator);
  } else if (etag && !response.hasHeader("ETag")) {
    const weak = `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
    response.setHeader("ETag", weak);
  }
  if (lm !== null) {
    response.setHeader("Last-Modified", lm.toUTCString());
  }
  if (cache_control !== null) {
    response.setHeader("Cache-Control", cache_control);
  }
  if (typeof content_type === "string") {
    response.setHeader("Content-Type", content_type);
  } else if (content_type === null && !response.hasHeader("Content-Type")) {
    response.setHeader("Content-Type", contentTypeOf(name));
  }
  response.set({
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  });
}

/**
 * Sends a file (see `BindenResponse.sendFile()`). Its metadata and its content
 * are read from one file handle, so that they belong to the same file (also
 * when the path is replaced), and no more than its size is sent. A `304` is
 * sent by `notModified()`, with the length of the whole file. The file is the
 * body of the status of the response: the preconditions apply to a `2xx` (or a
 * `412`), the ranges to a `200`. Once `stopped()` (the send has been
 * cancelled), the file is not opened, or is closed at once.
 */
export async function sendFileTo(
  response: BindenResponse,
  path: URL | string,
  options: ISendFileOptions | undefined,
  notModified: (length: number) => Promise<void>,
  stopped: () => boolean,
): Promise<void> {
  // The status that the application has set (e.g. `404` for a page of an
  // error): the file is its body
  const status = response.statusCode;
  const parsed = parseOptions(options ?? {});
  const location = await locate(path, parsed);
  if (stopped()) {
    return;
  }
  const handle = await openFile(location);
  // Closed by the stream of its content, or else here
  let stream: Readable | null = null;
  try {
    if (stopped()) {
      // Opened late: nothing is sent
      return;
    }
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw location.contained
        ? new BindenError(404)
        : new Error("Provided path does not correspond to a regular file");
    }

    const { mtime, size } = stats;
    // In seconds, as an HTTP-date, and not in the future (RFC 9110, section 8.8.2.1)
    const lm = parsed.last_modified
      ? new Date(
          Math.floor(Math.min(mtime.getTime(), Date.now()) / 1000) * 1000,
        )
      : null;

    setHeaders(response, parsed, location.name, lm, stats);

    // The representation, before the preconditions (RFC 9110, section
    // 13.2.2): a library may code the file as it is sent (e.g. a compression:
    // its `ETag` is then weak, and it has no ranges), or replace the response
    // (e.g. with `406 Not Acceptable`, whatever the preconditions are)
    const representation = response[kRepresentation](size);
    if (representation.status !== null) {
      await response.status(representation.status).send();
      return;
    }

    const { req } = response;
    const { method = "GET", headers } = req;
    const etag = response.getHeader("ETag");
    // The preconditions apply to a successful response (or a `412`), not to
    // a redirect or an error (RFC 9110, section 13.2.1)
    const failed =
      (status >= 200 && status <= 299) || status === 412
        ? preconditionsOf(req, tagOf(etag, representation), lm)
        : null;
    if (failed === 304) {
      // With the length of the whole file, as the `200` that it stands for
      await notModified(size);
      return;
    } else if (failed !== null) {
      // Empty, also for `HEAD` (which would keep the length of a body), and
      // without the coding of the file (e.g. a precompressed one)
      if (response.hasHeader("Content-Encoding")) {
        response.removeHeader("Content-Encoding");
      }
      await response.status(failed).setHeader("Content-Length", 0).send();
      return;
    } else if (method === "HEAD") {
      // The headers of the whole file, without reading it
      await response.setHeader("Content-Length", size).send();
      return;
    }

    // Ranges apply to GET only (RFC 9110, section 14.2), of a response that
    // would be a `200` (not to any other status, e.g. of an error), and to
    // the file as it is: a coded representation is sent whole
    const ranges =
      method !== "GET" ||
      status !== 200 ||
      representation.coding !== null ||
      !ifRange(headers["if-range"], etag, lm)
        ? []
        : req instanceof BindenRequest
          ? req.range
          : Range.fromString(headers.range);
    const range = byteRange(ranges, size);

    if (range === "unsatisfiable") {
      const cr = new ContentRange({ size }).toString();
      await response.setHeader("Content-Range", cr).status(416).send();
      return;
    }

    if (range === null && size === 0) {
      await response.setHeader("Content-Length", 0).send();
      return;
    }

    // No more than the size that is sent as its length
    const { start, end } = range ?? { start: 0, end: size - 1 };
    stream = handle.createReadStream({ start, end });
    if (range === null) {
      await response.setHeader("Content-Length", size).send(stream);
      return;
    }
    const cr = new ContentRange({ size, start, end }).toString();
    await response
      .set({ "Content-Length": end - start + 1, "Content-Range": cr })
      .status(206)
      .send(stream);
  } finally {
    if (stream === null) {
      await handle.close();
    }
  }
}
