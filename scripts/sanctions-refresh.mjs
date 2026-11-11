#!/usr/bin/env node
/**
 * `pnpm sanctions:refresh`: the refresh itself lives in the api package
 * (apps/api/bin/sanctions-refresh.mjs) so the production api image carries it.
 * Same arguments, same exit codes.
 */
await import('../apps/api/bin/sanctions-refresh.mjs');
