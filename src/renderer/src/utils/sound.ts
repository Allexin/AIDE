export interface SoundNote {
  freq: number   // Hz, e.g. 523 = C5
  dur: number    // note duration, ms
  delay: number  // offset from playback start, ms
}

export function playMelody(notes: SoundNote[]): void {
  if (notes.length === 0) return
  const ctx = new AudioContext()
  for (const note of notes) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.type = 'sine'
    osc.frequency.value = note.freq
    const start = ctx.currentTime + note.delay / 1000
    const end = start + note.dur / 1000
    gain.gain.setValueAtTime(0.3, start)
    gain.gain.exponentialRampToValueAtTime(0.001, end)
    osc.start(start)
    osc.stop(end)
  }
  const totalMs = Math.max(...notes.map((n) => n.delay + n.dur))
  setTimeout(() => ctx.close(), totalMs + 200)
}
