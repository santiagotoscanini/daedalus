# lab — driving this app in a real browser

The assertions a type checker cannot make: that a page renders, that a
control saves, that a tab switch is fast, that a flow a person performs
actually completes. They live here, beside the UI they assert on, because
a driver that outlives the markup it clicks is worse than no driver.

They are run by `shot`, the box's headless-Chromium CLI (its module is
`stacks/shotter` in the host's configuration), which takes any path:

```
shot run ~/projects/daedalus/app/lab/<driver>.mjs <label>
```

`shot` writes a run directory of viewport-sliced PNGs plus `events.json`.
**Read `events.json` before trusting the pictures** — a page screenshots
perfectly over a broken deploy.

A driver receives `{ page, snap, log }`. It reaches the app directly on the
container network, so it sets the forward-auth headers traefik would
normally add:

```js
await page.setExtraHTTPHeaders({
  'x-forwarded-email': '<the operator>',
  'x-forwarded-groups': '["admins"]',
})
```

Two rules learned the hard way:

- **Never target a row by walking up the DOM to an ancestor that mentions
  the key.** In these tables the label and its buttons are siblings, so the
  nearest common ancestor is the whole list, and the click lands on another
  row. One such driver removed the wrong secret. Target the LAST occurrence
  of the label and refuse if the row it finds holds more than one button of
  the kind you want — `secret-remove.mjs` shows the shape.
- **Values a driver types come in through the environment**, never as
  literals in the file, so a credential never reaches the repository or a
  session log.
