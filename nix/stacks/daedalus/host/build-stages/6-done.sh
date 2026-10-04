# host/build-stages/6-done.sh — stage 6 of the build (see host/build.sh).
#
# Start the app's deploy (a live build of a deployable app) and publish the
# terminal status. An app still waiting for its first image has no deploy
# unit yet: the Apply that sets it up starts its container (on the image just
# pushed), so nothing is started from here and nothing can race that Apply.
#
# ── 6. done ───────────────────────────────────────────────────────────────

if [ "$PUBLISH" = candidate ]; then
  finish succeeded "published as candidate-${SHA:0:7}; not deployed" "" '.candidate = true'
elif [ "$AWAITING" = yes ]; then
  finish succeeded "published $APP's first image; the Apply that sets it up starts it" ""
elif in_list "$APP" "$DEPLOYABLE"; then
  if systemctl start --no-block "app-$APP-deploy.service"; then
    finish succeeded "published; app-$APP-deploy started" ""
  else
    finish succeeded "published; app-$APP-deploy could not be started (journalctl -u 'daedalus-build@*')" ""
  fi
else
  finish succeeded "published; not deployed: $APP is pinned" "" '.pinned = true'
fi
say "build $BUILD_ID done: $IMAGE_REF@$DIGEST"
