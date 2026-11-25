#!/usr/bin/env node
// event-agent — attend online events you registered for, while you sleep.
//
//   ea login              sign in to Luma in the agent's own Chrome profile (once)
//   ea add <luma-url>     track an event you have registered for (or requested to join)
//   ea status [slug]      refresh approval status and join link from Luma
//   ea list               show tracked events
//   ea show <slug>        print one event's state
//   ea set <slug> k=v …   record a field (join_url_override, join_redirect, official_recording…)
//   ea doctor             silent pre-flight: recorder permission, Luma session, heartbeat
//   ea subtitle <slug|file> [--srt-only]  transcribe locally (whisper.cpp); add a soft subtitle track, or just write a .srt
//   ea tick               the scheduler's heartbeat (launchd runs it every 2 min)
//   ea attend <slug>      join now and record until the event ends (tick calls this)
//   ea install|uninstall  add/remove the launchd heartbeat
//
// State lives in events/<slug>.json; recordings in recordings/<slug>/.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, openSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventStatus, findMeetingUrls, login, slugFromUrl, PROFILE } from "../lib/luma.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EVENTS = join(ROOT, "events");
const RECS = join(ROOT, "recordings");
const LOGS = join(ROOT, "logs");
const RECORDER = join(ROOT, "bin", "EventRecorder.app");
const LABEL = "com.aen.event-agent.tick";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
for (const d of [EVENTS, RECS, LOGS]) mkdirSync(d, { recursive: true });

const MIN = 60_000;
const JOIN_EARLY = 2 * MIN; // join this long before start
const OVERRUN = Number(process.env.EA_OVERRUN_MIN ?? 90) * MIN; // hard stop this long past the scheduled end
const SILENCE_DB = -45; // quieter than this counts as silence
const SILENT_FOR = 3 * MIN; // after the scheduled end, this much continuous silence means it's over
const TAIL_KEEP = 10; // seconds of silence left on the end after trimming
const CHUNK_SECONDS = 4 * 3600; // one recorder for the whole event; a new chunk only if it dies

// ---------- small helpers ----------

