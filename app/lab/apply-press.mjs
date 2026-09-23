export default async ({ page, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.goto(`${base}/apps`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)
  const bar = await page.evaluate(
    () => document.querySelector('main')?.innerText?.match(/.{0,120}Apply.{0,40}/)?.[0] ?? 'no bar',
  )
  log(`bar: ${bar.replace(/\s+/g, ' ')}`)
  const btn = page.locator('button:has-text("Apply")').first()
  if ((await btn.count()) === 0) {
    log('no Apply button')
    return
  }
  await btn.click()
  await page.waitForTimeout(3000)
  log(
    `after click: ${(await page.evaluate(() => document.querySelector('main')?.innerText?.slice(0, 300) ?? '')).replace(/\s+/g, ' ')}`,
  )
}
