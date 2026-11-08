#!/usr/bin/env node
import { main } from '../src/cli.js';

Promise.resolve(main(process.argv.slice(2)))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
