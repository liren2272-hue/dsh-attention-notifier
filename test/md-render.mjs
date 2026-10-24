/**
 * Real-render check for the Markdown body: does the child actually paint it?
 *
 * The unit tests prove the host produces styled spans and that the painter walks
 * them; they cannot prove the PowerShell is syntactically valid or that GDI+ draws
 * what the walk asks for. So this builds the real script, runs it, and reports
 * whether it reached its end — the same end-to-end proof verify-delivery.mjs uses,
 * applied to a body with markup.
 *
 * A failure here is almost always PowerShell syntax (the walk is generated code,
 * and a single unbalanced brace silently kills the whole Paint handler under
 * SilentlyContinue, leaving a correctly-sized blank card).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { buildScript } from '../notify.js'

const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const dir = mkdtempSync(join(tmpdir(), 'attention-md-'))
const marker = join(dir, 'ran.txt')

const cases = [
  ['plain', '任务结束（completed）：已生成报告，共 12 页。'],
  ['bold', '**已完成**：报告共 12 页，导出路径见附件。'],
  ['code', '运行 `pnpm build` 后检查 dist 目录是否更新。'],
  ['mixed', '**注意**：`--force` 会覆盖现有文件，详见 [文档](https://example.com/docs)。'],
  ['list', '- 第一项：生成报告\n- 第二项：发送邮件'],
  ['quote', '> 所有不可逆操作都必须先问你'],
  ['strike', '旧方案 ~~直接覆盖~~ 已废弃，改为先备份。'],
  ['long', `**很长的正文**：${'这是一段用来测试换行的中文正文。'.repeat(6)}`],
]

let failures = 0
for (const [label, body] of cases) {
  const cfg = { sound: false, popup: true, popupTimeoutMs: 2500, balloon: false, box: false, powershell: ps }
  const script = `${buildScript(cfg, 'DeepSeek Harness', body)}\nSet-Content -LiteralPath '${marker}' -Value 'ran' -Encoding utf8`

  const file = join(tmpdir(), 'dsh-attention', `md-${label}-${process.pid}.ps1`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `\ufeff${script}`, 'utf8')

  const child = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', file], { stdio: 'ignore', timeout: 20_000 })
  const ran = existsSync(marker)
  const ok = child.status === 0 && ran
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(8)} exit=${child.status} reached-end=${ran}`)
  if (existsSync(marker)) rmSync(marker, { force: true })
  try { rmSync(file, { force: true }) } catch { /* disposable */ }
}

console.log(failures === 0 ? '\nall markdown bodies rendered' : `\n${failures} body(ies) failed`)
if (failures > 0) process.exitCode = 1

try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* disposable */
}
