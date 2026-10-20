// The decoding of the `zstd` content coding (RFC 8878) for `BodyParser`: an
// internal module, which the package does not export
import { BindenError, formatStack } from "binden";
import {
  type ZstdDecompress,
  constants,
  createZstdDecompress,
} from "node:zlib";
import { Duplex } from "node:stream";

/**
 * A part of `zstd` data (RFC 8878, section 3.1): the magic number of a frame,
 * the descriptor, the `Window_Descriptor` and `Dictionary_ID` (`header`) and
 * the `Frame_Content_Size` (`fcs`) of a frame, the header (`block`) and the
 * `content` of a block, the `checksum` of a frame, or the `size` and the data
 * (`skip`) of a skippable frame
 */
type IZstdPart =
  | "block"
  | "checksum"
  | "content"
  | "descriptor"
  | "fcs"
  | "header"
  | "magic"
  | "size"
  | "skip";

/**
 * What the `zstd` codings of a request have cost so far, shared by their
 * decodings: their frames, and the memory charged for their decoders
 */
export interface IZstdBudget {
  frames: number;
  memory: number;
}

/**
 * Bytes of a data frame within a chunk, for the decoder of that frame: the
 * last piece of a frame (`end`) ends it
 */
export interface IZstdPiece {
  readonly bytes: Buffer;
  /**
   * For the first piece of a frame, which starts its decoder, the bytes of
   * the frame before it: its magic number and its header, and the header of
   * its first non-empty block when the decoder starts there (the empty blocks
   * before it, which produce nothing, are left out); `null` for the others
   */
  readonly head: Buffer | null;
  readonly end: boolean;
  /**
   * The `Frame_Content_Size` of the frame: `null` when the frame does not
   * declare it
   */
  readonly declared: bigint | null;
}

/**
 * The most `zstd` frames of a request (data, empty and skippable ones), over
 * every `zstd` coding of its body: each frame is a step of the decoding, so
 * that a body of tiny frames would cost much more than its size
 */
export const ZSTD_MAX_FRAMES = 1024;

/**
 * The most memory charged for the decoders of a request (64 MiB), over every
 * `zstd` coding of its body: each data frame that needs a decoder (every one
 * but an empty frame) is charged `ZSTD_DECODER_CHARGE` or the memory of its
 * window, which a decoder allocates (and the garbage collector reclaims)
 */
export const ZSTD_MAX_DECODER_MEMORY = 64 * 1024 * 1024;

/**
 * The least charge of a decoder (256 KiB), for its context and its buffers:
 * a frame is charged its window, or its declared content size when smaller,
 * and at least this (at most 256 decoders per request)
 */
export const ZSTD_DECODER_CHARGE = 256 * 1024;

/** The largest window of a `zstd` frame (8 MiB, RFC 9659) */
const ZSTD_WINDOW_LOG_MAX = 23;

/** The largest window of a `zstd` frame, in bytes */
const ZSTD_WINDOW_MAX = 2 ** ZSTD_WINDOW_LOG_MAX;

/** The most bytes of a block (128 KiB, RFC 8878, section 3.1.1.2.4), or of its window if smaller */
const ZSTD_BLOCK_MAX = 128 * 1024;

/** The magic number of a `zstd` frame (RFC 8878, section 3.1.1) */
const ZSTD_MAGIC = 0xfd2fb528;

/** The magic numbers of the skippable frames, without their last 4 bits (RFC 8878, section 3.1.2) */
const ZSTD_SKIPPABLE = 0x184d2a5;

/**
 * The `Content_Checksum` of an empty content: the low 4 bytes of the XXH64
 * of no data (RFC 8878, section 3.1.1)
 */
const ZSTD_EMPTY_CHECKSUM = 0x51d8e999;

/** The error of `zstd` data that is not a frame (e.g. after the end of the last one) */
const ZSTD_INVALID = "Invalid zstd frame";

/** The error of `zstd` data that has no frame, or ends within one */
const ZSTD_TRUNCATED = "Unexpected end of zstd data";

/** The error of a frame whose content is not of the size that it declares */
const ZSTD_SIZE = "The content of a zstd frame is not of its declared size";

/** The error of a frame whose window is larger than 8 MiB */
const ZSTD_WINDOW = "The window of a zstd frame is larger than 8 MiB";

/** The error of a frame that needs a dictionary */
const ZSTD_DICTIONARY = "A zstd frame needs a dictionary";

/** The error of an empty frame whose checksum is not that of an empty content */
const ZSTD_CHECKSUM = "The checksum of a zstd frame does not match its content";

/** The parts of `zstd` data that are read (the others are only counted) */
const zstdFields: ReadonlySet<IZstdPart> = new Set([
  "block",
  "checksum",
  "descriptor",
  "fcs",
  "header",
  "magic",
  "size",
]);

