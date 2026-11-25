# event-agent

Attend online events in bad timezones without being awake. Give Claude a Luma
link (`/attend-event <url>` in a Claude Code session in this folder); it
registers you, and a local scheduler joins the event at start time, records it,
and leaves an MP4 in `recordings/`.

| Piece | What it does |
| --- | --- |
| `.claude/skills/attend-event/` | The agent part: reads the event, fills the registration form from `profile.json`, asks only for new required answers, wires up the join link |
| `bin/ea.mjs` | CLI and scheduler: `add`, `status`, `list`, `show`, `set`, `doctor`, `tick`, `attend`, `install` |
| `lib/luma.mjs` | Reads approval status and join links through Luma's own web API, signed in via a dedicated Chrome profile (`~/.event-agent/chrome-profile`) |
| `rec/screenrec.swift` → `bin/EventRecorder.app` | ScreenCaptureKit recorder: one app's windows + that app's audio only, fragmented `.mov` that survives a crash |
| `~/Library/LaunchAgents/com.aen.event-agent.tick.plist` | Runs `ea tick` every 2 minutes |

## Overnight sequence

1. Every 15 min (every 2 min from 90 min before start): refresh approval and join link.
   Join-link sources: Luma's `virtual_info`, the "Join" button, and your personal
   `luma.com/join/…` redirect from the approval email.
2. 2 min before start: mute speakers, `caffeinate`, open the meeting (Zoom via
   `zoommtg://`, anything else in the agent's Chrome profile), start recording.
3. Stop once the audio has been silent for 3 min after the scheduled end, or
   90 min past it at the latest. Quit Zoom, restore volume, stitch to
   `recordings/<slug>/<slug>.mp4`, trim any silent tail, notify.
4. Transcribe locally with whisper.cpp and add the result as a soft subtitle
   track (plus a `.srt` beside the video). Needs `brew install whisper-cpp` and
   `ggml-large-v3-turbo.bin` in `~/.event-agent/models/`.

## Setup that is already done

- Zoom: no video preview, camera off and mic muted on join, auto-connect computer audio, full screen on join.
- Luma signed in, in both the Claude browser pane and the agent's Chrome profile.
- System sleep disabled (`pmset SleepDisabled 1`).

## Gotchas

- **Never rebuild `bin/EventRecorder.app` casually.** It is ad-hoc signed, so macOS
  ties the Screen Recording grant to the exact binary. Toggling or re-adding the
  entry in System Settings does *not* update it — the old binary's grant sticks.
  After a rebuild, clear it and approve the fresh prompt:
  `tccutil reset ScreenCapture com.aen.event-agent.recorder`, then
  `open -n -a bin/EventRecorder.app --args --out tmp/doctor --max 2` and click
  Open System Settings → switch it on → confirm with Touch ID.
- `ea doctor` does a 2-second silent capture to test that grant — macOS shows a
  permission prompt if it is missing. Don't run it while presenting.
- A locked screen is untested; leave the Mac unlocked (display can sleep only if
  `caffeinate -d` is overridden — it isn't).
