/**
 * Fire a real stack of cards through the real ring(), so the retreat, the wash
 * and the z-order behaviour are exercised outside the fake harness.
 *
 * The harness tests prove the numbers (step, insets, wash, AssertTop) but they
 * cannot prove the cards actually LOOK stacked — that needs the real PowerShell
 * children painting at the same time. So this fires three cards in quick
 * succession and leaves them on screen for the user to look at.
 *
 * It uses ring() directly with an explicit stackIndex per card, which is exactly
 * what the host hands down (see index.js notify()).
 */
import { ring } from '../notify.js'

const cfg = {
  sound: false,
  popup: true,
  popupTimeoutMs: 30_000,
  popupMs: 9_000,
  balloon: false,
  box: false,
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  focusProcess: 'DeepSeek Harness',
}

// Bodies are deliberately long enough to wrap onto 2-3 lines, which is how the
// new right inset is judged: text that used to run to the edge should now stop
// with visible air before it.
const cards = [
  { index: 0, tone: 'ok', title: '任务完成', body: '**已完成**：本次构建生成了 12 页分析报告，已写入 `dist/report.pdf`，同时更新了索引与目录结构。' },
  { index: 1, tone: 'ask', title: '需要你选择', body: '运行 `pnpm build --force` 会**覆盖** dist 目录下的现有产物，其中包括上次构建保留的缓存文件，详见 [文档](https://example.com)。要继续吗？' },
  { index: 2, tone: 'alert', title: '任务出错', body: '- 第 3 步构建失败：依赖解析超时\n- 旧方案 ~~直接重试~~ 已废弃\n> 需要你确认是否回滚到上一个可用版本' },
]

for (const card of cards) {
  ring({ ...cfg, stackIndex: card.index }, card.title, card.body, undefined, card.tone)
  // A small gap so the children do not fight over Add-Type compilation; the real
  // host's minIntervalMs (4s) spaces them further apart, but for a visual check
  // 700ms is enough to get all three on screen together.
  await new Promise((resolve) => setTimeout(resolve, 700))
}

console.log('三张卡片已依次发出（正文均为长文本，用于检查换行与右侧留白）：')
console.log('  1. 最前（蓝/已完成）— 原位，完全体')
console.log('  2. 第二张（橙/待你决定）— 左上退一级，带暗幕')
console.log('  3. 第三张（红/出错）— 左上退两级，带暗幕')
console.log('它们会在 30 秒后各自消失。')
