import { describe, expect, it } from 'vitest'
import { installLines, pairLines, psQuote, shQuote } from './install'

describe('the install lines', () => {
  const box = { address: 's2.example.org:7788', fingerprint: 'f3e5:a403:294c' }

  it('name the controller and pin its key on Windows and Linux', () => {
    const [windows, macos, linux] = installLines(box)
    expect(windows?.command).toBe(
      "Set-ExecutionPolicy -Scope Process Bypass -Force; & ([scriptblock]::Create((irm https://daedalus.toscanini.me/install.ps1))) -Controller 's2.example.org:7788' -Pin 'f3e5:a403:294c'",
    )
    expect(linux?.command).toBe(
      "curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh -s -- --controller 's2.example.org:7788' --pin 'f3e5:a403:294c'",
    )
    expect(macos?.command).toBe('curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh')
    expect(installLines(box).map((l) => l.os)).toEqual(['windows', 'macos', 'linux'])
  })

  it('give a Mac neither the controller nor a pin: install.sh refuses them there', () => {
    const macos = installLines(box).find((l) => l.os === 'macos')
    expect(macos?.command).not.toContain('--pin')
    expect(macos?.command).not.toContain('--controller')
  })

  it('are none when the controller is not known: the agent installs only pinned', () => {
    expect(installLines(null)).toEqual([])
  })

  it('quote what they carry, so nothing in it runs', () => {
    expect(shQuote("a'b")).toBe(`'a'\\''b'`)
    expect(shQuote('$(reboot)')).toBe("'$(reboot)'")
    expect(psQuote("a'b")).toBe("'a''b'")
    expect(psQuote('$(Stop-Computer)')).toBe("'$(Stop-Computer)'")
    const evil = installLines({ address: "x'; rm -rf / #", fingerprint: '`whoami`' })
    expect(evil[2]?.command).toContain(`--controller 'x'\\''; rm -rf / #' --pin '\`whoami\`'`)
    expect(evil[0]?.command).toContain(`-Controller 'x''; rm -rf / #' -Pin '\`whoami\`'`)
  })

  it('pair a Windows or Linux machine installed without a key, as an administrator', () => {
    const lines = pairLines(box)
    expect(lines.map((l) => l.os)).toEqual(['windows', 'linux'])
    const [windows, linux] = lines
    expect(windows?.command).toBe(
      `& "$env:ProgramFiles\\daedalus-agent\\daedalus-agent.exe" pair --pin 'f3e5:a403:294c' --controller 's2.example.org:7788'`,
    )
    expect(linux?.command).toBe(
      "sudo daedalus-agent pair --pin 'f3e5:a403:294c' --controller 's2.example.org:7788'",
    )
    expect(pairLines(null)).toEqual([])
    const evil = pairLines({ address: "x'; rm -rf / #", fingerprint: '$(whoami)' })
    expect(evil[1]?.command).toBe(
      `sudo daedalus-agent pair --pin '$(whoami)' --controller 'x'\\''; rm -rf / #'`,
    )
    expect(evil[0]?.command).toContain(`--pin '$(whoami)' --controller 'x''; rm -rf / #'`)
  })
})
