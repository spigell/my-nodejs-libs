#!/usr/bin/env node
import { runCli } from '../agents/claude-cache-keeper.js';

await runCli(process.argv.slice(2));
