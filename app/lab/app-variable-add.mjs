export default async ({ page, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 1400 })
  const [key, value, note] = [process.env.V_KEY, process.env.V_VALUE, process.env.V_NOTE]
  await page.goto(`${base}/apps/${process.env.V_APP}?tab=variables`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3500)
  await page.click('button:has-text("+ Add a variable")')
  await page.waitForTimeout(600)
  await page.fill('input[aria-label="Variable name"]', key)
  await page.fill('input[aria-label="Value"]', value)
  if (note) await page.fill('input[aria-label="Note"]', note)
  await page.waitForTimeout(400)
  const submit = page.locator('button[type="submit"]:has-text("Add")')
  if (await submit.isDisabled()) {
    log(`${key}: REFUSED`)
    return
  }
  await submit.click()
  await page.waitForTimeout(2200)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  log(
    `${key}: ${(await page.evaluate(() => document.querySelector('main')?.innerText ?? '')).includes(key) ? 'present' : 'MISSING'}`,
  )
}
