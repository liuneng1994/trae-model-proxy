#!/usr/bin/env node
import { createUpdateService } from '../src/update.mjs';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log('Usage: npm run update:check | npm run update:apply');
  process.exit(0);
}

const service = createUpdateService({ autoApply: false });
const state = await service.check();
console.log(JSON.stringify(state, null, 2));

if (args.includes('--apply')) {
  if (!state.updateAvailable) {
    console.log('[update] already up to date');
  } else {
    const result = await service.apply();
    console.log(JSON.stringify(result.apply, null, 2));
    if (result.apply.error) process.exitCode = 1;
  }
}