/** The sizes of a `Dictionary_ID`, by its flag */
const dictionarySizes = [0, 1, 2, 4] as const;

/**
 * Reads `zstd` data, and finds the ends of its frames (RFC 8878, section 3.1)
 * by their headers and the headers of their blocks, and the content size
 * that each frame declares. What is not a frame throws, and so does a frame
 * of the request beyond `ZSTD_MAX_FRAMES`, or a decoder beyond
 * `ZSTD_MAX_DECODER_MEMORY` (a `413 Content Too Large`, of code
 * `zstd_frames`). An empty frame, whose blocks are all empty, gets no decoder:
 * it is checked here as a decoder would check it (its header, its declared
 * size of 0 if any, its blocks and its checksum).
 */
export class ZstdFrames {
  readonly #budget: IZstdBudget;
  /** The bytes of the part being read, when it is a field (8 bytes at most) */
  readonly #field = Buffer.alloc(8);
  /**
   * The bytes of the frame before its decoder starts: its magic number and
   * its header (18 bytes at most), and the header of a block
   */
  readonly #head = Buffer.alloc(21);
  #kept = 0;
  #part: IZstdPart = "magic";
  /** The size of the part, and how much of it has been read */
  #need = 4;
  #have = 0;
  /** Whether the frame is a single segment and has a checksum, and the block is its last one */
  #single = false;
  #checksum = false;
  #last = false;
  /** The size of the `Dictionary_ID` of the frame, and of its `Frame_Content_Size` */
  #dictionary = 0;
  #fcs = 0;
  /** The window of the frame, and its declared content size */
  #window = 0;
  #declared: bigint | null = null;
  /** Whether the frame has a decoder, and its head once it has just got it */
  #decoding = false;
  #started: Buffer | null = null;

  /** Frames whose cost counts in `budget` (shared by the codings of a request) */
  public constructor(budget: IZstdBudget) {
    this.#budget = budget;
  }

  /** Whether the data ends between two frames (or before the first one) */
  public get complete(): boolean {
    return this.#part === "magic" && this.#have === 0;
  }

  /**
   * Reads a chunk whole: the pieces of the data frames in it that have a
   * decoder, in order (the skippable and empty frames are not in them, and
   * the bytes of two frames are never in one piece)
   */
  public scan(chunk: Buffer): IZstdPiece[] {
    const pieces: IZstdPiece[] = [];
    // Where the bytes of a decoded frame start in the chunk (`-1` outside of
    // one), and the head of the frame when its decoder starts in the chunk
    let from = this.#decoding ? 0 : -1;
    let head: Buffer | null = null;
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
        if (this.#started !== null) {
          // The decoder of the frame starts here (before its end: what has
          // started it, a declared size or a block, is followed by more)
          head = this.#started;
          this.#started = null;
          from = offset;
        } else if (this.#part === "magic" && from !== -1) {
          // The end of a decoded frame
          const bytes = chunk.subarray(from, offset);
          pieces.push({ bytes, head, end: true, declared: this.#declared });
          from = -1;
          head = null;
        }
      }
    }
    if (from !== -1) {
      const bytes = chunk.subarray(from);
      pieces.push({ bytes, head, end: false, declared: this.#declared });
    }
    return pieces;
  }

  /** Moves to the part after the one that has been read */
  #next(): void {
    const part = this.#part;
    if (part === "magic") {
      this.#magic();
    } else if (part === "descriptor") {
      this.#descriptor();
    } else if (part === "header") {
      this.#header();
    } else if (part === "fcs") {
      this.#size();
    } else if (part === "content" && !this.#last) {
      this.#to("block", 3);
    } else if (part === "block") {
      this.#block();
    } else if (part === "content") {
      this.#to("checksum", this.#checksum ? 4 : 0);
    } else if (part === "size") {
      this.#to("skip", this.#field.readUInt32LE(0));
    } else {
      // The end of a frame (its `checksum`, or the data of a skippable one)
      if (part === "checksum") {
        this.#verify();
      }
      this.#decoding = false;
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
      throw formatStack(new Error(ZSTD_INVALID));
    }
    this.#budget.frames += 1;
    if (this.#budget.frames > ZSTD_MAX_FRAMES) {
      throw new BindenError(413, { code: "zstd_frames" });
    }
    this.#declared = null;
    this.#kept = 0;
    this.#keep(4);
  }

  /**
   * The rest of the header of a frame: `Window_Descriptor` (unless it is a
   * single segment) and `Dictionary_ID`, then `Frame_Content_Size` (one byte
   * for a single segment of flag `0`, none for another frame of flag `0`).
   * The decoder refuses a frame whose reserved bit is set.
   */
  #descriptor(): void {
    const descriptor = this.#field.readUInt8(0);
    if ((descriptor & 0x08) !== 0) {
      throw formatStack(new Error(ZSTD_INVALID));
    }
    const content = descriptor >>> 6;
    this.#single = (descriptor & 0x20) !== 0;
    this.#checksum = (descriptor & 0x04) !== 0;
    this.#dictionary = dictionarySizes[descriptor & 0x03];
    this.#fcs = content === 0 ? Number(this.#single) : 1 << content;
    this.#keep(1);
    this.#to("header", (this.#single ? 0 : 1) + this.#dictionary);
  }

