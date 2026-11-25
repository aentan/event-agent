# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Attends online events while the user sleeps. A Claude session registers for a
Luma event (`.claude/skills/attend-event/`); a launchd heartbeat then polls Luma
for approval and the join link, joins in Zoom at start time, records Zoom's
windows and audio, and leaves `recordings/<slug>/<slug>.mp4`.

## Commands

```sh
node bin/ea.mjs add <luma-url>        # track an event you registered for
node bin/ea.mjs status [slug]         # refresh approval + join link from Luma
node bin/ea.mjs list | show <slug>
node bin/ea.mjs set <slug> k=v …      # join_url_override, join_redirect, official_recording…
node bin/ea.mjs doctor                # pre-flight; does a 2s silent capture (see below)
node bin/ea.mjs tick                  # what launchd runs every 2 min
node bin/ea.mjs attend <slug>         # join + record now (tick spawns this)
node bin/ea.mjs subtitle <slug|file> [--srt-only]  # transcribe locally; add a soft track + .srt, or only the .srt
node bin/ea.mjs clean-srt <video> <srt>  # drop hallucinated cues from an existing .srt
node bin/ea.mjs trim <file>           # cut a silent tail >60s down to 10s
node bin/ea.mjs silence <file> [N]    # debug: trailing silence in the last N seconds
node bin/ea.mjs install | uninstall   # the launchd heartbeat
node bin/ea.mjs login                 # sign in to Luma in the agent's Chrome profile
./rec/build.sh                        # rebuild EventRecorder.app — read the next section first
```

There is no test suite. Test the recorder with short captures into `tmp/`
(gitignored), and the scheduler with a throwaway `events/<slug>.json` whose
`start_at` is now and whose `join_url_override` is Zoom's test meeting.

## The Screen Recording grant is the fragile part

`bin/EventRecorder.app` is **ad-hoc signed**, so macOS pins its Screen Recording
grant to the binary's exact cdhash.

- **Rebuilding invalidates the grant.** Toggling the switch in System Settings,
  or re-adding the app with +, does *not* refresh it — the entry keeps the old
  cdhash and every capture fails with "The user declined TCCs". The only fix is
  `tccutil reset ScreenCapture com.aen.event-agent.recorder`, then launching the
  app once and approving the fresh prompt (Open System Settings → switch on →
  Touch ID). Auto mode blocks Claude from running `tccutil`; the user must.
- Don't rebuild unless the change is worth a re-grant, and say so up front.
- **Always launch it through LaunchServices** (`open -n -a EventRecorder.app`).
  Run the inner binary directly and macOS attributes capture to the parent
  process (the Claude CLI, which has no grant).
- An iTerm fallback exists in `launchRecorder()` (iTerm holds its own grant). It
  works from an interactive shell but **iTerm never runs the script when
  launched from launchd**, so do not rely on it overnight.
- `doctor` triggers macOS's permission prompt if the grant is missing. Don't run
  it while the user is presenting or in a call.

## The recorder (`rec/screenrec.swift`)

ScreenCaptureKit → `AVAssetWriter`. The content filter is
`SCContentFilter(display:including:[app])`, so only the target app's windows
and *its own* audio are captured — the mic never is, and muting the Mac's
output doesn't affect the recording.

- Output is a **fragmented `.mov`** (`movieFragmentInterval` 5s). A killed or
  crashed recorder leaves a file playable to the last fragment, and ffmpeg can
  read it while it's still being written — the launcher relies on that.
- The first version used `SCRecordingOutput`; removing it on stop sometimes
  produced a file with no `moov` atom, and stopping could hang forever. Don't go
  back to it.
- `stop()` hard-exits after 10s whatever happens. The launcher still kills a
  recorder that outlives a terminal log event by 15s.
- Idle frames (`SCFrameStatus.idle`) are skipped, so static slides cost
  almost nothing; a 2h event is ~2 GB at 1920 wide.

## When the recording stops

1. Audio: after the scheduled end, once the last 3 min are silent (below
   −45 dB). `attend()` probes the growing file every minute.
2. Hard stop at scheduled end + 90 min (`EA_OVERRUN_MIN`).
3. `finalize()` concatenates chunks (`-c copy`) and `trimTail()` cuts any
   trailing silence over a minute down to 10s.

Window-title detection exists in the recorder (`--window-title`) but the
launcher no longer passes it: Luma hands out `/j/` links for Zoom *webinars*,
so the window title can't be predicted. The first real run (2026-11-25) never
matched "Meeting", hit the old 30-min overrun, and cut the event's Q&A off.

## Subtitles

`subtitle()` extracts 16 kHz mono audio, runs `whisper-cli` (Homebrew
`whisper-cpp`, Metal) with `ggml-large-v3-turbo.bin` from
`~/.event-agent/models/` (override with `EA_WHISPER_MODEL`), then muxes the
`.srt` in as a `mov_text` track with `-c copy` — soft, never burned in, and the
`.srt` stays beside the MP4. `attend()` runs it after saving the recording when
both the binary and the model exist; a failure there is logged, never fatal.
The 16 kHz WAV and whisper's output are written under `tmp/` and only the
finished `.srt` is copied next to the video — recordings get moved into synced
folders (Google Drive), and a half-written file there syncs to everyone.
`--srt-only` leaves the video untouched; use it for files on shared drives.
About 3 s per minute of audio on an M4 Pro (a 2h event takes ~6 min).

Whisper hallucinates in two ways on long recordings, both seen on the first
real run: text "heard" in silence ("Thank you." every 30s over a waiting
screen) and loops (one sentence repeated for a minute, hiding the real speech).
`-mc 0` stops the loops at the source — it also costs some capitalisation and
punctuation in places, which is the trade. `cleanSrt()` then drops cues that
lie >80% inside an ffmpeg-detected silence and collapses back-to-back
duplicates. `ea clean-srt <video> <srt>` re-cleans an existing transcript.
The model is 1.6 GB and lives outside the repo.

## Luma

- No attendee API. `lib/luma.mjs` drives a Playwright Chrome on a dedicated
  profile (`~/.event-agent/chrome-profile`, launched with `--use-mock-keychain`)
  and calls `api2.luma.com/event/get` from inside a luma.com page so the
  session cookie applies. `guest_data.approval_status` and
  `event.virtual_info.raw_join_url` / `zoom_id` are the useful fields.
- The host often sets the link late ("The host will provide the join link
  later"). The guest's personal `luma.com/join/g-…` link from the approval
  email 307-redirects to the meeting once set; store it as `join_redirect`.
- Chrome launched outside Playwright on that profile must also pass
  `--use-mock-keychain --password-store=basic`, or the cookies won't decrypt.

## Zoom

Joined via `zoommtg://<host>/join?action=join&confno=…&pwd=…&uname=…` so no
browser prompt intervenes. The run depends on Zoom's own settings, which were
set once by hand: no video preview, camera off, mic muted, auto-connect
computer audio, enter full screen automatically. The "Not hearing anything?"
banner in recordings comes from muting the output and is harmless.

## Privacy

`profile.json` (registration answers), `events/` (personal join keys, meeting
passcodes), `logs/`, `recordings/` and `tmp/` are gitignored. Keep it that way.

## Working with the user

Warn before anything visible or audible on their Mac — opening Zoom, `say`,
iTerm windows, System Settings, permission prompts. They may be in a meeting.
