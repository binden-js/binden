#!/usr/bin/env node
// Removes the `dist` directory of the current workspace (its `prebuild` script),
// without a shell command (`rm -rf` does not exist on Windows)
import { rmSync } from "node:fs";

rmSync("dist", { force: true, recursive: true });
