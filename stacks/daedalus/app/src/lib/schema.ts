// Drizzle schema. Empty on purpose — daedalus has no domain model yet, and an
// invented table would only have to be migrated away later.
//
// The wiring around it is real, so adding the first table is:
//   1. declare it here
//   2. podman exec app-daedalus pnpm db:generate   (writes drizzle/*.sql)
//   3. podman exec app-daedalus pnpm db:migrate    (applies it)
//
// Migrations are run by hand, NOT from the container entrypoint: a dev
// container restarts for all sorts of reasons, and none of them should be
// allowed to mutate a schema unattended.

export {}
