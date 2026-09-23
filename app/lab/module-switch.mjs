export default async ({ page, snap, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 1400 })
  const errs = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|vite/.test(m.text())) errs.push(m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => {
    if (!/WebSocket/.test(String(e))) errs.push(`pageerror ${String(e).slice(0, 200)}`)
  })
  const mode = process.env.MODE ?? 'look'
  await page.goto(`${base}/settings?tab=modules`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('main li')]
      .map((li) => li.innerText.replace(/\s+/g, ' ').trim())
      .filter((t) => /n8n|always on|metube|traefik/.test(t))
      .slice(0, 8),
  )
  log(`modules tab rows: ${JSON.stringify(rows)}`)
  await snap('settings-modules')
  if (mode === 'off') {
    const sw = page.locator('main [role="switch"][aria-label="n8n on"]')
    log(`n8n switch checked before: ${await sw.getAttribute('aria-checked')}`)
    await sw.click()
    await page.waitForTimeout(2500)
    log(`n8n switch checked after: ${await sw.getAttribute('aria-checked')}`)
    const row = await page.evaluate(() =>
      [...document.querySelectorAll('main li')]
        .map((li) => li.innerText.replace(/\s+/g, ' ').trim())
        .find((t) => /^n8n/.test(t)),
    )
    log(`n8n row: ${row}`)
    await snap('settings-modules-off')
    await page.goto(`${base}/apps`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)
    const bar = await page.evaluate(() =>
      document
        .querySelector('main')
        ?.innerText.split('\n')
        .filter((l) => /changed|Apply|n8n/.test(l))
        .slice(0, 6)
        .join(' | '),
    )
    log(`apps bar: ${bar}`)
    await snap('apps-bar')
  }
  if (mode === 'foot') {
    await page.goto(`${base}/c/gaming?tab=factorio`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(6000)
    const foot = await page.evaluate(
      () =>
        document.querySelector('main')?.innerText.split('This service')[1]?.slice(0, 500) ??
        'no footer',
    )
    log(`gaming factorio footer: ${foot}`)
    await snap('gaming-foot')
  }
  log(`console errors: ${errs.length} ${JSON.stringify(errs.slice(0, 3))}`)
}
