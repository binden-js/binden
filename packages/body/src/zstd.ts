// The decoding of the `zstd` content coding (RFC 8878) for `BodyParser`: an
// internal module, which the package does not export
import { constants, createZstdDecompress, zstdDecompressSync } from "node:zlib";
import { BindenError } from "binden";
import { Duplex } from "node:stream";

/**
 * A part of `zstd` data (RFC 8878, section 3.1): the magic number of a frame,
 * the descriptor and the rest of the `header` of a frame, the header
 * (`block`) and the `content` of a block, the `checksum` of a frame, or the
 * `size` and the data (`skip`) of a skippable frame
 */
type IZstdPart =
  | "block"
  | "checksum"
  | "content"
  | "descriptor"
  | "header"
  | "magic"
  | "size"
  | "skip";

/** The frames of the `zstd` codings of a request so far, shared by their decoders */
export interface IZstdFrameCount {
  frames: number;
}

/**
 * The most `zstd` frames of a request (data, empty and skippable ones), over
 * every `zstd` coding of its body: each frame is a step of the decoding, so
 * that a body of tiny frames would cost much more than its size
 */
export const ZSTD_MAX_FRAMES = 1024;

/** The largest window of a `zstd` frame (8 MiB, RFC 9659) */
const ZSTD_WINDOW_LOG_MAX = 23;

/** The magic number of a `zstd` frame (RFC 8878, section 3.1.1) */
const ZSTD_MAGIC = 0xfd2fb528;

/** The magic numbers of the skippable frames, without their last 4 bits (RFC 8878, section 3.1.2) */
const ZSTD_SKIPPABLE = 0x184d2a5;

/** The error of `zstd` data that is not a frame (e.g. after the end of the last one) */
const ZSTD_INVALID = "Invalid zstd frame";

/** The error of `zstd` data that has no frame, or ends within one */
const ZSTD_TRUNCATED = "Unexpected end of zstd data";

/** The parts of `zstd` data that are read (the others are only counted) */
const zstdFields: ReadonlySet<IZstdPart> = new Set([
  "block",
  "descriptor",
  "magic",
  "size",
]);

/** Two frames of one byte each (`a`, then `b`): a single segment of one raw block */
const probe = Buffer.from([
  0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x01, 0x09, 0x00, 0x00, 0x61, 0x28, 0xb5, 0x2f,
  0xfd, 0x20, 0x01, 0x09, 0x00, 0x00, 0x62,
]);

/**
 * Whether the decoder of Node.js decodes the frames that follow the first one
 * of a write (Node.js 26 does, the decoder of Node.js 24 stops after the
 * first one): found once, by decoding two frames
 */
export const concatenated = zstdDecompressSync(probe).toString() === "ab";

/**
 * Reads `zstd` data, and finds the ends of its frames (RFC 8878, section 3.1)
 * by their headers and the headers of their blocks. What is not a frame
 * throws, and so does a frame of the request beyond `ZSTD_MAX_FRAMES` (a
 * `413 Content Too Large`, of code `zstd_frames`).
 */
export class ZstdFrames {
  readonly #count: IZstdFrameCount;
  /** The bytes of the part being read, when it is a field (4 bytes at most) */
  readonly #field = Buffer.alloc(4);
  #part: IZstdPart = "magic";
  /** The size of the part, and how much of it has been read */
  #need = 4;
  #have = 0;
  /** Whether the frame has a checksum, and the block is its last one */
  #checksum = false;
  #last = false;

  /** Frames that count in `count` (shared by the codings of a request) */
  public constructor(count: IZstdFrameCount) {
    this.#count = count;
  }

  /** Whether the data ends between two frames (or before the first one) */
  public get complete(): boolean {
    return this.#part === "magic" && this.#have === 0;
  }

