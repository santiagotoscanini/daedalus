# `garage` — one shared S3 object store, one bucket per app

One container (`garage`, [Garage](https://garagehq.deuxfleurs.fr) v2) holds
every app's files. Isolation is per **bucket + access key**: each tenant gets
a bucket named after it and a key that can read, write and own that bucket and
nothing else. There are no bucket policies or ACLs in Garage — the key is the
boundary. Mechanism and the reasons behind each setting: the header of
`garage.nix`, `assets/garage.toml`, and each script under `assets/`.

Paths below use the options they come from: `<stateRoot>` is
`fleet.stateRoot`, `<machineState>` is `fleet.machineState`, `<baseDomain>` is
`fleet.baseDomain`.

## Give an app a bucket

An app on the apps platform turns on **Object storage** on its page (registry
field `objectStorage`, nix `fleet.apps.<name>.objectStorage.enable`). The apps
stack forwards that to `fleet.appBuckets.<name> = { }`; a stack of its own
writes the entry directly and names its containers in `consumers`. This module
owns everything from there.

`garage-<name>-bootstrap.service` runs before each consumer and makes the
bucket (global alias `<name>`), the access key (`app-<name>`, id `GK…`), the
grant, and the env file `<machineState>/garage/<name>/env` (0600):

```
S3_ENDPOINT=http://garage:3900      # http://host.containers.internal:3900 in a VPN netns
S3_REGION=garage
S3_BUCKET=<name>
S3_ACCESS_KEY_ID=GK…
S3_SECRET_ACCESS_KEY=…
AWS_ENDPOINT_URL_S3=…               # the same values under the AWS SDK's names,
AWS_REGION=garage                   # so an SDK client needs no configuration
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
AWS_REQUEST_CHECKSUM_CALCULATION=when_required
AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
```

The env file is the source of truth for the key, as app-db's is for a
password: the box mints the pair and Garage only imports it. **Rotate** by
deleting the file, rebuilding and restarting the app; the bootstrap mints a
new key (a new id: Garage never reuses a deleted one) and deletes the old.

Names: 3–63 characters of `[a-z0-9-]`, no leading or trailing hyphen
(asserted). `cluster` and `console` are reserved — they hold the store's own
secrets under the machine state.

## How the app talks to it

Through ONE module, the same in every app: [`client/object-store.ts`](client/object-store.ts),
copied **verbatim** to the app's `src/server/object-store.ts` with its test
beside it. Never edit an app's copy: change this one and copy it into every
app, so each app reads like the others and a fix lands everywhere.
Dependencies: `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`,
`@smithy/node-http-handler`.

```ts
import { objectResponse, objectStoreFromEnv, memoryObjectStore } from './object-store'

// The bucket in production; null when S3_* is absent (dev, tests) — a partial
// set throws, naming the missing variables.
const store = objectStoreFromEnv(process.env) ?? memoryObjectStore()

await store.put('avatars/42.webp', bytes, 'image/webp')
const obj = await store.open('avatars/42.webp', request.headers.get('range'))
return obj ? objectResponse(obj, { 'Cache-Control': 'private, max-age=3600' }) : notFound()
```

`ObjectStore` is put / putFile (multipart past 16 MiB) / read / readToFile /
open (one range, streamed) / head / list (paginated) / copy (onto itself:
refresh the last-modified time) / remove (batched). What an app keeps — content
-addressed blobs, a profile archive, screenshots by id — is a store of its own
built on top of it. The client inside is configured for this box: path-style,
region from the env, checksums only when required, keep-alive, a 1 s connect
timeout with four attempts (the VPN-netns path stalls a new connection's SYN a
fifth to a half of the time; a fresh attempt cures it).

What Garage does differently from AWS, all verified in its source at v2.5:

- **Path-style only.** Every published host is one label under
  `<baseDomain>`, so `<bucket>.s3.<baseDomain>` cannot exist.
- **Always send `ContentType`.** Garage stores none by default and returns none.
- **Conditional PUT is ignored.** `If-None-Match: *` and `If-Match` on a PUT
  are dropped and the object is overwritten. Create-if-absent and optimistic
  locking belong in the app's database.
- **No versioning, object lock, tagging, ACLs or policies.** A delete is final.
- **One range per GET.** A multi-range request gets the whole object, and the
  `response-content-*` overrides apply to full (200) responses only.
- **Bucket settings are the platform's.** The app's key reads and writes
  objects and owns nothing: the bootstrap sets the bucket's one lifecycle rule
  (a multipart upload left unfinished for a day is aborted; Garage runs rules
  daily), and an app sets no rules, CORS or website of its own.
- **Keys** carry no leading `/` and stay short (under a few hundred bytes).

**Serve files through the app.** Buckets are private and the store has no
public endpoint for tenants. A browser gets an object from one of the app's
own routes, which already carry its auth and its stable URLs (`objectResponse`
streams it, with `Range`, `ETag` and `Content-Type`). No presigned URLs: they
would point at the bridge or the LAN-only route. An upload goes browser → app
→ bucket. Through the Cloudflare tunnel a request body is capped at 100 MB, so
a bigger file has to arrive in chunks.

Scratch space (an upload being assembled, a file a renderer needs on disk) is
the container's own filesystem, which a redeploy discards. Records stay in
Postgres.

## The operator's door

The S3 API is published on the LAN at `s3.<baseDomain>` (path-style, region
`garage`), for the operator's own tools. Use a key of your own, created in the
console, never an app's. For example with rclone:

```ini
[box]
type = s3
provider = Other
endpoint = https://s3.<baseDomain>
region = garage
force_path_style = true
list_version = 2
no_check_bucket = true
```

With `console.enable`, garage-ui serves at `garage.<baseDomain>`: its own OIDC
client, open to `console.authGroups` only. Everyone admitted is a full admin
and can read every key's secret: its object browser borrows a bucket's
existing key (`console.nix` says why). Deleting an app's key there breaks that
app's next bootstrap until its env file is deleted, which mints a new one.

## Backups and recovery

Metadata (SQLite) and blocks live under `<stateRoot>/garage/{meta,data}`, in
the same dataset, so one filesystem snapshot holds both from the same instant.
Restore the two from the SAME snapshot: older metadata over newer blocks loses
objects whose blocks were already collected, and the reverse orphans blocks.
Garage also keeps its own compacted copy of the metadata database every 6 h
(`meta/snapshots/<time>/db.sqlite`, the two newest). To restore from it: stop
the container, move `meta/db.sqlite` aside, delete `meta/db.sqlite-wal` and
`meta/db.sqlite-shm`, copy the snapshot's `db.sqlite` into `meta/`, start, then
`podman exec garage /garage repair -a --yes tables`.

Upgrades: a newer Garage refuses to be downgraded once it has opened the
store, so read each release's notes first (the Data › Object storage tab and
System › Updates show them, from Garage's own forge).

## Inspecting it

```bash
podman exec garage /garage status
podman exec garage /garage bucket info <name>
podman exec garage /garage json-api GetClusterHealth
podman exec garage /garage block list-errors
```

Run them as the operator: the CLI dials the RPC port on the container's
loopback, and anyone holding the RPC secret can do everything with it.
