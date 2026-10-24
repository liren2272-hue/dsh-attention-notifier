/**
 * End-to-end delivery probe: runs the real `ring()` against the real PowerShell
 * so the sound and tray balloon are exercised outside the fake harness.
 */
import { ring } from '../notify.js'

const logger = { info: console.log, warn: console.warn }
const started = Date.now()
const ok = ring(
  {
    sound: true,
    balloon: true,
    soundFile: 'C:\\Windows\\Media\\notify.wav',
    powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  },
  'DeepSeek Harness',
  '任务结束（completed）：通知链路已打通，声音与托盘气泡同时可用。',
  logger,
)
console.log(`ring returned ${ok} after ${Date.now() - started}ms`)
