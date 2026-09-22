// The browser half of scripts/image-walk.sh: a `shot` driver over the image
// it started.
//
// Forward-auth headers are the only identity the app has (core/auth.ts), so
// this is the one way to reach a write path without a proxy in front: the
// headers are set on every request the browser makes, exactly as traefik
// would set them after Pocket ID. The write chosen is Settings › Developer ›
// Authorization's switch — a database row behind `assertAdmin`, armed and
// confirmed like the operator would, then turned off again — because it is
// the one mutation whose whole effect is inside the throwaway database. The
// others reach a host bridge the image does not mount.
//
// This file asserts what is ON the page. Everything the page did on the wire
// (console errors, page errors, failed requests, status codes) lands in the
// run's events.json, and the shell script judges that; a driver is not the
// place to re-implement the recording it runs inside.
//
// Drivers import nothing: the runner mounts this file alone.

// Each page, and where it lands: `/` redirects to Apps (routes/index.tsx).
const PAGES = [
  { name: 'home', path: '/', lands: '/apps' },
  { name: 'apps', path: '/apps' },
  { name: 'settings', path: '/settings' },
  { name: 'system', path: '/c/system' },
  { name: 'new-app', path: '/apps/new' },
]

export default async ({ page, snap, log, args }) => {
  const base = (args[0] ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
  const failures = []
  const check = (label, ok, detail = '') => {
    if (!ok) failures.push(detail ? `${label} — ${detail}` : label)
    log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
  }

  // What traefik's forward-auth sets; the groups header is a JSON array
  // (core/auth.ts describeGroups).
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': 'walker@example.test',
    'x-forwarded-user': 'walker',
    'x-forwarded-groups': JSON.stringify(['admins']),
  })
  await page.setViewportSize({ width: 1440, height: 1100 })

  for (const { name, path, lands = path } of PAGES) {
    const response = await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    check(`${name}: ${path} answers 200`, response?.status() === 200, `got ${response?.status()}`)
    check(`${name}: lands on ${lands}`, new URL(page.url()).pathname === lands, page.url())
    const text = await page.evaluate(() => document.querySelector('main')?.textContent ?? '')
    check(`${name}: renders a main region`, text.trim().length > 0)
    await snap(name)
  }

  // The identity given at `podman run`, in the page rather than a build's:
  // the new-app wizard (the page the loop ended on) names the GitHub owner a
  // repository must be under.
  const wizard = await page.evaluate(() => document.body.textContent ?? '')
  check(
    'new-app: shows the GITHUB_OWNER the container was given',
    wizard.includes('github.com/example-owner'),
  )
  check('new-app: no build canary survived', !wizard.includes('build-canary'))

  // The authenticated write. The panel renders the decision for THIS request,
  // so the headers above must read back as a list carrying `admins` before
  // the switch is even enabled. The panel's rows are read as laid out
  // (innerText keeps the line breaks between a key and its value).
  await page.goto(`${base}/settings?tab=developer`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const panel = () => page.locator('[data-slot="card"]', { hasText: 'Authorization' }).first()
  const rows = async () => (await panel().innerText()).replace(/\s+/g, ' ')
  await panel().scrollIntoViewIfNeeded()
  const before = await rows()
  check(
    'authorization: the groups header arrived as a list',
    /Groups header list admins/.test(before),
    before,
  )
  check('authorization: this request is an admin', /Admin yes/.test(before), before)
  check('authorization: enforcement starts off', /Enforcement reporting only/.test(before), before)
  await snap('authorization-rest')

  await panel().getByRole('button', { name: 'Turn enforcement on…' }).click()
  await page.waitForTimeout(300)
  await snap('authorization-armed')
  await panel().getByRole('button', { name: 'Confirm: refuse non-admins' }).click()
  await panel().getByText('Enforcement is on.').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(500)
  check('authorization: the switch turned on', /Enforcement refusing/.test(await rows()))
  await snap('authorization-on')

  // And back, so the run leaves the switch where it found it — and to prove
  // the row can be read again after the write, not only written.
  await page.reload({ waitUntil: 'networkidle' })
  check('authorization: the write survived a reload', /Enforcement refusing/.test(await rows()))
  await panel().getByRole('button', { name: 'Turn enforcement off' }).click()
  await panel().getByText('Enforcement is off').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(500)
  check(
    'authorization: the switch turned off again',
    /Enforcement reporting only/.test(await rows()),
  )
  await snap('authorization-off')

  if (failures.length > 0) {
    throw new Error(
      `image walk: ${failures.length} assertion(s) failed at ${base}\n${failures.map((f) => `  - ${f}`).join('\n')}`,
    )
  }
  log(`all assertions passed at ${base}`)
}
