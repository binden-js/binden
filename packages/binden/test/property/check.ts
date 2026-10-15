import fc from "fast-check";

/**
 * The seed of the properties: fixed, so that every run checks the same
 * inputs (`FC_SEED=<integer>` checks others). A failure reports the seed and
 * the path of its counterexample, which `FC_SEED` and `FC_PATH` replay.
 */
const seed = Number.parseInt(process.env.FC_SEED ?? "20261015", 10);

/** The path of a counterexample to replay (see `seed`) */
const path = process.env.FC_PATH;

/** Checks a property with a bounded number of runs (`FC_RUNS` overrides it) */
export function check<Ts extends [unknown, ...unknown[]]>(
  property: fc.IProperty<Ts>,
  runs = 300,
): void {
  fc.assert(property, {
    seed,
    numRuns: Number.parseInt(process.env.FC_RUNS ?? `${runs}`, 10),
    ...(typeof path === "string" ? { path } : {}),
  });
}

/** Any string: every code point, or the characters that matter to headers */
export function anyString(
  alphabet: readonly string[],
  maxLength = 40,
): fc.Arbitrary<string> {
  return fc.oneof(
    fc.string({ unit: "binary", maxLength }),
    fc.string({ unit: "binary-ascii", maxLength }),
    fc.string({ unit: fc.constantFrom(...alphabet), maxLength }),
  );
}

/** The visible ASCII characters (`!` to `~`) */
export const visible: readonly string[] = Array.from({ length: 94 }, (_, i) =>
  String.fromCharCode(0x21 + i),
);

/**
 * The characters that a field value may have (RFC 9110, section 5.5): tabs,
 * spaces, visible ASCII and obs-text (`\x80` to `\xFF`)
 */
export const fieldValueChar: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom("\t", " ", '"', "\\", ",", ";", "=", "\xA0", "\xFF"),
  fc.constantFrom(...visible),
  fc.integer({ min: 0x80, max: 0xff }).map((code) => String.fromCharCode(code)),
);

/** A token (RFC 9110, section 5.6.2) */
export const token: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom(
    ..."!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  ),
  minLength: 1,
  maxLength: 8,
});

/** A weight: a qvalue (RFC 9110, section 12.4.2) or none */
export const qvalue: fc.Arbitrary<number | null> = fc.option(
  fc.integer({ min: 0, max: 1000 }).map((thousandths) => thousandths / 1000),
);
