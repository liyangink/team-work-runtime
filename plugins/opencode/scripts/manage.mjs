#!/usr/bin/env node

import { runInstallerCli } from "../../../installer/cli.mjs"

process.exitCode = await runInstallerCli(process.argv.slice(2))
