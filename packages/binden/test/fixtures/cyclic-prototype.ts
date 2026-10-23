// Run by `process.test.ts`: the error serializer must not loop forever on a
// value whose chain of prototypes never ends (it would block the event loop)
import { serializers } from "../../index.js";

// Its prototype is itself
const cyclic: object = new Proxy(
  {},
  {
    getPrototypeOf(): object {
      return cyclic;
    },
  },
);
// Its prototype is a new proxy every time
const endless = (): object =>
  new Proxy(
    {},
    {
      getPrototypeOf(): object {
        return endless();
      },
    },
  );

process.stdout.write(
  `${JSON.stringify([serializers.error(cyclic), serializers.error(endless())])}\n`,
);
