// Remove exactly one secret, by name. The page shows each key TWICE: once in
// the merged environment (read-only, reveal only) and once in the operator's
// secrets file, which is the half with Replace/Remove. So take the LAST
// occurrence of the label and walk up to the row that holds exactly one
// Remove button. Anything ambiguous refuses rather than guesses — a loose
// walk-up once removed the wrong secret.
export default async ({ page, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 1600 })
  const key = process.env.V_KEY
  if (!key) throw new Error('no key')

  await page.goto(`${base}/apps/voyra?tab=secrets`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(5000)

  const press = (want) =>
    page.evaluate(
      ([k, label]) => {
        const root = document.querySelector('main')
        if (!root) return 'no main'
        const labels = [...root.querySelectorAll('*')].filter(
          (e) => e.children.length === 0 && (e.textContent ?? '').trim() === k,
        )
        if (labels.length === 0) return `no label for ${k}`
        let el = labels[labels.length - 1]
        for (let i = 0; i < 8 && el; i++) {
          const btns = [...el.querySelectorAll('button')].filter(
            (b) => (b.textContent ?? '').trim() === label,
          )
          if (btns.length === 1) {
            if (!(el.innerText ?? '').includes(k)) return `row lost ${k}`
            btns[0].click()
            return 'ok'
          }
          if (btns.length > 1) return `ambiguous: ${String(btns.length)} "${label}" buttons`
          el = el.parentElement
        }
        return `no "${label}" for ${k}`
      },
      [key, want],
    )

  const armed = await press('Remove')
  log(`arm ${key}: ${armed}`)
  if (armed !== 'ok') return
  await page.waitForTimeout(700)
  log(`confirm ${key}: ${await press('Confirm remove')}`)
  await page.waitForTimeout(4000)
}
