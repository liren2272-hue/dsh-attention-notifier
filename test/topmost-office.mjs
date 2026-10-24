// Empirical repro for "the card is not really topmost under Office".
// Fires a real production card that parks open (no timeout, no sound), then the
// caller raises Word in front of it and captures the screen. The card's accent
// strip colour is the witness: capture-once.ps1 searches for it bottom-right.
import { ring } from '../notify.js'

const tone = process.argv[2] ?? 'ask'
const cfg = {
  popup: true,
  popupTimeoutMs: 0, // parked: the card stays until the harness kills it
  sound: false,
  balloon: false,
  box: false,
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
}
const ok = ring(cfg, '置顶实验', '这张卡片应当压在 Word 上方可见。', undefined, tone)
console.log(`ring=${ok} tone=${tone}`)
