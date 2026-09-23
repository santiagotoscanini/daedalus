export default async ({ page, snap, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 1200 })
  const errs = []
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text().slice(0, 160))
  })
  page.on('pageerror', (e) => errs.push(`pageerror ${String(e).slice(0, 160)}`))

  const rows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('main code')]
        .map((c) => c.textContent.trim())
        .filter((t) => /^[A-Z][A-Z0-9_]*$/.test(t)),
    )

  // 1. read path
  await page.goto(`${base}/apps/argus?tab=variables`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)
  log(
    `tabs: ${await page.evaluate(() =>
      [...document.querySelectorAll('aside a')]
        .map((a) => a.textContent.trim())
        .filter(Boolean)
        .join(' | '),
    )}`,
  )
  log(`read: ${JSON.stringify(await rows())}`)
  log(
    `notes shown: ${await page.evaluate(() => document.querySelector('main')?.innerText?.includes('Maintenance brake') ?? false)}`,
  )
  await snap('01-read')

  // 2. add
  await page.click('button:has-text("+ Add a variable")')
  await page.fill('input[aria-label="Variable name"]', 'LAB_PROBE_TEMP')
  await page.fill('input[aria-label="Value"]', 'hello')
  await page.fill('input[aria-label="Note"]', 'added by the lab, removed again')
  await page.click('button:has-text("Add")')
  await page.waitForTimeout(3500)
  log(`after add: ${JSON.stringify(await rows())}`)
  await snap('02-added')

  // 3. does the Apps bar show it pending?
  await page.goto(`${base}/apps`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3500)
  const bar = await page.evaluate(() => {
    const t = document.body.innerText
    const i = t.indexOf('Apply')
    return i < 0 ? 'NO APPLY BAR' : t.slice(Math.max(0, i - 260), i + 40).replace(/\n+/g, ' / ')
  })
  log(`bar: ${bar}`)
  await snap('03-bar')

  // 4. refusals
  await page.goto(`${base}/apps/argus?tab=variables`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  await page.click('button:has-text("+ Add a variable")')
  for (const [name, what] of [
    ['DATABASE_URL', 'platform'],
    ['ITEM_ID_PEPPER', 'secret'],
    ['lower', 'convention'],
  ]) {
    await page.fill('input[aria-label="Variable name"]', name)
    await page.waitForTimeout(400)
    const msg = await page.evaluate(
      () => document.querySelector('main .text-danger')?.textContent?.trim() ?? 'NONE',
    )
    log(`refusal ${what} (${name}): ${msg}`)
  }
  await snap('04-refusals')

  // 5. remove the temp one
  await page.goto(`${base}/apps/argus?tab=variables`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  const row = page
    .locator('main div')
    .filter({ hasText: /^LAB_PROBE_TEMP/ })
    .first()
  await row.locator('button:has-text("Remove")').first().click()
  await page.waitForTimeout(500)
  await page.click('button:has-text("Confirm remove")')
  await page.waitForTimeout(3500)
  log(`after remove: ${JSON.stringify(await rows())}`)
  await snap('05-restored')

  log(`console errors: ${errs.length} ${JSON.stringify(errs.slice(0, 3))}`)
}
