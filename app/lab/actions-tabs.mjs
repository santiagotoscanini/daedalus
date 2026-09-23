export default async ({ page, snap, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 1700 })
  const errs = []
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => errs.push(`pageerror ${String(e).slice(0, 200)}`))
  for (const tab of ['runs', 'workflows', 'minutes', 'runners']) {
    const t0 = Date.now()
    await page.goto(`${base}/c/actions?tab=${tab}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(tab === 'runs' ? 15000 : 8000)
    const rail = await page.evaluate(() =>
      [...document.querySelectorAll('aside nav a')]
        .map((a) => a.textContent.trim())
        .filter(Boolean)
        .join(' | '),
    )
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('main nav a')]
        .map((a) => a.textContent.trim())
        .filter(Boolean)
        .join(' | '),
    )
    const heads = await page.evaluate(() =>
      [...document.querySelectorAll('main h3')].map((h) => h.textContent.trim()).join(' | '),
    )
    const text = await page.evaluate(
      () => document.querySelector('main')?.innerText?.slice(0, 1800) ?? '',
    )
    log(
      `${tab}: ${Date.now() - t0}ms rail=[${rail}] tabs=[${tabs}]\nboards=[${heads}]\n${text}\n----`,
    )
    await snap(tab)
  }
  log(`console errors: ${errs.length} ${JSON.stringify(errs.slice(0, 5))}`)
}
