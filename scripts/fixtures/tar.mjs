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

function header({ name, size, type, prefix }) {
  const block = Buffer.alloc(blockSize);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write(" ".repeat(8), 148);
  block.write(type, 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  block.write(prefix, 345, 155, "utf8");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
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
 * default a regular file), in their order
 */
export function tar(entries) {
  const blocks = entries.flatMap(
    ({ name, content = "", type = "0", prefix = "", size }) => {
      const data = Buffer.from(content);
      return [
        header({ name, size: size ?? data.length, type, prefix }),
        pad(data),
      ];
    },
  );
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(blockSize * 2)]));
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