const now = () => Date.now();
const iso = (t = now()) => new Date(t).toISOString();
const profile = () => {
  const p = join(ROOT, "profile.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
};
const evPath = (slug) => join(EVENTS, `${slug}.json`);
const load = (slug) => JSON.parse(readFileSync(evPath(slug), "utf8"));
const save = (ev) => writeFileSync(evPath(ev.slug), JSON.stringify(ev, null, 2) + "\n");
const allEvents = () =>
  readdirSync(EVENTS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => load(f.slice(0, -5)));

function log(slug, msg) {
  const line = `${iso()} ${msg}\n`;
  appendFileSync(join(LOGS, `${slug}.log`), line);
  process.stdout.write(`[${slug}] ${line}`);
}

function note(ev, msg) {
  ev.history = [...(ev.history || []), `${iso()} ${msg}`].slice(-50);
  log(ev.slug, msg);
}

function notify(title, body) {
  spawnSync("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---------- Luma ----------

async function refresh(ev) {
  const s = await eventStatus(ev.url);
  const before = ev.approval_status;
  Object.assign(ev, {
    api_id: s.api_id,
    name: s.name,
    start_at: s.start_at,
    end_at: s.end_at,
    timezone: s.timezone,
    approval_status: s.approval_status,
    registered: s.registered,
    hosts: s.hosts,
    calendar: s.calendar,
    youtube_handle: s.youtube_handle,
    last_checked: iso(),
  });
  const vi = s.virtual_info || {};
  if (vi.zoom_id) s.join_urls.push(`https://zoom.us/j/${vi.zoom_id}${vi.password ? `?pwd=${encodeURIComponent(vi.password)}` : ""}`);
  // The guest's personal luma.com/join/<key> link (from the approval email)
  // forwards to the meeting once the host has set it.
  if (ev.join_redirect) {
    try {
      const r = await fetch(ev.join_redirect, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/131" } });
      const loc = r.headers.get("location") || "";
      s.join_urls.push(...findMeetingUrls([loc]));
    } catch (e) {
      note(ev, `join redirect check failed: ${e.message}`);
    }
  }
  s.join_urls = [...new Set(s.join_urls)];
  if (s.join_urls.length && JSON.stringify(s.join_urls) !== JSON.stringify(ev.join_urls)) {
    ev.join_urls = s.join_urls;
    note(ev, `join link(s) found: ${s.join_urls.join(" ")}`);
  }
  if (before !== s.approval_status) {
    note(ev, `approval: ${before} -> ${s.approval_status}`);
    if (s.approval_status === "approved") notify("Event approved", `${s.name}: you're in. It will be recorded.`);
    if (s.approval_status === "declined") notify("Event declined", `${s.name}: the host declined the request.`);
  }
  if (!s.registered) note(ev, "warning: Luma shows no registration for the agent's signed-in account");
  return ev;
}

// ---------- joining ----------

function pickJoinUrl(ev) {
  if (ev.join_url_override) return ev.join_url_override;
  const urls = ev.join_urls || [];
  const rank = (u) =>
    /zoom\.us\/(j|w|s|wc)\//.test(u) ? 0 : /meet\.google/.test(u) ? 1 : /teams\./.test(u) ? 2 : /youtu/.test(u) ? 3 : 4;
  return [...urls].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Turns a Zoom web link into a zoommtg:// deep link so the app joins without a browser prompt. */
export function zoomDeepLink(url, name) {
  const u = new URL(url);
  const m = u.pathname.match(/\/(?:j|w|s|wc\/join)\/(\d+)/);
  if (!m) return null;
  const q = new URLSearchParams({ action: "join", confno: m[1] });
  for (const k of ["pwd", "tk", "uuid"]) if (u.searchParams.get(k)) q.set(k, u.searchParams.get(k));
  if (name) q.set("uname", name);
  return `zoommtg://${u.host}/join?${q}`;
}

function openMeeting(url, ev) {
  if (/zoom\.us/.test(url)) {
    const deep = zoomDeepLink(url, profile().display_name);
    if (deep) {
      execFileSync("open", [deep]);
      // No windowTitle: Luma hands out /j/ links for webinars too, so the title
      // ("Zoom Meeting" vs "Zoom Webinar") can't be predicted. The end is
      // detected from the audio instead (see attend()).
      return { app: "us.zoom.xos", quit: () => quitZoom() };
    }
  }
  // Anything else: a separate Chrome instance on the agent's profile, so the
  // recorder can target its process and nothing of yours ends up in the video.
  execFileSync("open", [
    "-na",
    "Google Chrome",
    "--args",
    `--user-data-dir=${PROFILE}`,
    // Same cookie storage as the Playwright launches, or the Luma login won't decrypt.
    "--use-mock-keychain",
    "--password-store=basic",
    "--new-window",
    "--start-maximized",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=MediaSessionService",
    url,
  ]);
  return {
    pid: () => chromePid(),
    quit: () => {
      const pid = chromePid();
      if (pid) process.kill(pid, "SIGTERM");
    },
  };
}

function chromePid() {
  const out = spawnSync("pgrep", ["-f", `user-data-dir=${PROFILE}`], { encoding: "utf8" }).stdout;
  for (const pid of out.split("\n").filter(Boolean)) {
    const cmd = spawnSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).stdout;
    if (!cmd.includes("--type=")) return Number(pid);
  }
  return null;
}

function quitZoom() {
  spawnSync("osascript", ["-e", 'tell application "zoom.us" to quit']);
  setTimeout(() => spawnSync("pkill", ["-x", "zoom.us"]), 5000);
}

// ---------- recording ----------

const RECORDER_BIN = join(RECORDER, "Contents", "MacOS", "screenrec");

/**
 * Starts screenrec so that macOS grants it Screen Recording. First as
 * EventRecorder.app (LaunchServices attributes capture to the bundle). If macOS
 * refuses — its grant is pinned to an exact ad-hoc build and can go stale on a
 * rebuild — fall back to launching it from iTerm, which holds its own grant.
 */
async function launchRecorder(dir, logf, args) {
  let text = "";
  {
    execFileSync("open", ["-n", "-a", RECORDER, "--stdout", logf, "--stderr", logf, "--args", ...args]);
    await sleep(4000);
    text = existsSync(logf) ? readFileSync(logf, "utf8") : "";
    if (!/declined TCC/i.test(text)) return "app";
  }
  const q = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
  const script = join(dir, "run-recorder.command");
  writeFileSync(script, `#!/bin/zsh\nexec ${q(RECORDER_BIN)} ${args.map(q).join(" ")} >> ${q(logf)} 2>&1\n`, { mode: 0o755 });
  writeFileSync(logf, text + '{"event":"fallback","via":"iTerm"}\n');
  execFileSync("open", ["-a", "iTerm", script]);
  await sleep(5000);
  return "iterm";
}

function recorderRunning(dir) {
  return spawnSync("pgrep", ["-f", `EventRecorder.app/Contents/MacOS/screenrec --out ${dir}`]).status === 0;
}

async function recordChunk(dir, target, seconds, stopWhen = () => false) {
  mkdirSync(dir, { recursive: true });
  const logf = join(dir, "recorder.log");
  const args = ["--out", dir, "--max", String(Math.max(30, Math.round(seconds)))];
  if (target.app) args.push("--app", target.app);
  if (target.pid) args.push("--pid", String(target.pid));
  if (target.windowTitle) args.push("--window-title", target.windowTitle, "--gone-after", "180");
  await launchRecorder(dir, logf, args);
  // Safety net: screenrec hard-exits within 10s of stopping, and its fragmented
  // file survives a kill, so if it is still around after a terminal event (or
  // well past --max) it is safe to kill.
  const startedAt = now();
  let doneSince = null;
  let lastProbe = 0;
  while (recorderRunning(dir)) {
    if (now() - lastProbe > 60_000) {
      lastProbe = now();
      if (stopWhen(join(dir, "rec.mov"))) {
        spawnSync("pkill", ["-TERM", "-f", `EventRecorder.app/Contents/MacOS/screenrec --out ${dir}`]);
      }
    }
    const text = existsSync(logf) ? readFileSync(logf, "utf8") : "";
    const finished = /"event":"(stopped|max_reached|window_gone|stream_error|writer_failed|fatal)"/.test(text);
    const overran = now() - startedAt > (seconds + 30) * 1000;
    if (finished || overran) {
      doneSince ??= now();
      if (now() - doneSince > 15000) {
        spawnSync("pkill", ["-9", "-f", `EventRecorder.app/Contents/MacOS/screenrec --out ${dir}`]);
        break;
      }
    }
    await sleep(2000);
  }
  const lines = existsSync(logf) ? readFileSync(logf, "utf8").trim().split("\n") : [];
  const events = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { event: "raw", line: l };
    }
  });
  return {
    windowGone: events.some((e) => e.event === "window_gone"),
    fatal: events.find((e) => e.event === "fatal")?.error,
    streamError: events.find((e) => e.event === "stream_error")?.error,
    windowSeen: events.some((e) => e.event === "window_seen"),
  };
}

/**
 * Silent stretches in a file's audio, via ffmpeg's silencedetect. Works on the
 * recorder's in-progress fragmented .mov too. `fromEnd` limits the scan to the
 * last N seconds. Returns { duration, silences: [{start, end|null}] } in file time.
 */
function silences(file, { fromEnd } = {}) {
  const dur = Number(
    spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout,
  );
  if (!dur) return { duration: 0, silences: [] };
  const offset = fromEnd ? Math.max(0, dur - fromEnd) : 0;
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-ss", String(offset), "-i", file, "-vn", "-af", `silencedetect=noise=${SILENCE_DB}dB:d=5`, "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const out = [];
  for (const line of r.stderr.split("\n")) {
    const st = line.match(/silence_start: ([\d.]+)/);
    const en = line.match(/silence_end: ([\d.]+)/);
    if (st) out.push({ start: offset + Number(st[1]), end: null });
    if (en && out.length) out[out.length - 1].end = offset + Number(en[1]);
  }
  return { duration: dur, silences: out };
}

/** Seconds of silence running up to the end of the file (0 if it ends with sound). */
function trailingSilence(file, { fromEnd } = {}) {
  const { duration, silences: s } = silences(file, { fromEnd });
  const last = s[s.length - 1];
  // ffmpeg closes a silence that runs to EOF with a silence_end at EOF.
  const toEof = last && (last.end === null || last.end >= duration - 1);
  return toEof ? { seconds: duration - last.start, startsAt: last.start, duration } : { seconds: 0, duration };
}

/** Cuts a silent tail longer than a minute down to TAIL_KEEP seconds, without re-encoding. */
export function trimTail(file) {
  const t = trailingSilence(file);
  if (t.seconds < 60) return 0;
  const keep = t.startsAt + TAIL_KEEP;
  const tmp = file.replace(/(\.\w+)$/, ".trim$1");
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-t", keep.toFixed(2), "-c", "copy", "-movflags", "+faststart", tmp]);
  if (r.status !== 0) return 0;
  rmSync(file);
  execFileSync("mv", [tmp, file]);
  return t.duration - keep;
}

function finalize(ev, dir) {
  const parts = readdirSync(dir)
    .filter((d) => d.startsWith("chunk-"))
    .sort()
    .flatMap((d) =>
      readdirSync(join(dir, d))
        .filter((f) => /\.(mov|mp4)$/.test(f))
        .sort()
        .map((f) => join(dir, d, f)),
    )
    .filter((f) => spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", f]).status === 0);
  if (!parts.length) return null;
  const list = join(dir, "parts.txt");
  writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n") + "\n");
  const out = join(dir, `${ev.slug}.mp4`);
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
  if (r.status !== 0) {
    note(ev, `concat failed (${String(r.stderr).trim().slice(0, 200)}); chunks kept in ${dir}`);
    return parts[0];
  }
  for (const d of readdirSync(dir).filter((d) => d.startsWith("chunk-"))) {
    for (const f of readdirSync(join(dir, d)).filter((f) => /\.(mov|mp4)$/.test(f))) rmSync(join(dir, d, f));
  }
  const cut = trimTail(out);
  if (cut) note(ev, `trimmed ${Math.round(cut / 60)} min of silence off the end`);
  return out;
}

// ---------- subtitles ----------

const srtTime = (t) => {
  const [h, m, rest] = t.trim().split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(rest.replace(",", "."));
};

/**
 * Removes Whisper's two habitual hallucinations: text "heard" in silence
 * (cues mostly inside a detected silent stretch — "Thank you." over a waiting
 * screen) and loops (the same line repeated back-to-back). Renumbers the rest.
 */
export function cleanSrt(text, silent = []) {
  const cues = text
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((b) => b.trim().split("\n"))
    .filter((l) => l.length >= 3 && l[1].includes("-->"))
    .map((l) => {
      const [a, b] = l[1].split("-->");
      return { start: srtTime(a), end: srtTime(b), time: l[1], text: l.slice(2).join("\n").trim() };
    });
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const kept = [];
  for (const c of cues) {
    const len = Math.max(0.001, c.end - c.start);
    const quiet = silent.reduce(
      (acc, s) => acc + Math.max(0, Math.min(c.end, s.end ?? Infinity) - Math.max(c.start, s.start)),
      0,
    );
    if (quiet / len > 0.8) continue;
    const prev = kept[kept.length - 1];
    if (prev && norm(prev.text) === norm(c.text) && c.start - prev.end < 30) continue;
    if (!norm(c.text)) continue;
    kept.push(c);
  }
  const out = kept.map((c, i) => `${i + 1}\n${c.time}\n${c.text}\n`).join("\n");
  return { text: out, dropped: cues.length - kept.length };
}

const WHISPER_MODEL =
  process.env.EA_WHISPER_MODEL || join(homedir(), ".event-agent", "models", "ggml-large-v3-turbo.bin");

function subtitlesAvailable() {
  return spawnSync("which", ["whisper-cli"]).status === 0 && existsSync(WHISPER_MODEL);
}

/**
 * Transcribes a recording locally with whisper.cpp and adds the result as a
 * soft (toggleable) English subtitle track, plus a .srt beside the file. Video
 * and audio are copied, not re-encoded. Returns the .srt path.
 */
function subtitle(file, { lang = "en", srtOnly = false } = {}) {
  if (!subtitlesAvailable()) {
    throw new Error(`needs whisper-cli (brew install whisper-cpp) and the model at ${WHISPER_MODEL}`);
  }
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  const base = file.replace(/\.\w+$/, "");
  // Scratch files stay local: the recording may sit in a synced folder.
  const work = join(ROOT, "tmp", `subtitle-${process.pid}`);
  mkdirSync(work, { recursive: true });
  const wav = join(work, "audio.16k.wav");
  // whisper.cpp wants 16 kHz mono PCM.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  try {
    execFileSync(
      "whisper-cli",
      // -mc 0: don't feed previous text back in as context — that is what lets
      // Whisper fall into "same sentence forever" loops on long recordings.
      ["-m", WHISPER_MODEL, "-f", wav, "-l", lang, "-osrt", "-of", join(work, "transcript"), "-ml", "84", "-sow", "-mc", "0", "-np", "-t", "8"],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  } finally {
    rmSync(wav, { force: true });
  }
  if (!existsSync(join(work, "transcript.srt"))) throw new Error("whisper-cli produced no .srt");
  const srt = `${base}.srt`;
  const cleaned = cleanSrt(readFileSync(join(work, "transcript.srt"), "utf8"), silences(file).silences);
  writeFileSync(join(work, "clean.srt"), cleaned.text);
  if (cleaned.dropped) console.error(`dropped ${cleaned.dropped} hallucinated cue(s)`);
  execFileSync("cp", [join(work, "clean.srt"), srt]);
  rmSync(work, { recursive: true, force: true });
  if (srtOnly) return srt;
  const tmp = `${base}.subbed${file.match(/\.\w+$/)[0]}`;
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-i", file, "-i", srt,
    "-map", "0:v", "-map", "0:a", "-map", "1",
    "-c", "copy", "-c:s", "mov_text",
    "-metadata:s:s:0", `language=${lang === "en" ? "eng" : lang}`,
    "-metadata:s:s:0", "title=Transcript (Whisper)",
    "-movflags", "+faststart", tmp,
  ]);
  rmSync(file);
  execFileSync("mv", [tmp, file]);
  return srt;
}

