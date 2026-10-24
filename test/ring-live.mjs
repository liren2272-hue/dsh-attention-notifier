// Spawn one real notification through the production ring() and report what
// actually happens. Used to separate "the plugin never fired" from "the ring
// fired but nothing reached the screen".
import { ring } from '../notify.js'

const cfg = {
  sound: true,
  popup: true,
  popupTimeoutMs: 25000,
  soundFile: 'C:\\Windows\\Media\\notify.wav',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  title: '投递验证',
}

const ok = await ring(cfg, '投递验证', '看到这行字 + 听到声音 = 通道正常')
console.log('ring returned', ok)
