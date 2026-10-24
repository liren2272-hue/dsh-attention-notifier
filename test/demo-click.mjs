// Demo for click-to-focus: fire a card with a long lifetime, then watch which
// window is in the foreground so "did clicking bring the harness back?" is
// answered by measurement instead of by memory.
import { ring } from '../notify.js'

const cfg = {
  popup: true,
  popupTimeoutMs: 30_000,
  sound: true,
  soundFile: 'C:\\Windows\\Media\\notify.wav',
  balloon: false,
  box: false,
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  focusProcess: 'DeepSeek Harness',
}

ring(cfg, '点击演示', '请点击这张卡片，看 DSH 窗口是否被拉回前台。30 秒内有效。', undefined, 'ask')
console.log('DEMO CARD UP — click it, then watch this window')
