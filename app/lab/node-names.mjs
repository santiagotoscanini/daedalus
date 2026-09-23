export default async ({ page, snap, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 2400 })
  const errs = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('WebSocket') && !m.text().includes('[vite]'))
      errs.push(m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => {
    if (!String(e).includes('WebSocket')) errs.push(`pageerror ${String(e).slice(0, 200)}`)
  })
  await page.goto(`${base}/settings?tab=machines`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  const want = {
    'santi-pc': { name: 'gaming-pc', offer: true },
    'santiagos-macbook-pro-2': { name: 'macbook-pro', offer: false },
  }
  const fields = page.getByLabel('Name on the network')
  const n = await fields.count()
  for (let i = 0; i < n; i++) {
    const f = fields.nth(i)
    const ph = await f.getAttribute('placeholder')
    const w = want[ph]
    if (!w) {
      log(`field ${i}: placeholder ${ph} unknown`)
      continue
    }
    if ((await f.inputValue()) !== w.name) {
      await f.fill(w.name)
      await f.press('Enter')
      await page.waitForTimeout(1500)
    }
    const sw = page.getByLabel('Offer Lemonade to the gateway').nth(i)
    const on = (await sw.getAttribute('data-state')) === 'checked'
    if (on !== w.offer) {
      await sw.click()
      await page.waitForTimeout(1500)
    }
    log(
      `${ph}: name=${await fields.nth(i).inputValue()} offer=${await page.getByLabel('Offer Lemonade to the gateway').nth(i).getAttribute('data-state')}`,
    )
  }
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  const text = await page.evaluate(() => document.querySelector('main')?.innerText ?? '')
  log(
    `after reload: gaming-pc.lan=${text.includes('gaming-pc.lan')} macbook-pro.lan=${text.includes('macbook-pro.lan')} household=${text.includes('household')} offered=${(text.match(/offered to the gateway/g) || []).length}`,
  )
  await snap('machines-names')
  await page.goto(`${base}/apps`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  const apps = await page.evaluate(() => document.querySelector('main')?.innerText ?? '')
  const i = apps.search(/nodes|joined|offers/)
  log(
    `apps page: ${i >= 0 ? apps.slice(Math.max(0, i - 160), i + 200).replace(/\n/g, ' | ') : 'no nodes mention'}`,
  )
  await snap('apps-pending')
  log(`errors: ${errs.length} ${JSON.stringify(errs.slice(0, 4))}`)
}