  /**
   * The `Window_Descriptor` (RFC 8878, section 3.1.1.1.2), within 8 MiB, and
   * the `Dictionary_ID`, which must be `0`: the parser has no dictionary
   */
  #header(): void {
    let at = 0;
    if (!this.#single) {
      const descriptor = this.#field.readUInt8(0);
      const base = 2 ** (10 + (descriptor >>> 3));
      this.#window = base + (base / 8) * (descriptor & 0x07);
      if (this.#window > ZSTD_WINDOW_MAX) {
        throw formatStack(new Error(ZSTD_WINDOW));
      }
      at = 1;
    }
    if (
      this.#dictionary > 0 &&
      this.#field.readUIntLE(at, this.#dictionary) !== 0
    ) {
      throw formatStack(new Error(ZSTD_DICTIONARY));
    }
    this.#keep(this.#need);
    this.#to("fcs", this.#fcs);
  }

  /**
   * The declared content size of the frame (RFC 8878, section 3.1.1.1.4),
   * read exactly (8 bytes as a `bigint`, 2 bytes with an offset of 256),
   * which is the window of a single segment: a frame that declares content
   * has a decoder
   */
  #size(): void {
    const size = this.#fcs;
    if (size > 0) {
      const declared =
        size === 8
          ? this.#field.readBigUInt64LE(0)
          : BigInt(this.#field.readUIntLE(0, size) + (size === 2 ? 256 : 0));
      if (this.#single) {
        if (declared > BigInt(ZSTD_WINDOW_MAX)) {
          throw formatStack(new Error(ZSTD_WINDOW));
        }
        this.#window = Number(declared);
      }
      this.#declared = declared;
    }
    this.#keep(size);
    if (this.#declared !== null && this.#declared > 0n) {
      this.#start();
    }
    this.#to("block", 3);
  }

  /**
   * The content of a block: the byte that an RLE block repeats. The decoder
   * refuses a block of the reserved type. The first block that is not empty
   * (of `Block_Size` 0: a raw or compressed block of no byte, or an RLE block
   * that repeats a byte no time) starts the decoder of the frame. Its head
   * is therefore never the whole frame: the decoder decodes it as a stream,
   * where an empty block produces nothing (in one pass, which it does for a
   * whole frame of a known size that it gets at once, an empty compressed
   * block is corrupt).
   */
  #block(): void {
    const header = this.#field.readUIntLE(0, 3);
    const type = (header >>> 1) & 0x03;
    const size = header >>> 3;
    // As the decoder refuses it: a block of the reserved type, or of more bytes
    // than the window (an RLE block has 1 byte, and a single segment of no
    // content a window of none)
    if (
      type === 3 ||
      (type === 1 ? 1 : size) > Math.min(this.#window, ZSTD_BLOCK_MAX)
    ) {
      throw formatStack(new Error(ZSTD_INVALID));
    }
    this.#last = (header & 0x01) === 1;
    if (!this.#decoding && size > 0) {
      this.#keep(3);
      this.#start();
    }
    this.#to("content", type === 1 ? 1 : size);
  }

  /**
   * The end of a data frame: one without a decoder is empty, and its
   * checksum (if any) must be that of an empty content
   */
  #verify(): void {
    if (
      !this.#decoding &&
      this.#checksum &&
      this.#field.readUInt32LE(0) !== ZSTD_EMPTY_CHECKSUM
    ) {
      throw formatStack(new Error(ZSTD_CHECKSUM));
    }
  }

  /**
   * Charges the decoder of the frame, then starts it: its window, or its
   * declared content size when smaller (what it allocates), and at least
   * `ZSTD_DECODER_CHARGE`
   */
  #start(): void {
    const declared = this.#declared;
    const used =
      declared !== null && declared < BigInt(this.#window)
        ? Number(declared)
        : this.#window;
    this.#budget.memory += Math.max(ZSTD_DECODER_CHARGE, used);
    if (this.#budget.memory > ZSTD_MAX_DECODER_MEMORY) {
      throw new BindenError(413, { code: "zstd_frames" });
    }
    this.#decoding = true;
    this.#started = Buffer.from(this.#head.subarray(0, this.#kept));
  }

  /** Keeps the bytes of the field that has been read in the head of the frame */
  #keep(size: number): void {
    this.#field.copy(this.#head, this.#kept, 0, size);
    this.#kept += size;
  }

  #to(part: IZstdPart, need: number): void {
    this.#part = part;
    this.#need = need;
    this.#have = 0;
  }
}