async function attend(slug) {
  let ev = load(slug);
  const url = pickJoinUrl(ev);
  if (!url) throw new Error("no join link yet");
  const dir = join(RECS, slug);
  mkdirSync(dir, { recursive: true });
  const deadline = new Date(ev.end_at).getTime() + OVERRUN;

  const prevMuted = spawnSync("osascript", ["-e", "output muted of (get volume settings)"], { encoding: "utf8" }).stdout.trim();
  spawnSync("osascript", ["-e", "set volume with output muted"]); // the recorder still hears the app
  const caf = spawn("caffeinate", ["-dimsu"], { stdio: "ignore" });

  note(ev, `attending via ${url}`);
  ev.state = "attending";
  ev.recording_dir = dir;
  save(ev);

  try {
    const meeting = openMeeting(url, ev);
    await sleep(20_000); // let the app launch and join
    let chunk = 0;
    let sawMeeting = false;
    let endedBySilence = false;
    const end = new Date(ev.end_at).getTime();
    // After the scheduled end, stop once the event has gone quiet for SILENT_FOR.
    const quietAfterEnd = (file) => {
      if (now() < end + SILENT_FOR || !existsSync(file)) return false;
      const t = trailingSilence(file, { fromEnd: SILENT_FOR / 1000 + 30 });
      if (t.seconds * 1000 < SILENT_FOR) return false;
      endedBySilence = true;
      note(ev, `silent for ${Math.round(t.seconds / 60)} min after the scheduled end; event over`);
      return true;
    };
    while (now() < deadline && !endedBySilence) {
      chunk += 1;
      const target = { app: meeting.app, windowTitle: meeting.windowTitle, pid: meeting.pid?.() };
      const secs = Math.min(CHUNK_SECONDS, (deadline - now()) / 1000);
      const res = await recordChunk(join(dir, `chunk-${String(chunk).padStart(3, "0")}`), target, secs, quietAfterEnd);
      sawMeeting ||= res.windowSeen;
      if (res.fatal) {
        note(ev, `recorder: ${res.fatal}`);
        if (/declined/i.test(res.fatal)) {
          notify("Event recording failed", "EventRecorder lost Screen Recording permission.");
          break;
        }
        await sleep(10_000);
      }
      if (res.windowGone && sawMeeting) {
        note(ev, "meeting window closed; event over");
        break;
      }
    }
    meeting.quit?.();
  } finally {
    caf.kill();
    if (prevMuted === "false") spawnSync("osascript", ["-e", "set volume without output muted"]);
    ev = load(slug);
    const out = finalize(ev, dir);
    ev.state = out ? "recorded" : "failed";
    ev.recording_file = out;
    note(ev, out ? `recording saved: ${out}` : "no usable recording");
    save(ev);
    notify(out ? "Event recorded" : "Event recording failed", `${ev.name}${out ? "" : " — see logs"}`);
    if (out && subtitlesAvailable()) {
      try {
        note(ev, "transcribing for subtitles…");
        ev.subtitles = subtitle(out);
        note(ev, `subtitles added: ${ev.subtitles}`);
      } catch (e) {
        note(ev, `subtitles failed: ${e.message}`);
      }
      save(ev);
    }
  }
}

