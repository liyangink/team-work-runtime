#!/usr/bin/env node

import { LIFECYCLE_COMMANDS, runInstallerCli } from "./installer/cli.mjs"
import { runRuntimeCli } from "./runtime/cli.mjs"

const argv = process.argv.slice(2)
let exitCode
if (argv[0] === "runtime") exitCode = await runRuntimeCli(argv.slice(1))
else if (LIFECYCLE_COMMANDS.has(argv[0])) exitCode = await runInstallerCli(argv)
else exitCode = await runRuntimeCli(argv)
process.exitCode = exitCode