/**
 * Decodes `zstd` data, one frame after the other, through a decoder of
 * Node.js for each data frame that is not empty. The frames are read first
 * (see `ZstdFrames`): a chunk is given to the decoders only once it is known
 * to be valid and within the frames and the decoder memory of the request,
 * and each decoder gets the bytes of its frame only (the decoder of Node.js
 * 24 stops at the end of the first frame of what it gets, and accepts a
 * truncated one). Once a decoder has ended,
 * what it has produced is checked against the content size that its frame
 * declares (a frame that produces more fails at once), before the next
 * frame is decoded. Concatenated frames are one content (skippable frames are
 * skipped); no data at all, what is not a frame, what ends within one and a
 * frame whose content is not of its declared size fail it.
 */
export class ZstdDecoding extends Duplex {
  readonly #frames: ZstdFrames;
  /** The decoder of the frame being decoded, and what it has produced */
  #decoder: ZstdDecompress | null = null;
  #produced = 0;
  /** The declared content size of the frame being decoded, once known */
  #declared: bigint | null = null;
  #consumed = 0;

  /** A decoding whose frames count in `budget` (shared by the codings of a request) */
  public constructor(budget: IZstdBudget) {
    super({
      write: (chunk: Buffer, _encoding, callback): void => {
        this.#write(chunk, callback);
      },
      final: (callback): void => {
        this.#final(callback);
      },
      read: (): void => {
        this.#decoder?.resume();
      },
      destroy: (error, callback): void => {
        this.#decoder?.destroy();
        callback(error);
      },
    });
    this.#frames = new ZstdFrames(budget);
  }

  /** The bytes that it has consumed: all of those that it has got */
  public get bytesWritten(): number {
    return this.#consumed;
  }

  #write(chunk: Buffer, callback: (error?: Error | null) => void): void {
    this.#consumed += chunk.byteLength;
    const pieces = this.#scan(chunk, callback);
    if (pieces !== null) {
      this.#feed(pieces, 0, callback);
    }
  }

  /**
   * The pieces of a chunk, read whole before a decoder gets any of it: `null`
   * once `callback` has got why it is refused
   */
  #scan(
    chunk: Buffer,
    callback: (error?: Error | null) => void,
  ): IZstdPiece[] | null {
    try {
      return this.#frames.scan(chunk);
    } catch (error: unknown) {
      callback(error as Error);
      return null;
    }
  }

  /**
   * Gives pieces to the decoders in order, each once the decoder has taken
   * the previous ones (its backpressure) and the decoder of the previous
   * frame has ended, then calls `callback`
   */
  #feed(
    pieces: readonly IZstdPiece[],
    from: number,
    callback: (error?: Error | null) => void,
  ): void {
    for (let index = from; index < pieces.length; index += 1) {
      const { bytes, head, end, declared } = pieces[index];
      const decoder =
        head === null ? (this.#decoder as ZstdDecompress) : this.#start(head);
      this.#declared = declared;
      const next = (): void => {
        this.#feed(pieces, index + 1, callback);
      };
      if (end) {
        decoder.once("end", () => {
          if (declared !== null && BigInt(this.#produced) !== declared) {
            callback(formatStack(new Error(ZSTD_SIZE)));
            return;
          }
          this.#decoder = null;
          next();
        });
        decoder.end(bytes);
        return;
      } else if (!decoder.write(bytes)) {
        decoder.once("drain", next);
        return;
      }
    }
    callback();
  }

  /** A decoder for a data frame, which gets the head of the frame first */
  #start(head: Buffer): ZstdDecompress {
    const decoder = createZstdDecompress({
      params: { [constants.ZSTD_d_windowLogMax]: ZSTD_WINDOW_LOG_MAX },
    });
    this.#decoder = decoder;
    this.#produced = 0;
    decoder
      .on("data", (chunk: Buffer) => {
        this.#produced += chunk.byteLength;
        if (
          this.#declared !== null &&
          BigInt(this.#produced) > this.#declared
        ) {
          this.destroy(formatStack(new Error(ZSTD_SIZE)));
        } else if (!this.push(chunk)) {
          decoder.pause();
        }
      })
      .once("error", (error: Error) => {
        this.destroy(error);
      });
    decoder.write(head);
    return decoder;
  }

  #final(callback: (error?: Error | null) => void): void {
    if (this.#consumed === 0 || !this.#frames.complete) {
      callback(formatStack(new Error(ZSTD_TRUNCATED)));
      return;
    }
    this.push(null);
    callback();
  }
}