// ---------- scheduler ----------

async function tick() {
  for (let ev of allEvents()) {
    if (["recorded", "missed", "failed", "done", "cancelled"].includes(ev.state)) continue;
    const start = new Date(ev.start_at).getTime();
    const end = new Date(ev.end_at).getTime();
    const t = now();

    if (ev.state === "attending") {
      if (ev.attend_pid && alive(ev.attend_pid)) continue;
      note(ev, "attend process is gone; finalising");
      const out = finalize(ev, ev.recording_dir);
      ev.state = out ? "recorded" : "failed";
      ev.recording_file = out;
      save(ev);
      continue;
    }

    if (t > end + OVERRUN) {
      ev.state = "missed";
      note(ev, `missed: approval=${ev.approval_status}, join link=${pickJoinUrl(ev) ? "yes" : "no"}`);
      notify("Event missed", `${ev.name}: ${ev.approval_status !== "approved" ? "never approved" : "no join link"}`);
      save(ev);
      continue;
    }

    // Poll Luma: every 15 min normally, every tick from 90 min before start.
    const since = ev.last_checked ? t - new Date(ev.last_checked).getTime() : Infinity;
    const close = t > start - 90 * MIN;
    const needLink = ev.approval_status === "approved" && !pickJoinUrl(ev);
    if (since > 15 * MIN || (close && (since > 90_000 || needLink))) {
      try {
        ev = await refresh(ev);
      } catch (e) {
        note(ev, `status check failed: ${e.message}`);
      }
      save(ev);
    }

    if (t >= start - JOIN_EARLY && ev.approval_status === "approved") {
      if (!pickJoinUrl(ev)) {
        if (!ev.warned_no_link) {
          note(ev, "start time reached but no join link yet; still polling");
          ev.warned_no_link = true;
          save(ev);
        }
        continue;
      }
      const out = openSync(join(LOGS, `${ev.slug}.log`), "a");
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "attend", ev.slug], {
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
      ev.state = "attending";
      ev.attend_pid = child.pid;
      note(ev, `launched attend (pid ${child.pid})`);
      save(ev);
    } else if (t >= start && ev.approval_status !== "approved" && !ev.warned_unapproved) {
      ev.warned_unapproved = true;
      note(ev, `event started but approval is ${ev.approval_status}; will join if approved before it ends`);
      save(ev);
    }
  }
}

