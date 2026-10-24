/**
 * Delivery for attention notices.
 *
 * Channel reality on Windows 10/11, established by probing this machine:
 *
 *   - SoundPlayer + SystemSounds: work, always.
 *   - WinRT toast (ToastNotificationManager): needs a packaged identity and
 *     fails for this host process with HRESULT 0x80073D54.
 *   - NotifyIcon.ShowBalloonTip: returns without error and displays NOTHING when
 *     Focus Assist or notification settings suppress balloons. Silence, not a
 *     failure — which is why it is no longer the default.
 *   - A topmost borderless form: always paints, no shell dependency, and closes
 *     itself on a timer so it never strands a modal dialog.
 *
 * Every attempt is appended to a log so "did it actually fire?" is answerable
 * after the fact instead of guessed from memory.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderMarkdown } from './markdown.js'

export const DEFAULT_LOG = join(tmpdir(), 'dsh-attention', 'notify.log')
const LOG_MAX_BYTES = 256 * 1024

/**
 * Accent colours for the popup's left rule, one per tone.
 *
 * The rule is the only part of the card readable from the corner of an eye, so
 * it carries the meaning instead of the text: blue = the turn finished, orange
 * = the agent is blocked on you, red = something failed or was interrupted.
 * All three are tuned for contrast against the dark card (#1E2026) rather than
 * taken from any palette, because pure CSS primaries vibrate on that ground.
 */
export const ACCENTS = {
  ok: [79, 110, 247],
  ask: [245, 158, 11],
  alert: [239, 68, 68],
}

/** Unknown tones fall back to success rather than throwing inside delivery. */
export function accentOf(tone) {
  return ACCENTS[tone] ?? ACCENTS.ok
}

/**
 * The status word shown in the card's chip. Colour alone is not an accessible
 * signal — roughly one in twelve men cannot separate the blue from the orange —
 * so every tone also carries a word and a distinct glyph on the tile badge.
 */
export const STATUS_TEXT = {
  ok: '已完成',
  ask: '待你决定',
  alert: '出错',
}

/**
 * The DeepSeek whale mark, flattened from the official 24x24 SVG into four
 * closed subpaths separated by "|". System.Drawing.Drawing2D has no elliptical
 * arc primitive, so the ten arcs in the original path are sampled into line
 * segments (Douglas-Peucker simplified, 120 points total, ~1.4KB).
 *
 * Four subpaths rather than one outline is load-bearing: the mark relies on the
 * even-odd fill rule to knock out the eye and the fin cuts. Filled as a single
 * polygon it becomes a solid blob with bogus edges crossing the body.
 */
export const WHALE = '23.75,4.65 22.37,5.55 20.75,5.75 19.56,6.49 19.14,5.54 17.56,4.52 16.93,3.27 16.57,3.22 16.04,4.50 16.05,5.98 16.63,7.50 17.96,8.83 17.52,10.02 16.07,9.20 12.13,5.63 11.98,4.80 12.82,3.97 12.59,3.69 11.09,3.70 8.79,4.43 5.91,4.32 3.75,4.94 1.70,6.58 0.26,9.35 0.02,11.95 0.80,15.17 1.93,17.06 3.51,18.67 5.46,19.94 7.61,20.66 9.35,20.83 11.89,20.56 13.59,19.90 14.94,18.95 16.88,19.36 18.60,19.17 18.98,18.83 18.91,18.30 16.73,17.34 19.18,13.45 19.87,11.37 20.15,9.32 22.23,8.56 23.42,7.27 23.95,5.61 23.75,4.65|11.58,18.17 9.50,16.65 8.18,16.01 7.90,16.05 7.76,16.29 7.87,16.91 8.30,17.75 8.21,18.02 7.91,18.20 7.31,18.26 6.41,18.04 4.90,17.05 3.55,15.65 2.37,13.58 1.71,11.33 1.67,9.74 2.94,9.48 4.63,9.74 6.09,10.24 7.86,11.28 9.68,12.98 12.82,17.22 14.63,18.78 12.87,18.74 11.58,18.17|12.58,11.73 12.61,11.60 12.65,11.53 12.75,11.45 12.87,11.42 13.00,11.44 13.10,11.51 13.17,11.61 13.19,11.73 13.17,11.85 13.11,11.95 13.01,12.01 12.89,12.04 12.79,12.02 12.67,11.95 12.61,11.86 12.58,11.73|15.69,13.32 15.24,13.47 14.86,13.47 14.46,13.33 14.06,13.02 13.87,12.80 13.75,12.47 13.73,12.14 13.79,11.66 13.71,11.36 13.53,11.16 13.32,11.04 12.74,10.94 12.53,10.85 12.46,10.76 12.44,10.64 12.47,10.52 12.57,10.40 12.66,10.31 12.94,10.21 13.23,10.19 13.52,10.23 14.06,10.46 14.54,10.85 14.81,11.11 15.22,11.61 15.62,12.23 15.85,12.65 15.95,12.92 15.96,13.06 15.87,13.21 15.69,13.32'

/**
 * Badge glyphs, each in a 12x12 box, as PowerShell that builds a filled
 * GraphicsPath named $badgePath. They must read at 15 logical pixels, so they
 * are deliberately dumb shapes: a check, a bar, a cross.
 */
export const BADGE_GLYPH = {
  ok: `$badgePath=New-Object System.Drawing.Drawing2D.GraphicsPath
$badgePath.AddPolygon([System.Drawing.PointF[]]@((New-Object System.Drawing.PointF(1.6,6.4)),(New-Object System.Drawing.PointF(4.5,9.3)),(New-Object System.Drawing.PointF(10.4,2.6)),(New-Object System.Drawing.PointF(9.0,1.4)),(New-Object System.Drawing.PointF(4.5,6.6)),(New-Object System.Drawing.PointF(2.9,5.0))))`,
  ask: `$badgePath=New-Object System.Drawing.Drawing2D.GraphicsPath
$badgePath.AddPolygon([System.Drawing.PointF[]]@((New-Object System.Drawing.PointF(5.0,2.0)),(New-Object System.Drawing.PointF(7.0,2.0)),(New-Object System.Drawing.PointF(7.0,7.4)),(New-Object System.Drawing.PointF(5.0,7.4))))
$badgePath.AddEllipse(5.0,9.0,2.0,2.0)`,
  alert: `$badgePath=New-Object System.Drawing.Drawing2D.GraphicsPath
$badgePath.AddPolygon([System.Drawing.PointF[]]@((New-Object System.Drawing.PointF(1.7,3.2)),(New-Object System.Drawing.PointF(3.2,1.7)),(New-Object System.Drawing.PointF(6.0,4.5)),(New-Object System.Drawing.PointF(8.8,1.7)),(New-Object System.Drawing.PointF(10.3,3.2)),(New-Object System.Drawing.PointF(7.5,6.0)),(New-Object System.Drawing.PointF(10.3,8.8)),(New-Object System.Drawing.PointF(8.8,10.3)),(New-Object System.Drawing.PointF(6.0,7.5)),(New-Object System.Drawing.PointF(3.2,10.3)),(New-Object System.Drawing.PointF(1.7,8.8)),(New-Object System.Drawing.PointF(4.5,6.0))))`,
}

function b64(text) {
  return Buffer.from(String(text ?? ''), 'utf8').toString('base64')
}

/**
 * The whole delivery, as one PowerShell program. Title and body travel as
 * base64 so arbitrary UTF-8 (quotes, CJK, newlines) survives the trip into a
 * PowerShell string literal, and the script itself stays pure ASCII because
 * Windows PowerShell 5.1 reads a file as ANSI.
 *
 * The popup half of the script is what makes "the card is on screen while I
 * work in PowerPoint" true, and every line of it was earned by watching a
 * failure: see the inline notes at the SetTopmost helper and the timer block.
 */
