// Type tests: compiled by `tsc` (the build of the package), where every
// `@ts-expect-error` must be an error. The test only checks that the typed
// values can be created.
import { ok } from "node:assert/strict";
import { test } from "node:test";
import { Ajv as AJV, type JTDDataType } from "ajv/dist/jtd.js";
import type { Context } from "binden";

import {
  BodyParser,
  type IBodyKind,
  type IBodyParserOptions,
  type IParse,
} from "../index.js";

interface IUser {
  user: string;
}

const none = ({} as { value?: undefined }).value;

/** Checks that a value has the type `T` */
function is<T>(value: T): T {
  return value;
}

test("types", () => {
  // The type of the result is inferred from `parse`
  is<BodyParser<IUser>>(
    new BodyParser({ parse: (input): IUser => ({ user: input }) }),
  );
  is<BodyParser<IUser>>(
    new BodyParser({
      parse: (input): IUser | undefined => {
        if (input === "") {
          return none;
        }
        return { user: input };
      },
    }),
  );
  is<BodyParser<IUser>>(
    new BodyParser({
      parse: (input): Promise<IUser> => Promise.resolve({ user: input }),
    }),
  );
  const schema = { properties: { user: { type: "string" } } } as const;
  const parse = new AJV().compileParser<JTDDataType<typeof schema>>(schema);
  is<BodyParser<{ user: string }>>(new BodyParser({ parse }));
  is<IParse<{ user: string }>>(parse);
  is<BodyParser>(new BodyParser());
  // @ts-expect-error -- a parser of another type
  is<BodyParser<IUser>>(new BodyParser({ parse: (): number => 1 }));
  // @ts-expect-error -- `parse` gets a string
  is(new BodyParser({ parse: (input: number): number => input }));

  // `verify` gets the decoded body, the context and the encoded body (if any)
  is(
    new BodyParser({
      verify: (decoded, context, { encoded }): void => {
        is<Buffer>(decoded);
        is<Context>(context);
        is<Buffer | null>(encoded);
      },
    }),
  );
  is(new BodyParser({ verify: (): Promise<boolean> => Promise.resolve(true) }));

  // `type` returns a kind (or `null`)
  is(
    new BodyParser({
      type: (content_type): IBodyKind | null => {
        const { type } = content_type;
        return type === "application/csp-report" ? "json" : null;
      },
    }),
  );
  // @ts-expect-error -- not a kind
  is(new BodyParser({ type: (): string => "xml" }));
  // @ts-expect-error -- a list of strings
  is(() => new BodyParser({ type: [1] }));

  // Every option may be `undefined`
  const options: Required<IBodyParserOptions<IUser>> = {
    parse: none,
    limit: none,
    encoded_limit: none,
    type: none,
    raw: none,
    strict: none,
    parameter_limit: none,
    verify: none,
    verify_encoded: none,
    disabled: none,
    ignore_errors: none,
  };
  ok(is<BodyParser<IUser>>(new BodyParser(options)) instanceof BodyParser);
});
