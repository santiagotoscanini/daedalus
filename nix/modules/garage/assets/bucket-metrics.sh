# shellcheck shell=bash
# Per-bucket usage as node-exporter textfile metrics.
#
# Garage exports no metric with a bucket label: object counts and bytes exist
# only in its admin API (ListBucketsInfo, read from counter tables, so cheap).
# This copies them into the textfile collector every few minutes, which gives
# the usage a history in prometheus — the control plane's page and any alert
# read it there, and nothing outside the box's own RPC loopback ever holds an
# admin credential for it.
#
# Parameters (set by the wrapper in garage.nix):
#   OUT   the .prom file to (atomically) replace

tmp="$OUT.$$"
trap 'rm -f "$tmp"' EXIT

buckets=$(podman exec garage /garage json-api ListBucketsInfo '{}')

{
  echo '# HELP garage_bucket_bytes Bytes stored in the bucket (before compression and deduplication).'
  echo '# TYPE garage_bucket_bytes gauge'
  echo '# HELP garage_bucket_objects Objects in the bucket.'
  echo '# TYPE garage_bucket_objects gauge'
  echo '# HELP garage_bucket_unfinished_uploads Uploads started and not yet completed or aborted.'
  echo '# TYPE garage_bucket_unfinished_uploads gauge'
  echo '# HELP garage_bucket_unfinished_upload_bytes Bytes held by unfinished multipart uploads.'
  echo '# TYPE garage_bucket_unfinished_upload_bytes gauge'
  echo '# HELP garage_bucket_quota_bytes The bucket'"'"'s size quota, when it has one.'
  echo '# TYPE garage_bucket_quota_bytes gauge'
  echo '# HELP garage_bucket_keys Access keys holding any permission on the bucket.'
  echo '# TYPE garage_bucket_keys gauge'
  # A bucket is labelled by its first global alias — the tenant's name — or its
  # id when it has none (a bucket made by hand with only a local alias).
  jq -r '
    .[] | (.globalAliases[0] // .id) as $b
    | "garage_bucket_bytes{bucket=\"\($b)\"} \(.bytes)",
      "garage_bucket_objects{bucket=\"\($b)\"} \(.objects)",
      "garage_bucket_unfinished_uploads{bucket=\"\($b)\"} \(.unfinishedUploads)",
      "garage_bucket_unfinished_upload_bytes{bucket=\"\($b)\"} \(.unfinishedMultipartUploadBytes)",
      "garage_bucket_keys{bucket=\"\($b)\"} \(.keys | length)",
      (if .quotas.maxSize != null then "garage_bucket_quota_bytes{bucket=\"\($b)\"} \(.quotas.maxSize)" else empty end)
  ' <<<"$buckets"
  echo '# HELP garage_bucket_metrics_timestamp_seconds When this file was last written.'
  echo '# TYPE garage_bucket_metrics_timestamp_seconds gauge'
  echo "garage_bucket_metrics_timestamp_seconds $(date +%s)"
} >"$tmp"

chmod 0644 "$tmp"
mv -f "$tmp" "$OUT"
trap - EXIT
