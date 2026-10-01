import { defineConfig } from 'drizzle-kit'

// `db:generate` diffs src/host/schema.ts against drizzle/ and connects to
// nothing, but this file is read first, so it still wants a DATABASE_URL — any
// postgres URL will do (`DATABASE_URL=postgres://x@x/x pnpm db:generate`).
// `db:migrate` and `db:studio` do connect: run them where the app's own
// DATABASE_URL is (modules/app-db's bootstrap writes it). The app applies
// new migrations itself at start (migrate.mjs), so a deploy needs neither.
// There is no .env to load.
const url = process.env.DATABASE_URL
if (url === undefined) {
  throw new Error(
    'DATABASE_URL is not set: any postgres URL for db:generate, the app’s own for db:migrate',
  )
}

export default defineConfig({
  schema: './src/host/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
})
