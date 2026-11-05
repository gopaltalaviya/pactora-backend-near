import {defineConfig} from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {url: process.env.DATABASE_URL ?? 'postgres://pactora:pactora@127.0.0.1:5443/pactora_near'},
  // Generated DDL is reviewed, never auto-pushed. A migration that nobody
  // read is how a production column quietly changes type.
  strict: true,
  verbose: true,
});