  /**
   * Reads a chunk, and adds its bytes to `pieces` (unless it is `null`), in a
   * piece for each frame (or part of one): the bytes of two frames are never
   * in one piece
   */
  public scan(chunk: Buffer, pieces: Buffer[] | null): void {
    let start = 0;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const take = Math.min(this.#need - this.#have, chunk.byteLength - offset);
      if (zstdFields.has(this.#part)) {
        chunk.copy(this.#field, this.#have, offset, offset + take);
      }
      this.#have += take;
      offset += take;
      if (this.#have === this.#need) {
        do {
          this.#next();
        } while (this.#need === 0);
        if (this.#part === "magic" && pieces !== null) {
          // The end of a frame
          pieces.push(chunk.subarray(start, offset));
          start = offset;
        }
      }
    }
    if (pieces !== null && start < offset) {
      pieces.push(chunk.subarray(start));
    }
  }

  /** Moves to the part after the one that has been read */
  #next(): void {
    const part = this.#part;
    if (part === "magic") {
      this.#magic();
    } else if (part === "descriptor") {
      this.#descriptor();
    } else if (part === "header" || (part === "content" && !this.#last)) {
      this.#to("block", 3);
    } else if (part === "block") {
      this.#block();
    } else if (part === "content") {
      this.#to("checksum", this.#checksum ? 4 : 0);
    } else if (part === "size") {
      this.#to("skip", this.#field.readUInt32LE(0));
    } else {
      // The end of a frame (its `checksum`, or the data of a skippable one)
      this.#to("magic", 4);
    }
  }

  /**
   * A regular frame, or a skippable one (which the decoder skips), within the
   * frames of the request: anything else is invalid (e.g. data after the
   * last frame)
   */
  #magic(): void {
    const magic = this.#field.readUInt32LE(0);
    if (magic === ZSTD_MAGIC) {
      this.#to("descriptor", 1);
    } else if (magic >>> 4 === ZSTD_SKIPPABLE) {
      this.#to("size", 4);
    } else {
      throw new Error(ZSTD_INVALID);
    }
    this.#count.frames += 1;
    if (this.#count.frames > ZSTD_MAX_FRAMES) {
      throw new BindenError(413, { code: "zstd_frames" });
    }
  }

  /**
   * The rest of the header of a frame: `Window_Descriptor` (unless it is a
   * single segment), `Dictionary_ID` and `Frame_Content_Size` (one byte for a
   * single segment of flag `0`)
   */
  #descriptor(): void {
    const descriptor = this.#field.readUInt8(0);
    const single = (descriptor & 0x20) !== 0;
    const dictionary = descriptor & 0x03;
    const content = descriptor >>> 6;
    this.#checksum = (descriptor & 0x04) !== 0;
    this.#to(
      "header",
      (single ? 0 : 1) +
        (dictionary === 3 ? 4 : dictionary) +
        (content === 0 ? Number(single) : 1 << content),
    );
  }

  /**
   * The content of a block: the byte that an RLE block repeats (the decoder
   * refuses a block of the reserved type)
   */
  #block(): void {
    const header = this.#field.readUIntLE(0, 3);
    const rle = ((header >>> 1) & 0x03) === 1;
    this.#last = (header & 0x01) === 1;
    this.#to("content", rle ? 1 : header >>> 3);
  }

  #to(part: IZstdPart, need: number): void {
    this.#part = part;
    this.#need = need;
    this.#have = 0;
  }
}

/**
 * Decodes `zstd` data through one decoder of Node.js. Its frames are read
 * first (see `ZstdFrames`): a chunk is given to the decoder only once it is
 * known to be valid and within the frames of the request. A decoder that
 * decodes concatenated frames gets whole chunks; any other gets the bytes of
 * one frame at a time, as the decoder of Node.js 24 stops at the end of the
 * first frame of what it gets (and accepts a truncated one). Concatenated
 * frames are one content (skippable frames are skipped); no data at all, what
 * is not a frame and what ends within one fail it.
 */
export class ZstdDecoding extends Duplex {
  readonly #frames: ZstdFrames;
  readonly #whole: boolean;
  readonly #decoder = createZstdDecompress({
    params: { [constants.ZSTD_d_windowLogMax]: ZSTD_WINDOW_LOG_MAX },
  });
  #consumed = 0;

  /**
   * A decoding whose frames count in `count` (shared by the codings of a
   * request), which gives whole chunks to the decoder when `whole` (by
   * default when the decoder of Node.js decodes concatenated frames)
   */
  public constructor(count: IZstdFrameCount, whole = concatenated) {
    super({
      write: (chunk: Buffer, _encoding, callback): void => {
        this.#write(chunk, callback);
      },
      final: (callback): void => {
        this.#final(callback);
      },
      read: (): void => {
        this.#decoder.resume();
      },
      destroy: (error, callback): void => {
        this.#decoder.destroy();
        callback(error);
      },
    });
    this.#frames = new ZstdFrames(count);
    this.#whole = whole;
    this.#decoder
      .on("data", (chunk: Buffer) => {
        if (!this.push(chunk)) {
          this.#decoder.pause();
        }
      })
      .once("end", () => {
        this.push(null);
      })
      .once("error", (error: Error) => {
        this.destroy(error);
      });
  }

  /** The bytes that it has consumed: all of those that it has got */
  public get bytesWritten(): number {
    return this.#consumed;
  }

  #write(chunk: Buffer, callback: (error?: Error | null) => void): void {
    this.#consumed += chunk.byteLength;
    // The whole chunk is read before the decoder gets any of it
    const pieces = this.#whole ? null : [];
    try {
      this.#frames.scan(chunk, pieces);
    } catch (error: unknown) {
      callback(error as Error);
      return;
    }
    this.#feed(pieces ?? [chunk], 0, callback);
  }

  /**
   * Gives pieces to the decoder in order, each once the decoder has taken the
   * previous ones (its backpressure), then calls `callback`
   */
  #feed(
    pieces: readonly Buffer[],
    from: number,
    callback: (error?: Error | null) => void,
  ): void {
    for (let index = from; index < pieces.length; index += 1) {
      if (!this.#decoder.write(pieces[index])) {
        this.#decoder.once("drain", () => {
          this.#feed(pieces, index + 1, callback);
        });
        return;
      }
    }
    callback();
  }

  #final(callback: (error?: Error | null) => void): void {
    if (this.#consumed === 0 || !this.#frames.complete) {
      callback(new Error(ZSTD_TRUNCATED));
      return;
    }
    this.#decoder.end();
    callback();
  }
}
