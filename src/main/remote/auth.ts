import { randomInt } from 'crypto'

let currentPin = ''

export function generatePin(): string {
  currentPin = String(randomInt(100000, 999999))
  return currentPin
}

export function validatePin(pin: string): boolean {
  return pin.length > 0 && pin === currentPin
}

export function getPin(): string {
  return currentPin
}
