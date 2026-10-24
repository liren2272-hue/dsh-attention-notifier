/**
 * End-to-end proof that the delivery script actually runs: build the same
 * PowerShell body `ring()` uses, append a marker write, run it synchronously
 * and check the marker. A successful spawn proves nothing; this proves the
 * sound and popup APIs were reached inside the child process.
 *
 * The script travels through a FILE, not -EncodedCommand — the same reason
 * ring() switched: the painted card outgrew the Windows command-line limit and
 * spawn started failing with ENAMETOOLONG, which looks exactly like "the
 * notifier went silent". A UTF-8 BOM is what makes Windows PowerShell 5.1 read
 * the file as UTF-8 rather than ANSI.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { buildScript } from '../notify.js'

const dir = mkdtempSync(join(tmpdir(), 'attention-verify-'))
const marker = join(dir, 'ran.txt')

const cfg = {
  sound: true,
  popup: true,
  // popupTimeoutMs is the knob that decides when the card leaves. `popupMs` is
  // the retired one: it survives in the config surface (and still gets clamped)
  // but buildScript never reads it, so a probe that sets only popupMs builds a
  // wait-forever card and hangs forever on its marker.
  popupTimeoutMs: 6000,
  balloon: false,
  box: false,
  soundFile: 'C:\\Windows\\Media\\notify.wav',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
}
// The marker is appended AFTER Application::Run returns, i.e. after the card has
// closed on its own — so a marker proves the card lived AND dismissed itself.
const script = `${buildScript(cfg, 'DeepSeek Harness', '任务结束（completed）：通知链路自检')}\nSet-Content -LiteralPath '${marker}' -Value 'ran' -Encoding utf8`

const file = join(tmpdir(), 'dsh-attention', `verify-${process.pid}.ps1`)
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, `\ufeff${script}`, 'utf8')

const started = Date.now()
const child = spawnSync(
  cfg.powershell,
  ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', file],
  // The DSH file sandbox denies piped stdio (EPERM); the plugin's own spawn uses
  // 'ignore' for the same reason, so the probe must match it.
  { stdio: 'ignore', timeout: 30_000 },
)
const elapsed = Date.now() - started

console.log(`exit=${child.status} elapsed=${elapsed}ms`)
if (child.error) console.log(`spawn error: ${String(child.error)}`)
const ran = existsSync(marker)
console.log(`script reached its end: ${ran}`)
try {
  rmSync(file, { force: true })
} catch {
  /* the script is disposable */
}
if (child.status !== 0 || !ran) process.exitCode = 1
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* the marker dir is disposable */
}
