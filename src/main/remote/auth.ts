import { randomInt } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'

let currentPin = ''

function makePin(): string {
  return String(randomInt(100000, 999999))
}

export function loadOrGeneratePin(savePath: string): string {
  try {
    const saved = readFileSync(savePath, 'utf-8').trim()
    if (/^\d{6}$/.test(saved)) {
      currentPin = saved
      return currentPin
    }
  } catch {}
  return regeneratePin(savePath)
}

export function regeneratePin(savePath: string): string {
  currentPin = makePin()
  try { writeFileSync(savePath, currentPin, 'utf-8') } catch {}
  return currentPin
}

export function validatePin(pin: string): boolean {
  return pin.length > 0 && pin === currentPin
}

export function getPin(): string {
  return currentPin
}
