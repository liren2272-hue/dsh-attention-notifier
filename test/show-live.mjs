// Fire a real card using the on-disk (just-fixed) notify.js, so the user can
// eyeball the topmost behaviour right now without waiting for a host restart.
import { ring } from '../notify.js'

const cfg = {
  popup: true,
  popupTimeoutMs: Number(process.argv[3] ?? 9000),
  sound: true,
  soundFile: 'C:\\Windows\\Media\\notify.wav',
  balloon: false,
  box: false,
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
}

const tone = process.argv[2] ?? 'ask'
const preset = {
  ask: ['需要你回答', '有个问题需要你决定：要不要继续？请切到别的窗口确认这张卡片是否置顶。'],
  alert: ['任务出错', '任务结束（error）：构建在第 3 步失败。请切到别的窗口确认这张卡片是否置顶。'],
  ok: ['任务完成', '任务结束（completed）：已生成报告，共 12 页。请切到别的窗口确认这张卡片是否置顶。'],
}[tone] ?? ['提示', '默认色调。']

ring(cfg, preset[0], preset[1], undefined, tone)
console.log(`card fired (tone=${tone}) — switch to another app now`)