export function buildScript(cfg, title, body, tone = 'ok') {
  const lines = ["$ErrorActionPreference='SilentlyContinue'"]
  // Nothing here needs a console codepage switch. The title and body arrive as
  // .NET strings (UTF-16) and go straight into WinForms labels, which are
  // Unicode end to end. The mojibake seen in notify.log is the *reader's*
  // problem: Get-Content without -Encoding UTF8 decodes the UTF-8 log as GBK.
  // Changing chcp here would add process startup cost and fix nothing.
  lines.push(`$title=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(title)}'))`)
  lines.push(`$body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(body)}'))`)

  // MARKDOWN. The body may carry inline markup, and a notification that shows
  // literal `**asterisks**` reads as broken. The host renders it to styled spans
  // (markdown.js) and hands the result down as base64 JSON, because the script
  // must stay pure ASCII and small — the same reason the title and body travel
  // this way.
  //
  // The payload is a list of lines, each a list of [style, text] pairs. The
  // painter (below) measures and draws span by span, which is the only way mixed
  // styles fit a fixed-width box: GDI+ has no inline rich text, so "bold word in
  // a plain sentence" is a sequence of DrawString calls at running x offsets.
  const rendered = renderMarkdown(body)
  const payload = JSON.stringify({
    lines: rendered.lines.map((spans) => spans.map((span) => [span.style, span.text])),
    blocks: rendered.blocks,
  })
  lines.push(`$md=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(payload)}')) | ConvertFrom-Json`)
  // The rendered plain text, used for measuring. Markup is already stripped by
  // the host, so this is exactly what will be drawn — measuring anything else
  // would size the card against text that never appears.
  lines.push('$bodyPlain=(($md.lines | ForEach-Object { ($_ | ForEach-Object { $_[1] }) -join "" }) -join "`n")')

  if (cfg.sound) {
    lines.push(`$player=New-Object System.Media.SoundPlayer '${cfg.soundFile}'`)
    lines.push('$player.Play()')
  }

  if (cfg.balloon) {
    lines.push('Add-Type -AssemblyName System.Windows.Forms')
    lines.push('Add-Type -AssemblyName System.Drawing')
    lines.push('$icon=New-Object System.Windows.Forms.NotifyIcon')
    lines.push('$icon.Icon=[System.Drawing.SystemIcons]::Information')
    lines.push('$icon.Visible=$true')
    lines.push('$icon.ShowBalloonTip(6000,$title,$body,[System.Windows.Forms.ToolTipIcon]::Info)')
    lines.push('Start-Sleep -Milliseconds 6500')
    lines.push('$icon.Visible=$false')
    lines.push('$icon.Dispose()')
  }

  if (cfg.box) {
    lines.push('Add-Type -AssemblyName System.Windows.Forms')
    lines.push("$null=[System.Windows.Forms.MessageBox]::Show($body,$title,'OK','Information','Button1','ServiceNotification')")
  }

  if (cfg.popup) {
    const [r, g, b] = accentOf(tone)
    // The chip's word. Unknown tones already fell back to the success accent, so
    // they take the success word too rather than showing a mismatched label.
    const statusText = STATUS_TEXT[tone] ?? STATUS_TEXT.ok
    // STACKING. When several cards are on screen at once, the later ones retreat
    // up and to the left so the corner reads as a stack rather than as one card
    // being replaced. The host passes its ordinal in `stackIndex` (see
    // index.js's notify()), and this resolves it to a step count.
    //
    // The retreat is deliberately a PURE FUNCTION of that ordinal: each card is
    // its own process and its own window, so it cannot see the others, and it
    // must not try to — enumerating windows to count siblings is slow and
    // fragile. A pure function also means closing one card needs no
    // re-layout: the remaining cards are already where they should be.
    //
    // The cap matters. An unbounded ordinal would push the 100th card of a long
    // day off the screen entirely, so past STACK_MAX the offset is held at
    // STACK_MAX. Because the host resets its ordinal once the previous card has
    // had time to expire (see index.js), a real burst saturates at 2-3 and the
    // cap is a backstop rather than a working value.
    const rawIndex = Number(cfg.stackIndex)
    const ordinal = Number.isFinite(rawIndex) && rawIndex > 0 ? Math.floor(rawIndex) : 0
    const STACK_MAX = 3
    const stackStep = Math.min(STACK_MAX, ordinal)
    // The dimming for retreated cards. The front card (step 0) is untouched —
    // there must always be exactly one card at full strength, or a stack of
    // dimmed cards leaves nothing to read. Behind it, the content is drawn at
    // reduced opacity over a darkening wash, which is what makes the retreat
    // read as depth instead of as a clipped card.
    const dim = stackStep > 0
    // Resolved up front because both the countdown painter and the closing timer
    // need it. Anything that is not a usable positive number becomes 0 ("wait for
    // the human"): a NaN interval would tick immediately and close the card
    // before it ever paints. int.MaxValue is the parked sentinel because
    // System.Windows.Forms.Timer.Interval is a 32-bit signed int.
    //
    // `popupMs` is honoured here as a FLOOR on the visible time. It used to be
    // the only knob, and when `popupTimeoutMs` took over it was left in the
    // config surface as a dead switch: setting it did nothing at all, which is
    // the worst outcome for a hand-edited patch. As a floor it earns its place —
    // a card that flashes for 300ms and vanishes is worse than no card, because
    // the human never gets to read it — and it is clamped below to the 1000ms
    // hard floor so it cannot be set to something harmful.
    const rawTimeout = Number(cfg.popupTimeoutMs)
    const rawFloor = Number(cfg.popupMs)
    const floorMs = Number.isFinite(rawFloor) && rawFloor > 0 ? Math.floor(rawFloor) : 0
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.max(1000, Math.floor(rawTimeout), floorMs)
      : 0
    // DPI awareness must be claimed before any window or Screen metric exists.
    // A DPI-unaware process gets virtualised metrics from Windows, so a form
    // placed against a virtualised working area lands outside the region that
    // actually paints: the window reports Visible=True with sane bounds and
    // draws nothing. That was the bug that made the first popup invisible.
    //
    // Topmost on a WinForms form is genuinely fragile: setting `$f.TopMost=$true`
    // only turns into the WS_EX_TOPMOST style when the handle is created, and
    // under ShowDialog's modal loop that bit was measured flipping back to
    // 0x10000 (plain) on some runs, so a later topmost window (e.g. the shell's
    // overflow island) covered the card. SetWindowPos(HWND_TOPMOST) alone was
    // likewise unreliable. The only call that sticks is writing the WS_EX_TOPMOST
    // (0x8) bit directly into the extended style via SetWindowLong, then nudging
    // the window with SetWindowPos (NOACTIVATE so it never steals focus). Both
    // the Shown handler and a fast timer re-assert it for the card's lifetime.
    lines.push('Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class AttentionDpi{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int cx,int cy,uint flags);[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int n);[DllImport("user32.dll")]public static extern int SetWindowLong(IntPtr h,int n,int v);[DllImport("user32.dll")]public static extern IntPtr GetWindow(IntPtr h,uint cmd);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("kernel32.dll")]public static extern uint GetCurrentThreadId();[DllImport("user32.dll")]public static extern bool AttachThreadInput(uint a,uint b,bool f);[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);[DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);}\'')
    lines.push('$null=[AttentionDpi]::SetProcessDPIAware()')
    // Clicking the card should take you to the thing waiting for you. Only the
    // foreground window may hand focus to another process, and the card becomes
    // the foreground window the moment it is clicked — which is why this runs
    // inside the card's click handler rather than from the host, where a
    // background SetForegroundWindow would silently do nothing (Windows only
    // flashes the taskbar button for background callers).
    const target = String(cfg.focusProcess ?? 'DeepSeek Harness').replace(/'/g, "''")
    lines.push(`function FocusDsh(){ foreach($p in Get-Process -Name '${target}' -ErrorAction SilentlyContinue){ if($p.MainWindowHandle -ne [IntPtr]::Zero){ if([AttentionDpi]::IsIconic($p.MainWindowHandle)){ [void][AttentionDpi]::ShowWindow($p.MainWindowHandle,9) }; [void][AttentionDpi]::SetForegroundWindow($p.MainWindowHandle); return } } }`)
    // Raising the window lands on whatever session the page last showed. The
    // click therefore also POSTs the card's one-shot token to the host's jump
    // route; the page's client half polls that queue and opens the exact
    // session that interrupted. HttpWebRequest rather than Invoke-WebRequest:
    // the latter initializes PowerShell's web cmdlet machinery (hundreds of
    // ms) on first use, and this runs synchronously on the UI thread.
    const jump = String(cfg.jumpUrl ?? '').replace(/'/g, "''")
    lines.push(jump === ''
      ? 'function Send-Jump{}'
      : `function Send-Jump(){ try { $r=[System.Net.HttpWebRequest]::Create('${jump}'); $r.Method='POST'; $r.Timeout=2000; $resp=$r.GetResponse(); $resp.Close() } catch {} }`)
    lines.push('Add-Type -AssemblyName System.Windows.Forms')
    lines.push('Add-Type -AssemblyName System.Drawing')
    // A Form subclass that shows without taking the foreground. Both halves are
    // required, and this combination is the ONLY one that worked after measuring
    // every alternative on this machine:
    //
    //   ShowWithoutActivation alone  -> still steals focus under Application::Run
    //   WS_EX_NOACTIVATE via SetWindowLong -> destroys the window (7-21ms life)
    //   ShowDialog + TOOLWINDOW      -> destroys the window (96ms life)
    //   this subclass                -> focus kept, window lives its full timeout
    //
    // WS_EX_NOACTIVATE is set through CreateParams (at handle creation, as part
    // of the window's birth style) rather than written afterwards. That is what
    // makes it safe: the bit is present before the first activation attempt, so
    // WinForms' startup path is never asked to activate a window that cannot
    // activate. Writing it later, onto a live window, is what killed the card.
    //
    // DOUBLE BUFFERING lives here too, in the constructor, and the placement is
    // the whole point — measured, not assumed:
    //
    //   $f.SetStyle(OptimizedDoubleBuffer|AllPaintingInWmPaint,$true)  THROWS
    //     -> "Form does not contain a method named SetStyle": it is protected,
    //        and PowerShell's late binding cannot reach it. Under this script's
    //        $ErrorActionPreference='SilentlyContinue' that failure is invisible,
    //        which is exactly how a "double-buffered" card shipped with no double
    //        buffering at all and kept flickering.
    //   $f.DoubleBuffered = $true                                   THROWS
    //     -> the property is not settable from outside either.
    //   SetStyle(...) inside the constructor                       WORKS
    //
    // So the styles are set from C#, where they are reachable, before the handle
    // exists. AllPaintingInWmPaint is what suppresses the erase-to-BackColor that
    // makes the whole card flash on each repaint; OptimizedDoubleBuffer makes
    // that repaint land in an off-screen buffer instead of straight on the
    // screen. OnPaintBackground is overridden to a no-op for the same reason.
    lines.push(`Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition 'using System;using System.Windows.Forms;using System.Runtime.InteropServices;public class QuietCard:Form{public QuietCard(){SetStyle(ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint,true);}protected override bool ShowWithoutActivation{get{return true;}}protected override CreateParams CreateParams{get{CreateParams cp=base.CreateParams;cp.ExStyle|=0x08000000;return cp;}}protected override void OnPaintBackground(System.Windows.Forms.PaintEventArgs e){}}'`)
    lines.push('$f=New-Object QuietCard')
    lines.push("$f.FormBorderStyle='None'")
    lines.push("$f.StartPosition='Manual'")
    lines.push('$f.TopMost=$true')
    lines.push('$f.ShowInTaskbar=$false')
    lines.push('$f.BackColor=[System.Drawing.Color]::FromArgb(30,32,38)')
    // The card must own its own z-order when another application is in the
    // foreground, and the default (a plain visible owner) loses it. A tool
    // window carries WS_EX_TOOLWINDOW (0x80): it still paints topmost through
    // WS_EX_TOPMOST, but Windows will not let it take focus or show a taskbar
    // button, so holding it cannot interrupt the work it is calling attention
    // away from. This is also what lets the card survive a full-screen
    // foreground app (PowerPoint in slideshow), which otherwise paints over
    // every non-topmost window.
    lines.push('$f.TopLevel=$true')
    // ...and WS_EX_TOOLWINDOW (0x80) is written alongside WS_EX_TOPMOST by
    // SetTopmost so it cannot be dropped later: it is what keeps the card out of
    // the taskbar and Alt-Tab, and off the foreground app's activation path.
    //
    // WS_EX_NOACTIVATE IS DELIBERATELY NOT SET, and this is the single most
    // expensive lesson in this file. Setting it looks like the obvious way to
    // avoid stealing focus, and it measurably kills the card instead: with that
    // bit written via SetWindowLong, the window is destroyed almost immediately
    // after it is shown. Same script, only the style bits differing, measured
    // with Application::Run on this machine:
    //
    //     baseline (nothing)                     2515ms  lives
    //     + WS_EX_TOOLWINDOW                     2474ms  lives
    //     + WS_EX_NOACTIVATE                       12ms  DESTROYED
    //     SetWindowPos(-2)/(-1) only             2476ms  lives
    //     + TOOLWINDOW + SetWindowPos               7ms  DESTROYED
    //     + TOOLWINDOW + NOACTIVATE (as shipped)   21ms  DESTROYED
    //
    // A window that can never activate cannot satisfy WinForms' startup path, and
    // the form closes itself. So "don't steal focus" is delegated to
    // ShowWithoutActivation (the supported mechanism) plus SWP_NOACTIVATE on
    // every z-order call — never to the extended style.
    // Two separate jobs in SetTopmost, both required:
    //
    //   1. Re-write the extended style, because style bits can be dropped behind
    //      our back and `$f.TopMost` only writes them once, at creation.
    //   2. Force the window back to the TOP of the topmost band.
    //      SetWindowPos(hwnd, HWND_TOPMOST, ...) on a window that is ALREADY
    //      topmost is a no-op for z-order: Windows sees it is in the right band
    //      at the right place and does not reorder. Dropping to HWND_NOTOPMOST
    //      (-2) first and then back to HWND_TOPMOST (-1) moves the window to the
    //      end of the band, which is what actually re-inserts it on top.
    //
    // 0x413 = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOSENDCHANGING.
    // NOSENDCHANGING suppresses WM_WINDOWPOSCHANGING so the foreground app
    // cannot veto our z-order change from its message hook. NOACTIVATE keeps the
    // foreground in Office.
    //
    // Deliberately NO GetWindowLong-based readback guard here. Measured on this
    // machine, GetWindowLong(GWL_EXSTYLE) read back with the TOPMOST bit clear
    // for a card that was demonstrably painting above a later plain window, and
    // 64-bit-vs-32-bit noise made raw comparisons meaningless. The style is
    // written unconditionally and correctness is judged by z-order alone.
    lines.push('function SetTopmost($h){ $ex=[AttentionDpi]::GetWindowLong($h,-20); $ex2=($ex -bor 0x8) -bor 0x80; [void][AttentionDpi]::SetWindowLong($h,-20,$ex2); [void][AttentionDpi]::SetWindowPos($h,[IntPtr]::new(-2),0,0,0,0,0x413); [void][AttentionDpi]::SetWindowPos($h,[IntPtr]::new(-1),0,0,0,0,0x413) }')
    // Layout is expressed in logical pixels and multiplied by $k, the display's
    // scale factor. Font sizes are in points, which already grow with DPI, so
    // hardcoded pixel geometry silently falls out of step with them: a 22px
    // title label is shorter than a 10pt CJK line on a 150% display, and a
    // Label with AutoEllipsis that cannot fit even one line paints NOTHING.
    // That is why the title went missing while the body (72px) still showed.
    // Double buffering is set in the QuietCard CONSTRUCTOR (see the Add-Type
    // above), not here. `$f.SetStyle(...)` from PowerShell throws — the method
    // is protected — and under SilentlyContinue that failure is invisible, which
    // is how this card once shipped believing it was double-buffered while it
    // flickered on every repaint. There is deliberately nothing to do here.
    lines.push('$f.CreateControl()')
    lines.push('$gfx=$f.CreateGraphics()')
    lines.push('$k=$gfx.DpiX/96')
    // Type ramp. Sizes are in points (which already grow with DPI) while all
    // geometry below is multiplied by $k, so the two stay in step at 100%, 150%
    // and 200% scaling. px->pt is *0.75.
    lines.push('$hf=New-Object System.Drawing.Font("Microsoft YaHei UI",11.3,[System.Drawing.FontStyle]::Bold)')
    lines.push('$bf=New-Object System.Drawing.Font("Microsoft YaHei UI",9.4)')
    lines.push('$sf=New-Object System.Drawing.Font("Microsoft YaHei UI",7.6)')
    lines.push('$cf=New-Object System.Drawing.Font("Microsoft YaHei UI",7.9,[System.Drawing.FontStyle]::Bold)')
    // The body's style ramp. Bold and italic variants are built once and reused
    // across every repaint, because constructing a Font per span per frame is
    // exactly the kind of hidden cost that makes a 100ms repaint timer expensive.
    // Consolas is the code face: it is present on every Windows install since 7
    // and, unlike a CJK face, it keeps `--flag` and `a_b` readable at 9pt.
    lines.push('$bfb=New-Object System.Drawing.Font("Microsoft YaHei UI",9.4,[System.Drawing.FontStyle]::Bold)')
    lines.push('$bfi=New-Object System.Drawing.Font("Microsoft YaHei UI",9.4,[System.Drawing.FontStyle]::Italic)')
    lines.push('$bfc=New-Object System.Drawing.Font("Consolas",9.0)')
    // Layout grid, in logical pixels, from the design: 17px padding, a 42px
    // brand tile, 13px gutter, then the text column. 452px wide is the same
    // corner-card footprint the old 400px card occupied.
    lines.push('$padX=[int](17*$k)')
    lines.push('$padTop=[int](15*$k)')
    lines.push('$tileW=[int](42*$k)')
    lines.push('$tgap=[int](13*$k)')
    lines.push('$w=[int](452*$k)')
    lines.push('$tx=$padX+$tileW+$tgap')
    // The RIGHT inset is larger than the left, and that asymmetry is deliberate.
    // The left side of the text column already carries a 42px tile plus a 13px
    // gutter, so the eye reads a wide margin there; a symmetric 17px on the right
    // left the text optically crowded against the edge — it measured the same but
    // looked unbalanced, because the tile's weight is doing the work on the left.
    //
    // 28px, chosen AFTER the wrap bug was fixed. The earlier 40 was compensating
    // for that bug, not answering a design need: the walk was summing padded
    // per-glyph widths, so lines broke a third too early and the unused column
    // plus this inset read as one wide black band down the right side. With the
    // wrap measuring the real laid-out width, lines fill the column as intended
    // and the inset can go back to being a plain margin — which is all it ever
    // needed to be.
    //
    // Everything that ends at the text column's right edge uses this, not $padX:
    // the wrap width, the status chip, and the countdown hairline. Using $padX for
    // any of them would put that element out of line with the text.
    lines.push('$padR=[int](28*$k)')
    lines.push('$lw=$w-$tx-$padR')
    lines.push('$lineH=[int]$bf.GetHeight($gfx)')
    // The body is capped at three lines: a notification is a glance, and a card
    // that grows to fit a paragraph stops being glanceable. Two lines minimum so
    // a one-line message still has the same resting shape.
    //
    // The height comes from the RENDERED lines, not the raw body: with Markdown
    // in play, `- one\n- two` is two visual lines while its raw text also has
    // two, but a wrapped paragraph's line count depends on where the breaks fall
    // — which only the layout knows. Measuring the rendered text keeps the card
    // the same size whether or not markup was present.
    // AND the width must be passed as a SizeF, not as the bare integer this used
    // to use. `MeasureString(text, font, int)` resolves in PowerShell to an
    // overload that IGNORES the width and lays the text out as one long line, so
    // $need reported the height of UNWRAPPED text. A body that wraps to three
    // lines reported two lines' worth, the card reserved a two-line box, and the
    // walk painted three — the last line landing on the countdown hairline and
    // past the card's bottom edge. That was the overflow the user kept seeing, and
    // it is vertical, which is why tightening the right margin never touched it.
    //
    // Neither `MeasureString(text, font, int)` nor the SizeF form resolves to a
    // wrapping overload here — both returned the height of UNWRAPPED text in
    // measurement, so $need kept reporting fewer lines than the walk paints.
    //
    // So the height is computed by SIMULATING the walk: feed the rendered text
    // character by character, accumulating the real laid-out width exactly as the
    // painter does, and count the lines it takes. Using the same loop for both is
    // what guarantees the box and the painting agree — no overload resolution, no
    // second guess. It is also cheap: a card holds under 200 characters.
    lines.push(`$simLines=1; $simW=0`)
    lines.push(`foreach($ch in $bodyPlain.ToCharArray()){`)
    // A newline in the rendered body is an explicit break (a Markdown list item),
    // so it starts a new line rather than being measured as a glyph.
    lines.push(`  if($ch -eq "\`n"){ $simLines++; $simW=0; continue }`)
    lines.push(`  $simW+=$gfx.MeasureString([string]$ch,$bf).Width`)
    lines.push(`  if($simW -gt $lw){ $simLines++; $simW=$gfx.MeasureString([string]$ch,$bf).Width }`)
    lines.push(`}`)
    lines.push('$need=$simLines*$lineH')
    lines.push('$bodyH=[Math]::Max($lineH*2,[Math]::Min($need,$lineH*3))')
    lines.push('$headH=[int]$hf.GetHeight($gfx)')
    lines.push('$brandH=[int]$sf.GetHeight($gfx)')
    lines.push('$chipH=[int](24*$k)')
    lines.push('$eyebrowH=[Math]::Max($brandH,$chipH)')
    lines.push('$headY=$padTop+$eyebrowH+[int](5*$k)')
    lines.push('$bodyY=$headY+$headH+[int](5*$k)')
    // The eyebrow's left slot is the PRODUCT name (config `title`, e.g. "DeepSeek
    // Harness"), never the card's own headline. `$title` holds the headline, so
    // the brand string has to be passed in separately — reusing `$title` there
    // printed the headline twice.
    // The eyebrow carries the conversation name, not the fixed product label:
    // `cfg.brand` is threaded in from index.js (resolved from the session), and
    // falls back to the configured title so the row still reads sensibly when the
    // host does not expose a name.
    lines.push(`$brandName='${String(cfg.brand ?? cfg.title ?? 'DeepSeek Harness').replace(/'/g, "''")}'`)
    // The bottom band holds the countdown hairline and must clear the body's last
    // line. 17 was too tight once three lines were actually reachable: the hairline
    // sits at $h-8 with a 2px height, so a 17px band left the last text line and the
    // bar about 10px apart — and because a line's painted height includes its
    // descent, the gap looked like zero in practice (confirmed in a PrintWindow
    // capture: the third line sat on the bar).
    //
    // 26 gives the bar room and a visible gap above it. It is a constant, so the
    // card grows by 9px on every card rather than only on three-line ones — which
    // keeps the corner position stable instead of making the card jump as bodies
    // change length.
    lines.push('$h=$bodyY+$bodyH+[int](26*$k)')
    lines.push('$f.Size=New-Object System.Drawing.Size($w,$h)')
    lines.push('$wa=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea')
    // The anchor is the working area's bottom-right corner (right 24, bottom 36).
    // The stack retreat adds 22px to the right inset and 18px to the bottom inset
    // per step, so a retreated card sits up and to the LEFT of the one in front
    // of it — which, combined with the fact that a later-created topmost window
    // covers an earlier one, is what makes it read as "behind" rather than
    // "clipped". Both offsets are multiplied by $k so they scale with DPI.
    //
    // 22px was chosen to clear the card's left edge exactly: the accent rule is
    // 3px and the brand tile starts at 17px, so 22px exposes the rule plus the
    // tile's left edge — enough to identify the card without showing content.
    lines.push(`$f.Location=New-Object System.Drawing.Point(($wa.Right-$w-[int]((24+22*${stackStep})*$k)),($wa.Bottom-$h-[int]((36+18*${stackStep})*$k)))`)
    // Everything is drawn, not composed from Labels. A Label cannot carry a
    // gradient, a rounded corner, a tinted tile or a polygon mark, and stacking
    // Panels to fake them produces seams at every DPI. One Paint handler keeps
    // the card coherent and lets the countdown redraw cheaply.
    // Drawing2D is a NAMESPACE inside System.Drawing, not an assembly. Loading it
    // by name throws "assembly not found" and, because the script runs with
    // SilentlyContinue, that silently skipped the entire card: the window opened
    // at the right size and painted nothing at all. System.Drawing is already
    // loaded above, which is all the GraphicsPath/LinearGradientBrush types need.
    // Rounded rectangle helper, in device pixels, corner radius $r.
    lines.push('function RR($x,$y,$ww,$hh,$r){ $p=New-Object System.Drawing.Drawing2D.GraphicsPath; $d=$r*2; if($d -gt $ww){$d=$ww}; if($d -gt $hh){$d=$hh}; $p.AddArc($x,$y,$d,$d,180,90); $p.AddArc($x+$ww-$d,$y,$d,$d,270,90); $p.AddArc($x+$ww-$d,$y+$hh-$d,$d,$d,0,90); $p.AddArc($x,$y+$hh-$d,$d,$d,90,90); $p.CloseFigure(); return $p }')
    // THE CORNERS ARE CUT FROM THE WINDOW ITSELF, not merely painted over.
    //
    // This is the fix for the black corners the double-buffering round exposed.
    // Once OnPaintBackground is suppressed, the double buffer starts out pure
    // black, and Paint only fills the rounded path — so the four corners outside
    // that path keep the buffer's black instead of the old BackColor grey. The
    // symptom was black wedges at every corner.
    //
    // Setting the form's Region to that same rounded path makes Windows exclude
    // those corners from the window entirely: nothing is ever drawn there, so
    // there is nothing to get the colour wrong, and the desktop (or whatever app
    // is behind the card) shows through a real hole.
    //
    // A Region is chosen over the alternatives deliberately:
    //   - painting the corners to a colour has to be right on every wallpaper and
    //     every app behind the card, and it is wrong the moment either changes;
    //   - WS_EX_LAYERED with per-pixel alpha would fight the topmost/z-order
    //     handling this card depends on (see the SetTopmost notes), and it costs
    //     a composited surface for a card that is on screen for seconds.
    //
    // The path uses the SAME helper, the SAME bounds and the SAME radius as the
    // Paint handler's card ($w-1, $h-1, 13*$k), so the window's shape and the
    // drawn card cannot drift apart. Region is set after the size, because it is
    // expressed in the form's own coordinates.
    lines.push('$f.Region=New-Object System.Drawing.Region((RR 0 0 ($w-1) ($h-1) ([int](13*$k))))')
    // The whale mark, built once in its native 24x24 units with FillMode.Alternate
    // so the eye and fin cut-outs stay holes. It is transformed at paint time via
    // the Graphics transform rather than by mutating the path, which keeps the
    // source units reusable.
    // PowerShell variable names are case-INSENSITIVE, so the data ($WHALE) and the
    // path built from it ($whalePath) must not share a name — reusing `$whale`
    // overwrote the string literal and the very next `.Split()` call failed with
    // "method not found", which the SilentlyContinue preference then hid.
    lines.push(`$whaleData='${WHALE}'`)
    lines.push('$whalePath=New-Object System.Drawing.Drawing2D.GraphicsPath')
    lines.push('$whalePath.FillMode=[System.Drawing.Drawing2D.FillMode]::Alternate')
    lines.push('foreach($sp in $whaleData.Split("|")){ $pts=New-Object "System.Collections.Generic.List[System.Drawing.PointF]"; foreach($pair in $sp.Split(" ")){ $xy=$pair.Split(","); $pts.Add((New-Object System.Drawing.PointF([float]$xy[0],[float]$xy[1]))) }; $whalePath.AddPolygon($pts.ToArray()) }')
    lines.push('$script:t0=[DateTime]::Now')
    lines.push('$script:tmo=' + (timeoutMs > 0 ? String(timeoutMs) : '0'))
    // Tone palette, resolved once: the accent plus the two translucent tints the
    // tile and chip are built from.
    lines.push(`$script:accent=[System.Drawing.Color]::FromArgb(${r},${g},${b})`)
    lines.push(`$script:tint=[System.Drawing.Color]::FromArgb(38,${r},${g},${b})`)
    lines.push(`$script:tintLine=[System.Drawing.Color]::FromArgb(92,${r},${g},${b})`)
    lines.push(`$script:tintText=[System.Drawing.Color]::FromArgb(${Math.min(255, r + 60)},${Math.min(255, g + 50)},${Math.min(255, b + 40)})`)
    lines.push('$script:cTitle=[System.Drawing.Color]::FromArgb(244,247,252)')
    lines.push('$script:cBody=[System.Drawing.Color]::FromArgb(182,192,208)')
    lines.push('$script:cBrand=[System.Drawing.Color]::FromArgb(138,147,165)')
    lines.push(`$script:statusText='${statusText.replace(/'/g, "''")}'`)
    // The brush for code and link spans. These take the accent tint rather than
    // the body grey so they read as "there is something here" without needing a
    // second colour per tone — the tint is already derived from the accent.
    lines.push(`$script:codeBrush=New-Object System.Drawing.SolidBrush($script:tintText)`)
    lines.push(`$script:badge='${tone}'`)
    lines.push(BADGE_GLYPH[tone] ?? BADGE_GLYPH.ok)
    lines.push('$f.Add_Paint({')
    // `$_` is the event args. `$EventArgs` reads as $null inside a scriptblock and
    // the very first `$EventArgs.Graphics` then throws a null-reference — under
    // SilentlyContinue that produced a correctly sized, completely blank window,
    // which is a very hard failure to attribute from the outside.
    lines.push('  $gr=$_.Graphics')
    lines.push('  $gr.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::AntiAlias')
    lines.push('  $gr.TextRenderingHint=[System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit')
    lines.push('  $gr.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality')
    lines.push('  $card=RR 0 0 ($w-1) ($h-1) ([int](13*$k))')
    // Fill the WHOLE client area first, then the rounded card on top.
    //
    // This is the fix for the black ring along the inside of the corners. The
    // card is drawn with SmoothingMode=AntiAlias, so the rounded edge is a 1-2
    // pixel band of partially transparent pixels rather than a hard cut. Those
    // pixels need a background to blend against, and once OnPaintBackground is
    // suppressed (the flicker fix) the double buffer starts out PURE BLACK — so
    // every anti-aliased corner pixel was blending toward black, which read as a
    // dark ring inside the corners. Filling the client area with the card's own
    // darkest tone first gives the blend a correct base, and the corners become
    // a clean fade to the region's cut-out edge instead of to black.
    //
    // The fill is bounded by the form's Region, so it never paints into the
    // corners that are cut out of the window — it only ever covers the client
    // area the region allows.
    lines.push('  $base=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26,28,34))')
    lines.push('  $gr.FillRectangle($base,0,0,$w,$h)')
    lines.push('  $bg=New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Point(0,0)),(New-Object System.Drawing.Point(0,$h)),[System.Drawing.Color]::FromArgb(35,38,47),[System.Drawing.Color]::FromArgb(26,28,34))')
    lines.push('  $gr.FillPath($bg,$card)')
    // The tone wash is a RADIAL glow centred on the tile, not a linear ramp.
    // A linear brush was tried first and left a hard diagonal seam: GDI+
    // interpolates the alpha ramp across the whole brush rectangle, so the
    // transparent end cuts off as a straight edge wherever the rectangle stops.
    // PathGradientBrush fades from a centre point outward, which is the shape a
    // corner glow actually wants and has no edge to cut.
    lines.push('  $glow=New-Object System.Drawing.Drawing2D.GraphicsPath')
    lines.push(`  $glow.AddEllipse(($padX-$tileW*2),($padTop-$tileW*2),($tileW*5),($tileW*5))`)
    lines.push('  $wg=New-Object System.Drawing.Drawing2D.PathGradientBrush($glow)')
    lines.push('  $wg.CenterPoint=New-Object System.Drawing.PointF(($padX+$tileW/2),($padTop+$tileW/2))')
    lines.push(`  $wg.CenterColor=[System.Drawing.Color]::FromArgb(34,${r},${g},${b})`)
    lines.push(`  $wg.SurroundColors=[System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(0,${r},${g},${b}))`)
    lines.push('  $stg=$gr.Save()')
    lines.push('  $gr.SetClip($card)')
    lines.push('  $gr.FillPath($wg,$glow)')
    lines.push('  $gr.Restore($stg)')
    lines.push('  $pen=New-Object System.Drawing.Pen(([System.Drawing.Color]::FromArgb(20,255,255,255)),1)')
    lines.push('  $gr.DrawPath($pen,$card)')
    // brand tile
    lines.push('  $tp=RR $padX $padTop $tileW $tileW ([int](12*$k))')
    lines.push('  $tb=New-Object System.Drawing.SolidBrush($script:tint)')
    lines.push('  $gr.FillPath($tb,$tp)')
    lines.push('  $tpen=New-Object System.Drawing.Pen($script:tintLine,1)')
    lines.push('  $gr.DrawPath($tpen,$tp)')
    // whale, centred in the tile
    lines.push('  $ws=$tileW/24.0*0.62')
    lines.push('  $wx=$padX+($tileW-24*$ws)/2')
    lines.push('  $wy=$padTop+($tileW-24*$ws)/2')
    lines.push('  $st=$gr.Save()')
    lines.push('  $gr.TranslateTransform($wx,$wy)')
    lines.push('  $gr.ScaleTransform($ws,$ws)')
    lines.push('  $wb=New-Object System.Drawing.SolidBrush($script:accent)')
    lines.push('  $gr.FillPath($wb,$whalePath)')
    lines.push('  $gr.Restore($st)')
    // status badge on the tile corner
    lines.push('  $br=[int](15*$k)')
    lines.push('  $bx=$padX+$tileW-$br+[int](3*$k)')
    lines.push('  $by=$padTop+$tileW-$br+[int](3*$k)')
    lines.push('  $bb=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26,28,34))')
    lines.push('  $gr.FillEllipse($bb,$bx-$br/6,$by-$br/6,($br*1.34),($br*1.34))')
    lines.push('  $gb=New-Object System.Drawing.SolidBrush($script:accent)')
    lines.push('  $gs=$br/12.0')
    lines.push('  $gst=$gr.Save()')
    lines.push('  $gr.TranslateTransform($bx+$br*0.09,$by+$br*0.09)')
    lines.push('  $gr.ScaleTransform($gs,$gs)')
    lines.push('  $gr.FillPath($gb,$badgePath)')
    lines.push('  $gr.Restore($gst)')
    // eyebrow: brand name, then the status chip on the right.
    //
    // The brand sits on the SAME row as the status chip, so it must never run
    // under the "已完成"/"待你决定" box. It is clamped to the gap between the
    // text column's left edge ($tx) and the chip's left edge ($cx), minus a
    // small breathing gap, and rendered with EllipsisCharacter so a long
    // conversation name is trimmed with "…" right at the box instead of
    // overlapping it. Height is the single-line brand height with LineLimit, so
    // it is always one row — never two.
    lines.push('  $sb=New-Object System.Drawing.SolidBrush($script:cBrand)')
    lines.push('  $bw=[int]($cx-$tx-[int](8*$k))')
    lines.push('  if($bw -lt [int](12*$k)){ $bw=[int](12*$k) }')
    lines.push('  $bft=New-Object System.Drawing.StringFormat')
    lines.push('  $bft.Trimming=[System.Drawing.StringTrimming]::EllipsisCharacter')
    lines.push('  $bft.FormatFlags=[System.Drawing.StringFormatFlags]::LineLimit')
    lines.push('  $gr.DrawString($brandName,$sf,$sb,(New-Object System.Drawing.RectangleF($tx,($padTop+($eyebrowH-$brandH)/2),$bw,$brandH)),$bft)')
    lines.push('  $bft.Dispose()')
    lines.push('  $tw=$gr.MeasureString($script:statusText,$cf).Width')
    // The status chip's internal spacing. The old formula (`tw+18`) left ONE
    // pixel between the text and the right edge, because 17 of those 18px was
    // spent positioning the text after the dot — so "待你决定" sat hard against
    // the border and read as cramped. The padding is now stated as the space
    // actually wanted on each side of the dot-and-text group:
    //
    //   10  left edge   -> dot
    //    6  dot         -> text
    //   10  text        -> right edge
    //
    // which is `dot(6) + 6 + text + 10` from the left edge, i.e. the text starts
    // at 22 and the chip is `tw + 32` wide. The right edge stays pinned to
    // $w-$padR, so it remains flush with the text column, the title and the
    // countdown hairline.
    lines.push('  $cw=$tw+[int](32*$k)')
    lines.push('  $cx=$w-$padR-$cw')
    lines.push('  $cy=$padTop+($eyebrowH-$chipH)/2')
    lines.push('  $cp=RR $cx $cy $cw $chipH ([int]($chipH/2))')
    lines.push('  $gr.FillPath($tb,$cp)')
    lines.push('  $gr.DrawPath($tpen,$cp)')
    lines.push('  $db=[int](6*$k)')
    lines.push('  $gr.FillEllipse($gb,($cx+[int](10*$k)),($cy+$chipH/2-$db/2),$db,$db)')
    lines.push('  $ctb=New-Object System.Drawing.SolidBrush($script:tintText)')
    lines.push('  $gr.DrawString($script:statusText,$cf,$ctb,($cx+[int](22*$k)),($cy+($chipH-$gr.MeasureString($script:statusText,$cf).Height)/2))')
    // title
    //
    // Drew unbounded before, which meant a long title simply ran past the card's
    // right edge and got clipped by the window Region — text hitting the edge is
    // exactly the crowding this change is about, so it gets the same ellipsis box
    // the body has.
    lines.push('  $tb2=New-Object System.Drawing.SolidBrush($script:cTitle)')
    lines.push('  $tfmt=New-Object System.Drawing.StringFormat')
    lines.push('  $tfmt.Trimming=[System.Drawing.StringTrimming]::EllipsisCharacter')
    lines.push('  $tfmt.FormatFlags=[System.Drawing.StringFormatFlags]::LineLimit')
    lines.push('  $gr.DrawString($title,$hf,$tb2,(New-Object System.Drawing.RectangleF($tx,$headY,$lw,$headH)),$tfmt)')
    lines.push('  $tfmt.Dispose()')
    // body, trimmed to the three-line box
    lines.push('  $fmt=New-Object System.Drawing.StringFormat')
    lines.push('  $fmt.Trimming=[System.Drawing.StringTrimming]::EllipsisCharacter')
    lines.push('  $fmt.FormatFlags=[System.Drawing.StringFormatFlags]::LineLimit')
    lines.push('  $bb2=New-Object System.Drawing.SolidBrush($script:cBody)')
    lines.push('  $fmt=New-Object System.Drawing.StringFormat')
    lines.push('  $fmt.Trimming=[System.Drawing.StringTrimming]::EllipsisCharacter')
    lines.push('  $fmt.FormatFlags=[System.Drawing.StringFormatFlags]::LineLimit')
    // THE BODY, SPAN BY SPAN.
    //
    // GDI+ has no inline rich text: DrawString paints a whole string in one font.
    // So "plain text with a **bold** word" is drawn as a run of DrawString calls
    // at advancing x offsets, each with its own font and colour. This is the only
    // way mixed styles fit a fixed-width box, and it is why the host sends styled
    // spans instead of raw Markdown.
    //
    // The walk is explicit rather than delegated to a layout engine, because the
    // card has a hard contract: at most three lines, and the last one gets an
    // ellipsis when it runs out of room. A layout engine would reflow freely and
    // break both.
    //
    // Style bits: 1=bold 2=italic 4=code 8=strike 16=link.
    lines.push('  $bx=$tx; $by=$bodyY; $lineUsed=0; $maxLines=3')
    lines.push('  foreach($ln in $md.lines){')
    lines.push('    if($lineUsed -ge $maxLines){ break }')
    lines.push('    $bx=$tx')
    lines.push('    foreach($sp in $ln){')
    lines.push('      $st=[int]$sp[0]; $txt=[string]$sp[1]')
    lines.push('      if($txt -eq ""){ continue }')
    // Font selection per style. Bold+italic is not in the ramp: a span can carry
    // both bits (e.g. `***x***`), and the closest available face is bold.
    lines.push('      $fn=$bf')
    lines.push('      if(($st -band 4) -ne 0){ $fn=$bfc }')
    lines.push('      elseif(($st -band 1) -ne 0){ $fn=$bfb }')
    lines.push('      elseif(($st -band 2) -ne 0){ $fn=$bfi }')
    // Colour: code and links take the accent tint so they read as actionable,
    // everything else stays the body grey.
    lines.push('      $br=$bb2')
    lines.push('      if(($st -band 4) -ne 0 -or ($st -band 16) -ne 0){ $br=$script:codeBrush }')
    // Feed the span character by character, breaking whenever the running width
    // would leave the text column.
    //
    // This replaced a word-wrap that only broke on SPACES, which is wrong for the
    // text this card actually carries: Chinese has no spaces at all, so a 40-char
    // sentence never found a break point, fell through to a fallback cut, and was
    // then drawn with the POINTF DrawString overload — which does not wrap either.
    // The measured width said the text fitted; the drawn text ran off the card and
    // was clipped by the window region. That was the "text is about to overflow"
    // the user reported, and it was never a margin problem.
    //
    // Measuring one character at a time is the only thing that is correct for
    // mixed CJK and Latin, and it is cheap: a card holds under 200 characters and
    // this runs on repaint, which is 10Hz at worst.
    lines.push('      $run=""; $runW=0')
    lines.push('      for($ci=0;$ci -lt $txt.Length;$ci++){')
    lines.push('        $ch=$txt.Substring($ci,1)')
    // Measure the CANDIDATE run as one string, rather than summing per-character
    // widths. Summing is wrong in a way that cost the card a third of its width:
    // MeasureString on a single character returns a width padded with side
    // bearings (~25.6px here), while the same characters laid out together are
    // kerned down to ~18.7px each. Summing therefore hit the wrap limit about a
    // third too early — lines broke at 373px inside a 509px column, and the
    // unused 132px plus the right inset read as a wide black band on the right.
    //
    // Measuring the accumulated string is what the DrawString below will actually
    // paint, so the wrap point and the painted width finally agree.
    lines.push('        $cand=$run+$ch')
    lines.push('        $cw=$gr.MeasureString($cand,$fn).Width')
    lines.push('        if(($bx-$tx)+$cw -gt $lw){')
    // Flush what has accumulated (which fits), then move down and START THE NEW
    // LINE WITH THIS CHARACTER. Setting $run=$ch here is the part that matters:
    // leaving $run empty and letting the next iteration re-append would re-measure
    // a longer run against a column it already overflowed, which is how a run
    // wider than $lw got painted.
    lines.push('          if($run -ne ""){ $gr.DrawString($run,$fn,$br,$bx,$by); $bx+=$runW }')
    // The budget check must come BEFORE $by moves. Advancing first and breaking
    // after left $by parked one line below the last painted line, and the
    // ellipsis below then drew at that out-of-box y — the fourth line landing on
    // the countdown hairline. So the advance is what gets skipped, not just the
    // draw.
    lines.push('          if($lineUsed+1 -ge $maxLines){ $run=""; $runW=0; break }')
    lines.push('          $bx=$tx; $by+=$lineH; $lineUsed++; $run=""; $runW=0')
    lines.push('          $run=$ch; $runW=$gr.MeasureString($ch,$fn).Width')
    lines.push('        } else {')
    lines.push('          $run=$cand; $runW=$cw')
    lines.push('        }')
    lines.push('      }')
    // A single glyph wider than the whole column, or a run that reached here still
    // too wide, must never be painted as-is: it would run past the card and be
    // clipped by the window region, which is what "text is about to overflow"
    // looked like. Trim to the last character that fits, so the card's right edge
    // stays intact whatever the body contains.
    lines.push('      while($run -ne "" -and $runW -gt $lw){ $run=$run.Substring(0,$run.Length-1); if($run -eq ""){ break }; $runW=$gr.MeasureString($run,$fn).Width }')
    lines.push('      if($run -ne ""){ $gr.DrawString($run,$fn,$br,$bx,$by); $bx+=$runW }')
    // Anything still unwritten when the line budget ran out gets an ellipsis —
    // appended at the END OF THE LAST PAINTED LINE, at that line's own $by. It
    // used to be drawn at whatever $by had become, which was one line lower, and
    // that is precisely the mark that appeared on top of the countdown hairline.
    // The condition is "there is text left", NOT "$lineUsed >= $maxLines". The
    // budget check now fires BEFORE the counter increments, so at the moment the
    // walk bails out $lineUsed is still one short of $maxLines — testing the
    // counter meant the ellipsis was never drawn at all, and a truncated body just
    // stopped mid-sentence with no indication that more existed.
    lines.push('      if($ci -lt $txt.Length){ $gr.DrawString("…",$fn,$br,$bx,$by) }')
    // Strike-through is drawn across what was just written, because GDI+ has no
    // struck font and FontStyle has no strike member.
    lines.push('      if(($st -band 8) -ne 0 -and $run -ne ""){')
    lines.push('        $gr.DrawLine((New-Object System.Drawing.Pen($br,1)),$bx-$runW,($by+$lineH/2),$bx,($by+$lineH/2))')
    lines.push('      }')
    lines.push('    }')
    // The advance at the end of each rendered source line must obey the same
    // budget as the wraps inside it. It used to be unconditional, which is how a
    // body with four Markdown lines (four list items, say) painted a fourth line
    // even though $bodyH only ever reserves three: $by stepped past the body box
    // and the text landed on the countdown hairline. The wrap branch was guarded
    // and this one was not, so only multi-line bodies exposed it.
    // The advance at the end of each rendered source line must obey the same
    // budget as the wraps inside it. It used to be unconditional, which let a body
    // with several Markdown lines step $by past the three-line box that $bodyH
    // reserves, putting text on the countdown hairline.
    lines.push('    if($lineUsed -ge $maxLines){ break }')
    lines.push('    $lineUsed++; $by+=$lineH')
    lines.push('  }')
    lines.push('  $fmt.Dispose()')
    // countdown hairline: drains right-to-left, only when a timeout is armed
    lines.push('  if($script:tmo -gt 0){')
    lines.push('    $el=([DateTime]::Now-$script:t0).TotalMilliseconds')
    lines.push('    $frac=1-($el/$script:tmo)')
    lines.push('    if($frac -lt 0){$frac=0} if($frac -gt 1){$frac=1}')
    lines.push('    $ty=$h-[int](8*$k)')
    // The hairline spans from the leftmost content edge (the brand tile's left,
    // at $padX) to the rightmost (the text column's right, at $w-$padR). That is
    // why it is NOT symmetric: it is bounded by the card's content, not by an
    // arbitrary inset, so its ends line up with the tile and the text above it.
    lines.push('    $trk=RR $padX $ty ($w-$padX-$padR) ([int](2*$k)) ([int](2*$k))')
    lines.push('    $trb=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(16,255,255,255))')
    lines.push('    $gr.FillPath($trb,$trk)')
    lines.push('    $fw=($w-$padX-$padR)*$frac')
    lines.push('    if($fw -gt 1){ $fp=RR $padX $ty $fw ([int](2*$k)) ([int](2*$k)); $gr.FillPath($gb,$fp) }')
    lines.push('  }')
    // THE STACK WASH. A retreated card draws a darkening veil over everything
    // above, so depth reads without any per-card opacity support (GDI+ has none:
    // every brush and string here is fully opaque, so "55% content" is expressed
    // as content at full strength plus a veil, which is the same thing visually).
    //
    // The veil is a translucent near-black clipped to the rounded card path, so
    // it darkens the content without touching the corners that the Region has
    // already cut out of the window. The front card (step 0) gets no veil at all:
    // there must always be exactly one card at full strength, or a stack of
    // dimmed cards leaves nothing to read.
    if (dim) {
      lines.push('  $wash=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90,10,11,14))')
      lines.push('  $gr.FillPath($wash,$card)')
      lines.push('  $wash.Dispose()')
    }
     // Every GDI object the Paint handler created. The fonts and the code brush
     // are NOT here: they are built once at script top level and live for the
     // card's whole life, so disposing them per frame would break the next paint.
     // A Font or Brush is a native handle, not a managed object, so a repaint
     // timer at 10Hz that leaked one per frame would be a slow, invisible
     // resource exhaustion.
    lines.push('  $base.Dispose(); $bg.Dispose(); $wg.Dispose(); $glow.Dispose(); $pen.Dispose(); $tb.Dispose(); $tpen.Dispose(); $sb.Dispose(); $tb2.Dispose(); $bb2.Dispose(); $ctb.Dispose(); $gb.Dispose(); $bb.Dispose(); $wb.Dispose(); $card.Dispose(); $tp.Dispose(); $cp.Dispose(); $fmt.Dispose()')
    lines.push('})')
    lines.push('$timer=New-Object System.Windows.Forms.Timer')
    // popupTimeoutMs is how long the card stays VISIBLE, so the countdown must
    // start when the card is actually on screen — not when this process starts.
    // Starting the timer here, at script top level, was measurably wrong: the
    // child spends 1.8-2.5s in PowerShell startup and Add-Type compilation before
    // the window exists, and that time was being charged against the timeout.
    // Measured lifetimes for a "10s" card varied between 3.4s and 8.3s depending
    // on how warm the compiler was. The timer is therefore started from Shown.
    //
    // The interval is still written here, at creation, and it must be: a
    // System.Windows.Forms.Timer defaults to 100ms, so leaving it unset while
    // the Start() lives elsewhere turns the card into a 100ms flash once both
    // halves are wired up. The timeout itself is what closes the card, so it
    // gets the number that was asked for.
    // 0 is still honoured as "wait for the human" for anyone who wants the old
    // behaviour; Esc and a click close it early either way (KeyPreview below).
    if (timeoutMs > 0) {
      lines.push(`$timer.Interval=${timeoutMs}`)
    } else {
      // A zero interval ticks immediately; park it far out instead of
      // disabling the timer so the closing path exists but never fires.
      lines.push('$timer.Interval=[int]::MaxValue')
    }
    lines.push('$timer.add_Tick({ $f.Close() })')
    // Armed in the Shown handler (below), not here, so the timeout counts visible
    // time rather than process startup.
    // The countdown hairline needs a repaint to move. 100ms is smooth enough for
    // a 2px bar and cheap enough that it is invisible in CPU terms; the timer is
    // only started when a timeout is actually armed, so a wait-forever card does
    // no repaint work at all.
    if (timeoutMs > 0) {
      lines.push('$script:tickr=New-Object System.Windows.Forms.Timer')
      lines.push('$script:tickr.Interval=100')
      lines.push('$script:tickr.add_Tick({ $f.Invalidate() })')
    } else {
      lines.push('$script:tickr=$null')
    }
    // Application::Run does not stop when its form closes; it keeps pumping the
    // message loop, and the PowerShell process would sit there forever holding a
    // hidden window. ExitApplication on close is what makes the child terminate
    // promptly, which matters because the host spawns one child per card. The
    // topmost/watchdog timers are stopped first: a Timer whose handler touches a
    // disposed form throws on the next tick.
    lines.push('$f.Add_FormClosed({ $timer.Stop(); $topmost.Stop(); if($script:tickr){ $script:tickr.Stop() }; [System.Windows.Forms.Application]::Exit() })')
    // Jump first: the page polls the queue, so filling it before the window
    // rises means the session switch lands in the same breath as the focus.
    // One handler on the form is enough now that the whole card is painted: the
    // old per-Label handlers existed only because Labels swallow mouse events
    // from their parent, and there are no child controls left to swallow them.
    lines.push('$f.Add_Click({ Send-Jump; FocusDsh; $f.Close() })')
    lines.push('$gfx.Dispose()')
    // Re-assert the band on a timer, and walk past invisible windows.
    //
    // GW_HWNDPREV (3) returns the window immediately above the card. The naive
    // reading — "non-zero means something covers me" — is wrong, and was
    // measured wrong: explorer's ForegroundStaging window sits above every
    // topmost window in z-order, is permanently invisible, and has an empty
    // title. So `above != 0` was true even when the card was provably the
    // topmost VISIBLE window, which made the repair fire forever for no reason.
    //
    // The check therefore skips windows that are not visible and asks only about
    // the first one that could actually occlude the card. The repair then runs
    // when — and only when — a real, painted window is above us.
    //
    // The polarity is deliberate: repair when something IS above. An earlier
    // revision had it inverted (`-eq Zero`), which meant a covered card was never
    // repaired; that shipped the bug where even the plain, non-topmost DSH
    // window sat on the card.
    //
    // ...and the repair is THROTTLED, which is the fix for the flicker the
    // animation introduced. SetTopmost drops the window out of the topmost band
    // and re-inserts it (NOTOPMOST -> TOPMOST, the only way to actually reorder
    // an already-topmost window), so every repair is a visible reorder. Measured
    // on this machine, an unthrottled repair on the 250ms timer performed 17
    // reorders during a 4s card — one every ~235ms, i.e. the card was being torn
    // out of the band and re-inserted for its entire life. That is the flicker,
    // and it is z-order, not repaint: double buffering and partial invalidation
    // were both measured and neither moved the reorder count.
    //
    // 1000ms is the throttle window. It is not "slower repair", it is "the same
    // repair, at most once a second": z-order does not change 4 times a second
    // unless something is actively fighting us, and a card that is genuinely
    // re-covered is restored within a second either way. 5 reorders instead of
    // 17 measured, with the topmost behaviour intact.
    //
    // The stamp is seeded to MinValue so the FIRST repair is never throttled:
    // with $null the subtraction throws, SilentlyContinue hides it, and every
    // repair would be silently skipped — which is exactly the kind of invisible
    // failure this file has been bitten by before.
    lines.push('$script:lastFix=[DateTime]::MinValue')
    // ...and a RETREATED card never repairs at all. This is what makes stacking
    // work, and it is the reason the previous revision's approach was wrong: it
    // tried to identify a sibling card by process id, which cannot work — every
    // card is its own PowerShell child, so a sibling has a DIFFERENT pid and the
    // test "is the window above me mine" is always false. There is no way to tell
    // a brother card from any other application by pid.
    //
    // The correct rule is simpler: a retreated card has nothing to repair. Its
    // position is a pure function of its ordinal, computed once at creation and
    // never wrong, and being covered by the card in front of it is the intended
    // look — "repairing" would tear the stack apart, because each repair
    // re-inserts its own window at the very top of the topmost band, and two
    // cards would trade places once a second forever.
    //
    // Only the FRONT card (step 0) keeps the repair, because it is the one that
    // must not be buried by an unrelated application.
    if (stackStep > 0) {
      // The timer still runs — it is what stops a covered card from being
      // forgotten — but its handler is a no-op, so the retreat is stable.
      lines.push('function AssertTop($h){ }')
    } else {
      lines.push('function AssertTop($h){ if((([DateTime]::Now-$script:lastFix).TotalMilliseconds) -lt 1000){ return }; $script:lastFix=[DateTime]::Now; $p=[AttentionDpi]::GetWindow($h,3); while($p -ne [IntPtr]::Zero -and -not [AttentionDpi]::IsWindowVisible($p)){ $p=[AttentionDpi]::GetWindow($p,3) }; if($p -ne [IntPtr]::Zero){ SetTopmost $h } }')
    }
    // Assert at handle creation and again on a fast tick. The first assertion
    // can be too early — under ShowDialog the form is shown before its style
    // settles — so the timer is what makes the state durable rather than a
    // one-shot race. 250ms bounds how long a covered card can stay covered.
    //
    // This is ALSO where the closing timer and the repaint ticker are started,
    // and starting them here is the whole fix for "the card never disappears":
    // a System.Windows.Forms.Timer is created STOPPED and does nothing until
    // Start() is called. The closing timer was built, given a Close handler and
    // an interval — and never started — so a card that was supposed to leave
    // after 10s sat on screen forever, and the countdown hairline never moved
    // because the repaint ticker was never started either. Shown is the right
    // place: the card is on screen, so the timeout is charged against visible
    // time (not PowerShell startup) and the bar begins draining from the moment
    // the user can see it. `$topmost` is started at creation because z-order
    // does not care when the clock started.
    //
    // A wait-forever card (popupTimeoutMs=0) starts NEITHER timer: its interval
    // is parked at int.MaxValue, so starting it would be a no-op today, but a
    // parked timer that is running is one edit away from a card that closes
    // itself the moment someone changes the sentinel. Leaving it stopped keeps
    // "no timeout" meaning no clock at all.
    if (timeoutMs > 0) {
      lines.push('$f.Add_Shown({ SetTopmost $f.Handle; $timer.Start(); if($script:tickr){ $script:tickr.Start() } })')
    } else {
      lines.push('$f.Add_Shown({ SetTopmost $f.Handle })')
    }
    // Application::Run activates the form, which steals the foreground from
    // whatever the user was doing — the one thing a notifier must never do.
    // (ShowDialog did not activate, but it also destroyed the card: see the note
    // at Application::Run.) The fix is to hand the foreground straight back to
    // the window that had it. This runs on the very next tick after the card is
    // up, so the steal is never perceptible, and it is skipped entirely when the
    // card is already foreground (nothing to restore).
    // The foreground is never taken in the first place (QuietCard's
    // ShowWithoutActivation + CreateParams), so there is no focus to hand back.
    // An earlier revision tried to restore it after the fact with
    // SetForegroundWindow; that only papered over the activation, and it could
    // not work anyway because the child's own console had already taken the
    // foreground before the card was ever created.
    lines.push('$topmost=New-Object System.Windows.Forms.Timer')
    lines.push('$topmost.Interval=250')
    lines.push('$topmost.add_Tick({ AssertTop $f.Handle })')
    lines.push('$topmost.Start()')
    // Esc closes the card. Without this the only way to dismiss a card that
    // refuses to time out is to click it, which raises the harness window.
    lines.push('$f.KeyPreview=$true')
    lines.push("$f.Add_KeyDown({ if($_.KeyCode -eq 'Escape'){ $f.Close() } })")
    // Application::Run, deliberately NOT ShowDialog.
    //
    // This was measured, not preferred: with WS_EX_TOOLWINDOW set, ShowDialog's
    // modal loop collapses immediately — the form is created, shown, and the
    // call returns DialogResult=Cancel within ~10ms, so the card either never
    // paints or flashes once. Measured lifetimes on this machine, same script,
    // only the style bits differing:
    //
    //     plain ShowDialog                       2547ms  (waits for the timer)
    //     +WS_EX_TOOLWINDOW                        96ms  (collapses)
    //     +WS_EX_TOOLWINDOW +WS_EX_NOACTIVATE       11ms  (collapses harder)
    //
    // TOOLWINDOW is not negotiable — it is what makes the card un-buryable and
    // keeps it out of the taskbar/alt-tab — so the modal loop had to go instead.
    // Application::Run pumps normally with those styles set (verified: the form
    // lives its full timeout and closes with DialogResult=None), which is what
    // the card actually needs. Nothing here depends on a modal result.
    lines.push('[System.Windows.Forms.Application]::Run($f)')
  }

  return lines.join('\n')
}

/** Append one JSON line, rotating the file when it outgrows its cap. */
export function record(cfg, entry) {
  const file = cfg.logFile === '' ? undefined : (cfg.logFile ?? DEFAULT_LOG)
  if (file === undefined) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > LOG_MAX_BYTES) truncateSync(file, 0)
    } catch {
      /* the file does not exist yet */
    }
    appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch {
    /* logging must never break delivery */
  }
}

