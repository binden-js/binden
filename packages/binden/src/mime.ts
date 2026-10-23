import { extname } from "node:path";

/** The media type of the files that the table does not know */
export const ct_octet_stream = "application/octet-stream";

const utf8 = "; charset=utf-8";

/**
 * The media types of common web files, by their extension in lowercase (text
 * types are sent as UTF-8)
 */
const types: ReadonlyMap<string, string> = new Map([
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["cjs", `text/javascript${utf8}`],
  ["css", `text/css${utf8}`],
  ["csv", `text/csv${utf8}`],
  ["gif", "image/gif"],
  ["gz", "application/gzip"],
  ["htm", `text/html${utf8}`],
  ["html", `text/html${utf8}`],
  ["ico", "image/vnd.microsoft.icon"],
  ["ics", `text/calendar${utf8}`],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["js", `text/javascript${utf8}`],
  ["json", "application/json"],
  ["jsonld", "application/ld+json"],
  ["m4a", "audio/mp4"],
  ["map", "application/json"],
  ["md", `text/markdown${utf8}`],
  ["mjs", `text/javascript${utf8}`],
  ["mp3", "audio/mpeg"],
  ["mp4", "video/mp4"],
  ["oga", "audio/ogg"],
  ["ogg", "audio/ogg"],
  ["ogv", "video/ogg"],
  ["otf", "font/otf"],
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
  ["tar", "application/x-tar"],
  ["ttf", "font/ttf"],
  ["txt", `text/plain${utf8}`],
  ["wasm", "application/wasm"],
  ["wav", "audio/wav"],
  ["weba", "audio/webm"],
  ["webm", "video/webm"],
  ["webmanifest", "application/manifest+json"],
  ["webp", "image/webp"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["xml", "application/xml"],
  ["yaml", `application/yaml`],
  ["yml", `application/yaml`],
  ["zip", "application/zip"],
]);

/**
 * The `Content-Type` of a file by the extension of its name, from a table of
 * common web types (`application/octet-stream` for any other file)
 */
export function contentTypeOf(name: string): string {
  return types.get(extname(name).slice(1).toLowerCase()) ?? ct_octet_stream;
}
