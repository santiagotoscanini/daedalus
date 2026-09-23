import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  boardMake,
  msiCode,
  msiKey,
  msiVersion,
  parseMsiNote,
  smbiosDate,
  zipTextEntry,
} from './board-releases'

// A zip's front, the way MSI's packages are laid out: a directory entry,
// then the note, then the image (cut off here — the reader never needs it).
function localHeader(name: string, method: 0 | 8, data: Buffer, uncompressed: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8')
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0)
  h.writeUInt16LE(20, 4)
  h.writeUInt16LE(0, 6)
  h.writeUInt16LE(method, 8)
  h.writeUInt32LE(0, 10)
  h.writeUInt32LE(0, 14)
  h.writeUInt32LE(data.length, 18)
  h.writeUInt32LE(uncompressed, 22)
  h.writeUInt16LE(nameBuf.length, 26)
  h.writeUInt16LE(0, 28)
  return Buffer.concat([h, nameBuf, data])
}

const NOTE = `﻿-------------------------------------------------------
PRO B760M-P DDR4 (MS-7E02) V1.H BIOS Release
-------------------------------------------------------

1. This is AMI BIOS release

2. This BIOS fixes the following problem of the previous version:
– Improved IOMMU setting

-  ME Firmware ver: ME_16.1.40.2765 (download)
   ME Firmware update SOP

3. 2026/06/09


[Below information is Traditional Chinese language]

A. AMI BIOS 正式發行
`

describe('the note inside an MSI package', () => {
  it('is read from the first entries, deflated', () => {
    const text = Buffer.from(NOTE, 'utf8')
    const zip = Buffer.concat([
      localHeader('7E02v1H/', 0, Buffer.alloc(0), 0),
      localHeader('7E02v1H/7E02v1x.txt', 8, deflateRawSync(text), text.length),
      localHeader('7E02v1H/E7E02IMS.1H0', 0, Buffer.alloc(100, 1), 33554432),
    ])
    expect(zipTextEntry(zip)?.startsWith('----')).toBe(true)
  })

  it('is read stored too, and refused when cut short', () => {
    const text = Buffer.from('hello', 'utf8')
    expect(zipTextEntry(localHeader('a/b.txt', 0, text, 5))).toBe('hello')
    expect(zipTextEntry(localHeader('a/b.txt', 0, text, 5).subarray(0, 32))).toBeNull()
    expect(zipTextEntry(Buffer.from('not a zip at all, sorry'))).toBeNull()
  })

  it('keeps the English fixes and the firmware line, and takes the note’s own date', () => {
    expect(parseMsiNote(NOTE)).toEqual({
      notes: ['Improved IOMMU setting', 'ME Firmware ver: ME_16.1.40.2765'],
      date: '2026-06-09',
    })
  })
})

describe('MSI’s two spellings of one version', () => {
  it('maps SMBIOS to the package key and back', () => {
    expect(msiKey('1.90')).toBe('19')
    expect(msiKey('1.H0')).toBe('1H')
    expect(msiKey('2.A')).toBe('2A')
    expect(msiKey('F42c')).toBeNull()
    expect(msiVersion('1H')).toBe('1.H0')
    expect(msiVersion('19')).toBe('1.90')
  })

  it('finds the board code in the product name', () => {
    expect(msiCode('PRO B760M-P DDR4 (MS-7E02)')).toBe('7E02')
    expect(msiCode('B650 AORUS ELITE AX')).toBeNull()
    expect(msiCode(null)).toBeNull()
  })

  it('names the maker from the SMBIOS vendor string', () => {
    expect(boardMake('Micro-Star International Co., Ltd.')).toBe('msi')
    expect(boardMake('Gigabyte Technology Co., Ltd.')).toBe('gigabyte')
    expect(boardMake('Apple')).toBe('apple')
    expect(boardMake('ASUSTeK COMPUTER INC.')).toBeNull()
  })
})

describe('SMBIOS dates', () => {
  it('reads the US order the firmware writes, and ISO as it is', () => {
    expect(smbiosDate('12/21/2023')).toBe('2023-12-21')
    expect(smbiosDate('03/24/2024')).toBe('2024-03-24')
    expect(smbiosDate('2025-03-11T10:22:33Z')).toBe('2025-03-11')
    expect(smbiosDate('yesterday')).toBeNull()
    expect(smbiosDate(null)).toBeNull()
  })
})
