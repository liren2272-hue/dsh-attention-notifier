// Fire a real card through the quick-popup API, with no host and no session.
//
// This is the whole point of popup.js: delivery is testable from a bare script.
// `node test/popup-live.mjs` shows the default sample, `ask`, `alert`, or an
// arbitrary tone, and `--` a custom title/body.
//
//   node test/popup-live.mjs
//   node test/popup-live.mjs ask
//   node test/popup-live.mjs alert 30000
//   node test/popup-live.mjs ok 0          # stays until clicked or Esc
import { POPUP_PRESETS, POPUP_TONES, popup, resolvePopup } from '../popup.js'

const argv = process.argv.slice(2)
const head = argv[0]

if (head === '--help' || head === '-h') {
  console.log('usage: node test/popup-live.mjs [tone|preset] [durationMs] [title] [body]')
  console.log(`  tones:   ${POPUP_TONES.join(', ')}`)
  console.log(`  presets: ${Object.keys(POPUP_PRESETS).join(', ')}`)
  process.exit(0)
}

if (head === '--dry-run') {
  // No card, just the resolved request: useful when the question is "what would
  // this call actually show", not "does the channel paint".
  console.log(JSON.stringify(resolvePopup({ title: 'DeepSeek Harness' }, { preset: argv[1] ?? 'ok' }), null, 2))
  process.exit(0)
}

const tone = head ?? 'ok'
const durationMs = argv[1] === undefined ? undefined : Number(argv[1])
const options = { preset: tone, tone, durationMs }
if (argv[2] !== undefined) options.title = argv[2]
if (argv[3] !== undefined) options.body = argv[3]

// Only the knobs a bare script has to supply itself. Everything else — the
// timeout clamp, the tone fallback, forcing popup on and balloon/box off — is
// the API's job, and this script deliberately does not duplicate it.
const cfg = {
  popup: true,
  sound: true,
  soundFile: 'C:\\Windows\\Media\\notify.wav',
  title: 'DeepSeek Harness',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
}

const result = popup(cfg, options)
console.log(JSON.stringify(result, null, 2))
console.log(result.ok ? 'card fired — look at the corner of the screen' : 'no delivery process was started')
if (!result.ok) process.exitCode = 1