// ---------- health check ----------

/** Silent checks that tonight's run can work. Prints one line per check; exits 1 on any failure. */
async function doctor() {
  let ok = true;
  const check = (name, pass, detail = "") => {
    ok &&= pass;
    console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  // 1. Screen Recording grant: a 2-second capture of nothing in particular.
  const dir = join(ROOT, "tmp", "doctor");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const via = await launchRecorder(dir, join(dir, "log"), ["--out", dir, "--max", "2"]);
  await sleep(8000);
  const rl = existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8") : "";
  check(
    "recorder permission",
    /"event":"recording"/.test(rl),
    via === "app"
      ? "via EventRecorder.app"
      : "EventRecorder.app was refused (stale grant): run `tccutil reset ScreenCapture com.aen.event-agent.recorder`, start the app once, approve the prompt",
  );
  // 2. Tools.
  check("ffmpeg", spawnSync("ffmpeg", ["-version"]).status === 0);
  check("zoom installed", existsSync("/Applications/zoom.us.app"));
  // 3. Luma session, via each tracked upcoming event.
  for (const ev of allEvents().filter((e) => new Date(e.end_at).getTime() > now())) {
    try {
      await refresh(ev);
      save(ev);
      check(`luma: ${ev.slug}`, ev.registered, `approval=${ev.approval_status}, link=${pickJoinUrl(ev) ? "yes" : "not yet"}`);
    } catch (e) {
      check(`luma: ${ev.slug}`, false, e.message);
    }
  }
  // 4. Heartbeat.
  check("launchd heartbeat", spawnSync("launchctl", ["print", `gui/${process.getuid()}/${LABEL}`]).status === 0, "ea install");
  const sleepOff = /SleepDisabled\s+1|sleep\s+0/.test(spawnSync("pmset", ["-g"], { encoding: "utf8" }).stdout);
  check("system sleep disabled", sleepOff, "the Mac must stay awake; attend also runs caffeinate");
  process.exitCode = ok ? 0 : 1;
}

// ---------- launchd ----------

function install() {
  const path = `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${fileURLToPath(import.meta.url)}</string><string>tick</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string></dict>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(LOGS, "tick.log")}</string>
  <key>StandardErrorPath</key><string>${join(LOGS, "tick.log")}</string>
</dict></plist>
`;
  writeFileSync(PLIST, plist);
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`]);
  const r = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, PLIST], { encoding: "utf8" });
  console.log(r.status === 0 ? `installed ${PLIST} (every 2 min)` : `launchctl bootstrap failed: ${r.stderr}`);
}

function uninstall() {
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`]);
  if (existsSync(PLIST)) rmSync(PLIST);
  console.log("uninstalled");
}

