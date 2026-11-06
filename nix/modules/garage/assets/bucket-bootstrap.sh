# shellcheck shell=bash
# Per-tenant bucket bootstrap: one bucket, one access key that may read, write
# and own it, and the env file the tenant's container reads.
#
# Parameters (set by the wrapper in garage.nix):
#   BUCKET          the bucket's global alias (= the tenant's name)
#   KEY_NAME        the access key's name in Garage (app-<bucket>)
#   ENV_FILE        <machineState>/garage/<bucket>/env, the file we emit
#   ENDPOINT        the S3 endpoint the tenant dials (bridge or host port)
#   REGION          Garage's s3_region
#   OPERATOR_USER, OPERATOR_GROUP   owner of the env file
#
# Runs as the operator (rootless podman). Every admin call goes through
# `garage json-api` inside the container, over the RPC loopback: no admin token
# exists for this, and every JSON body travels on stdin, so the secret key is
# never in a process's argv.
#
# The env file is the source of truth for the key, exactly as app-db's env file
# is for a role's password: Garage only ever IMPORTS the pair this box minted.
# That is what makes a lost metadata database recoverable (the key is imported
# again from the file) and rotation one deletion: remove the env file, rebuild,
# restart the tenant. The new key gets a NEW id — Garage keeps a deleted key's
# id as a tombstone and refuses to import it again — and the old one is deleted
# below.

api() { podman exec -i garage /garage json-api "$1" -; }

install -d -m 0700 "$(dirname "$ENV_FILE")"

if [ -e "$ENV_FILE" ]; then
  KEY_ID=$(grep -m1 '^S3_ACCESS_KEY_ID=' "$ENV_FILE" | cut -d= -f2-)
  KEY_SECRET=$(grep -m1 '^S3_SECRET_ACCESS_KEY=' "$ENV_FILE" | cut -d= -f2-)
  [ -n "$KEY_ID" ] && [ -n "$KEY_SECRET" ] || {
    echo "$ENV_FILE has no S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY; delete it to mint a new key" >&2
    exit 1
  }
else
  # The shape Garage generates itself: GK + 24 hex, a 64-hex secret.
  KEY_ID="GK$(openssl rand -hex 12)"
  KEY_SECRET=$(openssl rand -hex 32)
fi

# Written FIRST, every run: the pair is the box's, and a run that dies after
# the import must find the same pair next time rather than mint an orphan.
# The non-secret lines are rewritten from the parameters, so a change of
# endpoint (an app moving into a VPN netns) reaches the file on the next run.
# The AWS_* names are the AWS SDK's own: an SDK client built with no
# configuration at all picks every one of them up, including the checksum
# mode Garage needs for presigned PUTs.
install -m 0600 -o "$OPERATOR_USER" -g "$OPERATOR_GROUP" /dev/stdin "$ENV_FILE" <<EOF
S3_ENDPOINT=$ENDPOINT
S3_REGION=$REGION
S3_BUCKET=$BUCKET
S3_ACCESS_KEY_ID=$KEY_ID
S3_SECRET_ACCESS_KEY=$KEY_SECRET
AWS_ENDPOINT_URL_S3=$ENDPOINT
AWS_REGION=$REGION
AWS_ACCESS_KEY_ID=$KEY_ID
AWS_SECRET_ACCESS_KEY=$KEY_SECRET
AWS_REQUEST_CHECKSUM_CALCULATION=when_required
AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
EOF

# The bucket, by its global alias (the name path-style requests resolve).
if ! info=$(jq -nc --arg a "$BUCKET" '{globalAlias: $a}' | api GetBucketInfo 2>/dev/null); then
  jq -nc --arg a "$BUCKET" '{globalAlias: $a}' | api CreateBucket >/dev/null
  info=$(jq -nc --arg a "$BUCKET" '{globalAlias: $a}' | api GetBucketInfo)
  echo "created bucket $BUCKET"
fi
BUCKET_ID=$(jq -er '.id' <<<"$info")

# The key. Imported when Garage does not know it — a first run, or a metadata
# database restored from before the key existed.
if ! jq -nc --arg id "$KEY_ID" '{id: $id}' | api GetKeyInfo >/dev/null 2>&1; then
  KEY_SECRET=$KEY_SECRET jq -nc --arg id "$KEY_ID" --arg n "$KEY_NAME" \
    '{accessKeyId: $id, secretAccessKey: env.KEY_SECRET, name: $n}' |
    api ImportKey >/dev/null || {
    echo "importing key $KEY_ID for $BUCKET failed; if Garage holds it as a deleted key, delete $ENV_FILE to mint a new one" >&2
    exit 1
  }
  echo "imported key $KEY_ID as $KEY_NAME"
fi

# read + write on the objects, and NOT owner: the bucket's own settings
# (lifecycle, CORS, website) are the platform's, below, so an app needs none of
# what owner grants — deleting the bucket included. Allow only sets flags and
# Deny only clears them, so both run every time and a key granted owner by hand
# (or by an older bootstrap) loses it.
jq -nc --arg b "$BUCKET_ID" --arg k "$KEY_ID" \
  '{bucketId: $b, accessKeyId: $k, permissions: {read: true, write: true, owner: false}}' |
  api AllowBucketKey >/dev/null
jq -nc --arg b "$BUCKET_ID" --arg k "$KEY_ID" \
  '{bucketId: $b, accessKeyId: $k, permissions: {read: false, write: false, owner: true}}' |
  api DenyBucketKey >/dev/null

# The bucket's lifecycle, converged to the platform's one rule: a multipart
# upload left unfinished (a process that died mid-upload) is aborted after a
# day, so its parts stop holding space. Garage runs the rules once a day.
# Replaced only when it differs, so the bucket's record does not churn.
want='[{"ID":"abort-incomplete-uploads","Status":"Enabled","AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]'
have=$(jq -c '[(.lifecycleRules // [])[] | {ID, Status, AbortIncompleteMultipartUpload}]' <<<"$info")
if [ "$have" != "$want" ]; then
  jq -nc --arg b "$BUCKET_ID" --argjson r "$want" '{id: $b, body: {lifecycleRules: $r}}' |
    api UpdateBucket >/dev/null
  echo "set the lifecycle rules of $BUCKET"
fi

# A rotation leaves the previous key behind: any OTHER key carrying this
# tenant's key name is the old one, and goes. Keys under any other name (the
# operator's own, the web console's) are left alone.
jq -r --arg k "$KEY_ID" --arg n "$KEY_NAME" \
  '.keys[] | select(.accessKeyId != $k and .name == $n) | .accessKeyId' <<<"$info" |
  while read -r old; do
    jq -nc --arg id "$old" '{id: $id}' | api DeleteKey >/dev/null
    echo "deleted superseded key $old"
  done
