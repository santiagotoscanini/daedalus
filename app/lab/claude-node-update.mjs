export default async ({ page, snap, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 1900 })
  const errs = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|vite\]|frame-ancestors/.test(m.text()))
      errs.push(m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => {
    if (!/WebSocket/.test(String(e))) errs.push(`pageerror ${String(e).slice(0, 200)}`)
  })
  for (const [name, id] of [
    ['mac', process.env.LAB_MAC ?? ''],
    ['pc', process.env.LAB_PC ?? ''],
  ]) {
    await page.goto(`${base}/c/system?tab=claude&machine=${id}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(9000)
    const buttons = await page.$$eval('main button', (bs) =>
      bs.map((b) => b.textContent.trim()).filter((t) => t && t.length < 60),
    )
    const text = await page.evaluate(
      () => document.querySelector('main')?.innerText?.slice(0, 1600) ?? '',
    )
    log(`${name}: buttons=${JSON.stringify(buttons)}\n${text}\n----`)
    await snap(name)
  }
  log(`console errors: ${errs.length} ${JSON.stringify(errs.slice(0, 4))}`)
}
