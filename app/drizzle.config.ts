import { defineConfig } from 'drizzle-kit'

// drizzle-kit runs inside the container (`podman exec app-daedalus pnpm
// db:generate`), where DATABASE_URL is already in the environment from
// stacks/app-db's generated env file. There is no .env to load.
export default defineConfig({
  schema: './src/lib/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
