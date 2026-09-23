export default async ({ page, snap, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 1700 })
  const errs = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|vite\]/.test(m.text()))
      errs.push(m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => {
    if (!/WebSocket/.test(String(e))) errs.push(`pageerror ${String(e).slice(0, 200)}`)
  })
  const walk = [
    ['providers-default', '/c/ai?tab=providers'],
    ['providers-box', '/c/ai?tab=providers&machine=box'],
    ['providers-node', `/c/ai?tab=providers&machine=${process.env.LAB_NODE ?? ''}`],
    ['gateway', '/c/ai?tab=gateway'],
    ['consumers', '/c/ai?tab=consumers'],
    ['alias-lemonade', '/c/ai?tab=lemonade'],
  ]
  for (const [name, path] of walk) {
    const t0 = Date.now()
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(6000)
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('main nav a[aria-current="page"]')]
        .map((a) => a.textContent.trim())
        .join('|'),
    )
    const heads = await page.evaluate(() =>
      [...document.querySelectorAll('main h2, main h3')]
        .map((h) => h.textContent.trim())
        .join(' | '),
    )
    const text = await page.evaluate(
      () => document.querySelector('main')?.innerText?.slice(0, 1400) ?? '',
    )
    log(`${name}: ${Date.now() - t0}ms active=[${tabs}]\nboards=[${heads}]\n${text}\n----`)
    await snap(name)
  }
  log(`console errors: ${errs.length} ${JSON.stringify(errs.slice(0, 5))}`)
}
