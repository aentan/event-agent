---
name: attend-event
description: Register for an online event from its Luma link, then hand it to the local event-agent scheduler, which joins it in Zoom (or Chrome) at start time, records it, and saves an MP4. Use when the user pastes a luma.com / lu.ma event link and wants to attend, register, record, or "catch" it, especially at an inconvenient hour.
---

# Attend an event for the user

Everything runs from `/Users/aen/repos/event-agent`. `node bin/ea.mjs` is the CLI (`ea` below).

## 1. Read the event

```sh
curl -sL -A "Mozilla/5.0 (Macintosh) Chrome/131" "<URL>" | python3 -I -c "import sys,re,json;h=sys.stdin.read();d=json.loads(re.search(r'<script id=\"__NEXT_DATA__\"[^>]*>(.*?)</script>',h,re.S).group(1))['props']['pageProps']['initialData']['data'];print(json.dumps({k:d.get(k) for k in ['registration_questions','ticket_info','ticket_types','start_at']} | {'event':{k:d['event'][k] for k in ['name','start_at','end_at','timezone','location_type']}},indent=1))"
```

Tell the user, in their timezone (Asia/Singapore unless told otherwise): name, start/end, whether approval is required, whether the description says it will be recorded and for whom.

## 2. Register (the user's request to attend authorises this one submission)

- Use the built-in browser pane; it is signed in to Luma as the user. If it shows "Sign In", ask the user to sign in there themselves — never type codes or passwords.
- Choose the free/standard ticket unless the user said otherwise.
- Answer questions from `profile.json` (`answers`). Opt-ins to marketing: always the profile's choice. Any **required** question the profile does not cover: ask the user once, then add the answer to `profile.json` if it is reusable.
- Comboboxes on Luma: click the field, type the option text, press Enter; verify values with JS before submitting.
- After submitting, expect "You're In" or "Registration Pending".

## 3. Hand it to the scheduler

```sh
node bin/ea.mjs add "<URL>"
```

Then look in Gmail (Luma emails come from `*@calendar.luma-mail.com` to the address Luma has for the user) for the approval/confirmation email. It contains a personal `https://luma.com/join/g-…` link; record it — the scheduler resolves it to the meeting link at start time:

```sh
node bin/ea.mjs set <slug> join_redirect=https://luma.com/join/g-…
```

If the host emails a direct meeting link (Zoom/Meet/YouTube), record it with `join_url_override='<url>'`.

## 4. Pre-flight

`node bin/ea.mjs doctor` — checks the recorder's Screen Recording permission (it does a 2-second silent capture; **do not run it while the user is in a meeting or presenting**, and never more than once per session), Luma session, heartbeat, sleep settings. If the recorder check fails, the user must turn EventRecorder on in System Settings › Privacy & Security › Screen & System Audio Recording — the grant belongs to the exact build, so **never rebuild `bin/EventRecorder.app`** unless the user agrees to re-grant.

## 5. What happens unattended

The launchd heartbeat (`ea tick`, every 2 min) polls Luma for approval and the join link, joins 2 minutes before start (Zoom via `zoommtg://` with camera off, mic muted, speakers muted, computer audio on), records the Zoom app's window and sound only, stops once the audio has been silent for 3 min after the scheduled end (or 90 min past it), then saves `recordings/<slug>/<slug>.mp4`, trims any silent tail and posts a macOS notification.

## 6. After the event

- `node bin/ea.mjs show <slug>` → `recording_file`. Check it with `ffprobe` (duration close to the event length, an audio stream).
- Look for an official recording: follow-up emails from the host, the Luma event page, the host calendar's YouTube channel (`youtube_handle` in the event file). Record it with `ea set <slug> official_recording=<url>`. Some hosts restrict recordings (e.g. to paid ticket holders); say so rather than hunting further.
- Report to the user: where the file is, its length, and any official link.

## Limits worth telling the user

- The Mac must be on, awake (SleepDisabled is set) and **not locked into the login screen** — window capture of a locked session is unverified.
- Hosts with a waiting room must admit the guest; the recording shows the waiting screen until then.
- Google Meet joins need the agent's Chrome profile (`~/.event-agent/chrome-profile`) signed in to Google; not set up yet.
