// Run by `logger.test.ts`: the default logger is created when it is first used
// (its level is the one of the environment then), not when it is imported
import log from "../../index.js";

process.env.BINDEN_LOG_LEVEL = "warn";
process.stdout.write(`${log.level}\n`);
