export default async ({ page, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 1400 })
  for (const [name, id] of (process.env.LAB_NODES ?? '')
    .split(',')
    .filter(Boolean)
    .map((p) => p.split('='))) {
    await page.goto(`${base}/c/system?tab=host&machine=${id}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(6000)
    const board = await page.evaluate(() => {
      const hs = [...document.querySelectorAll('main h3')].map((x) => x.textContent.trim())
      const h = [...document.querySelectorAll('main h3')].find((x) =>
        x.textContent.trim().endsWith('Providers'),
      )
      if (!h) return `NO BOARD: ${hs.join(' | ')}`
      return h ? h.closest('section')?.innerText.replace(/\s+/g, ' ').slice(0, 300) : 'NO BOARD'
    })
    log(`${name}: ${board}`)
  }
}