export function ring(cfg, title, body, logger, tone = 'ok') {
  const channels = { sound: Boolean(cfg.sound), popup: Boolean(cfg.popup), balloon: Boolean(cfg.balloon), box: Boolean(cfg.box) }
  const active = Object.keys(channels).filter((key) => channels[key])
  if (active.length === 0) {
    record(cfg, { event: 'skipped', title, body, tone, reason: 'all channels off' })
    return false
  }

  const script = buildScript(cfg, title, body, tone)
  const spawnImpl = cfg.spawn ?? spawn
  try {
    // The script travels through a FILE, not -EncodedCommand.
    //
    // -EncodedCommand puts the whole base64 script on the command line, and once
    // the card grew a real GDI+ painter plus the whale outline the payload
    // crossed the Windows command-line limit: spawn failed with ENAMETOOLONG and
    // the notifier went completely silent. A file has no such ceiling.
    //
    // The file is written as UTF-8 with a BOM and read back with
    // -EncodedCommand's sibling, -File. UTF-8 matters: the script body is pure
    // ASCII by design (see buildScript), so any encoding round-trips, but the
    // BOM is what makes Windows PowerShell 5.1 open it as UTF-8 rather than ANSI.
    const dir = join(tmpdir(), 'dsh-attention')
    mkdirSync(dir, { recursive: true })
    const scriptFile = join(dir, `card-${process.pid}-${Date.now()}.ps1`)
    // The child deletes its own script when it finishes. Doing it from here would
    // race the child's own read of the file, and a crash on our side must not
    // leave a growing pile of temp scripts behind.
    const wrapped = `${script}\nRemove-Item -LiteralPath '${scriptFile.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue`
    writeFileSync(scriptFile, `\ufeff${wrapped}`, 'utf8')

    const child = spawnImpl(
      cfg.powershell,
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
      { stdio: 'ignore', windowsHide: true },
    )
    child.on?.('spawn', () => {
      record(cfg, { event: 'ring', title, body, tone, channels: active, pid: child.pid })
    })
    child.on?.('error', (error) => {
      record(cfg, { event: 'error', title, body, tone, channels: active, error: String(error) })
      logger?.warn?.(`attention: notify process failed: ${String(error)}`)
    })
    // Deliberately NOT detached. A detached child gets no console and, measured
    // on this machine, exits 0 without ever executing: spawn reports success,
    // the log records a ring, and nothing reaches the screen. Detaching was
    // meant to keep the child from holding the parent open, but the popup
    // closes itself on a timer, so an attached child is safe and actually runs.
    return true
  } catch (error) {
    record(cfg, { event: 'error', title, body, tone, channels: active, error: String(error) })
    logger?.warn?.(`attention: could not ring: ${String(error)}`)
    return false
  }
}
