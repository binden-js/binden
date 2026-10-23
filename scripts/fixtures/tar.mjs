// Writes gzipped tar archives for the tests of the release tooling, entry by entry
// (ustar headers), so that the tests control what an archive contains.
import { gzipSync } from "node:zlib";

const blockSize = 512;

function pad(data) {
  const rest = data.length % blockSize;
  return rest === 0
    ? data
    : Buffer.concat([data, Buffer.alloc(blockSize - rest)]);
}

function header({ name, size, type, prefix, magic, sizeField, checksum }) {
  const block = Buffer.alloc(blockSize);
  // A name may be the bytes of the field
  if (Buffer.isBuffer(name)) {
    name.copy(block, 0);
  } else {
    block.write(name, 0, 100, "utf8");
  }
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  if (typeof sizeField === "undefined") {
    block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  } else {
    sizeField.copy(block, 124);
  }
  block.write("00000000000\0", 136);
  block.write(" ".repeat(8), 148);
  block.write(type, 156);
  block.write(magic, 257, "latin1");
  block.write(prefix, 345, 155, "utf8");
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${(checksum ?? sum).toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

/** A pax extended header record (`<length> <key>=<value>\n`) */
export function paxRecord(key, value) {
  const record = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(record);
  length += String(length + String(length).length).length;
  return `${length}${record}`;
}

/**
 * A gzipped tar archive of `entries` (`{ name, content, type, prefix, size }`, by
 * default a regular file, or the bytes of a `Buffer` as they are), in their order, then
 * `end` (the end of the archive: two zero blocks). An entry may also set the bytes of
 * its name (a `Buffer`), the `magic` of its header (with its version), the bytes of its
 * size field (`sizeField`), its `checksum`, and leave its data without padding
 * (`padded: false`).
 */
export function tar(entries, { end = Buffer.alloc(blockSize * 2) } = {}) {
  const blocks = entries.flatMap((entry) => {
    if (Buffer.isBuffer(entry)) {
      return [entry];
    }
    const {
      name,
      content = "",
      type = "0",
      prefix = "",
      size,
      magic = "ustar\u000000",
      sizeField,
      checksum,
      padded = true,
    } = entry;
    const data = Buffer.from(content);
    return [
      header({
        name,
        size: size ?? data.length,
        type,
        prefix,
        magic,
        sizeField,
        checksum,
      }),
      padded ? pad(data) : data,
    ];
  });
  return gzipSync(Buffer.concat([...blocks, end]));
}

/** An npm tarball: every file of `files` ({ path: content }) inside `package/` */
export function npmTarball(files) {
  return tar(
    Object.entries(files).map(([path, content]) => ({
      name: `package/${path}`,
      content,
    })),
  );
}
