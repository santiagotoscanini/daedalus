export default async ({ page, snap, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 1900 })
  const id = process.env.LAB_NODE ?? ''
  await page.goto(`${base}/c/system?tab=claude&machine=${id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(9000)

  // The LAST occurrence, and refuse if the label is ambiguous — the lab
  // README's rule, learned by removing the wrong secret once.
  const hits = await page.$$('main button')
  const wanted = []
  for (const b of hits) {
    const t = (await b.textContent())?.trim() ?? ''
    if (t === 'Update Claude Code') wanted.push(b)
  }
  log(`found ${wanted.length} "Update Claude Code" buttons`)
  if (wanted.length !== 1) throw new Error(`expected exactly one, found ${wanted.length}`)

  await wanted[wanted.length - 1].click()
  await page.waitForTimeout(4000)
  const after = await page.$$eval('main button', (bs) =>
    bs.map((b) => b.textContent.trim()).filter((t) => /Update|Restart/.test(t)),
  )
  log(`after the click: ${JSON.stringify(after)}`)
  await snap('queued')
  if (!after.includes('Update queued')) throw new Error('the button did not flip to queued')
}
