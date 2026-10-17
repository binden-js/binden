/**
 * The control characters (C0, DEL and C1) and those of the direction of the
 * text, which can disguise a name (e.g. `invoice\u202Etxt.exe`)
 */
const controls = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** The longest name of a file, in bytes of UTF-8 (that of most file systems) */
const MAX_BYTES = 255;

/**
 * The name of a file as the client has sent it, to keep as metadata (never
 * as a path): without control characters, cut to 255 bytes of UTF-8 between
 * two characters, and `"blob"` when it is empty (or missing)
 */
export function filenameOf(input: string | undefined): string {
  const name = (input ?? "").replace(controls, "");
  let size = 0;
  let end = 0;
  for (const char of name) {
    size += Buffer.byteLength(char);
    if (size > MAX_BYTES) {
      break;
    }
    end += char.length;
  }
  return end === 0 ? "blob" : name.slice(0, end);
}
