export default async ({ page, snap, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 2200 })
  const errs = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|vite\]|frame-ancestors/.test(m.text()))
      errs.push(m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => {
    if (!/WebSocket/.test(String(e))) errs.push(`pageerror ${String(e).slice(0, 200)}`)
  })

  await page.goto(`${base}/c/system?tab=claude`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(9000)

  // The two verbs this page now owns, and the version compare they act on.
  const buttons = await page.$$eval('main button, main a[role="button"]', (bs) =>
    bs.map((b) => b.textContent.trim()).filter((t) => t.length > 0 && t.length < 90),
  )
  const compare = await page.evaluate(
    () => document.querySelector('main')?.innerText?.slice(0, 900) ?? '',
  )
  log(`buttons: ${JSON.stringify(buttons)}`)
  log(`head:\n${compare}\n----`)

  // The roster: every live row should now name the CLI it is running.
  const roster = await page.evaluate(() => {
    const board = [...document.querySelectorAll('main section, main div')].find((d) =>
      d.textContent?.includes('Session roster'),
    )
    return board?.innerText?.slice(0, 1800) ?? '(no roster board)'
  })
  log(`roster:\n${roster}\n----`)
  await snap('claude')
  log(`console errors: ${errs.length} ${JSON.stringify(errs.slice(0, 5))}`)
}
