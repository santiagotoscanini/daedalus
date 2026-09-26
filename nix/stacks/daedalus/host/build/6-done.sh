# host/build/6-done.sh — stage 6 of the build (see host/build.sh).
#
# Start the app's deploy (a live build of a deployable app) and publish the
# terminal status.
#
# ── 6. done ───────────────────────────────────────────────────────────────

if [ "$PUBLISH" = candidate ]; then
  finish succeeded "published as candidate-${SHA:0:7}; not deployed" "" '.candidate = true'
elif in_list "$APP" "$DEPLOYABLE"; then
  if systemctl start --no-block "app-$APP-deploy.service"; then
    finish succeeded "published; app-$APP-deploy started" ""
  else
    finish succeeded "published; app-$APP-deploy could not be started (journalctl -u daedalus-build)" ""
  fi
else
  finish succeeded "published; not deployed: $APP is pinned" "" '.pinned = true'
fi
say "build $BUILD_ID done: $IMAGE_REF@$DIGEST"