// ---------- CLI ----------

const [cmd, arg] = process.argv.slice(2);
const fmt = (ev) =>
  `${ev.slug.padEnd(28)} ${String(ev.state).padEnd(10)} ${String(ev.approval_status).padEnd(17)} ${new Date(ev.start_at).toLocaleString()}  ${pickJoinUrl(ev) ? "link✓" : "no link"}  ${ev.recording_file ?? ""}`;

switch (cmd) {
  case "login":
    await login();
    break;
  case "add": {
    const slug = slugFromUrl(arg);
    const ev = existsSync(evPath(slug)) ? load(slug) : { slug, url: arg, state: "registered", added_at: iso(), history: [] };
    await refresh(ev);
    save(ev);
    console.log(JSON.stringify(ev, null, 2));
    break;
  }
  case "status": {
    for (const ev of arg ? [load(arg)] : allEvents()) {
      await refresh(ev);
      save(ev);
      console.log(fmt(ev));
    }
    break;
  }
  case "set": {
    // ea set <slug> key=value … — lets the agent record what it found elsewhere
    // (join_url_override, join_redirect, official_recording, state, notes).
    const ev = load(arg);
    for (const kv of process.argv.slice(4)) {
      const i = kv.indexOf("=");
      ev[kv.slice(0, i)] = kv.slice(i + 1);
    }
    note(ev, `set ${process.argv.slice(4).map((kv) => kv.split("=")[0]).join(", ")}`);
    save(ev);
    console.log(JSON.stringify(ev, null, 2));
    break;
  }
  case "silence": // debug: ea silence <file> [lastSeconds]
    console.log(JSON.stringify(trailingSilence(arg, { fromEnd: Number(process.argv[4]) || undefined })));
    break;
  case "subtitle": {
    // ea subtitle <slug | file> [--srt-only]
    const file = existsSync(evPath(arg)) ? load(arg).recording_file : arg;
    const t0 = now();
    const srt = subtitle(file, { srtOnly: process.argv.includes("--srt-only") });
    if (existsSync(evPath(arg))) {
      const ev = load(arg);
      ev.subtitles = srt;
      note(ev, `subtitles added: ${srt}`);
      save(ev);
    }
    console.log(`${srt} (${Math.round((now() - t0) / 60000)} min)`);
    break;
  }
  case "clean-srt": {
    // ea clean-srt <video> <srt> — re-clean an existing transcript in place
    const srtPath = process.argv[4];
    const r = cleanSrt(readFileSync(srtPath, "utf8"), silences(arg).silences);
    writeFileSync(srtPath, r.text);
    console.log(`dropped ${r.dropped} cue(s)`);
    break;
  }
  case "trim": {
    const cut = trimTail(arg);
    console.log(cut ? `trimmed ${cut.toFixed(1)}s of trailing silence` : "no silent tail over 60s");
    break;
  }
  case "doctor":
    await doctor();
    break;
  case "show":
    console.log(JSON.stringify(load(arg), null, 2));
    break;
  case "list":
    for (const ev of allEvents()) console.log(fmt(ev));
    break;
  case "tick":
    await tick();
    break;
  case "attend":
    await attend(arg);
    break;
  case "install":
    install();
    break;
  case "uninstall":
    uninstall();
    break;
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 13).join("\n"));
}
