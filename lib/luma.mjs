// Luma access through a dedicated, persistent Chrome profile.
//
// Luma has no attendee API, but its web app calls api2.luma.com with the
// session cookie, and that endpoint returns the guest's approval status and —
// once approved — the event's virtual join details. We reuse it from inside a
// page on luma.com so the cookie rides along.

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROFILE = join(homedir(), ".event-agent", "chrome-profile");

export async function withLuma(fn, { headless = true } = {}) {
  mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless,
    viewport: headless ? { width: 1280, height: 900 } : null,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    return await fn(page, ctx);
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Opens a visible window on Luma's sign-in page and waits for the user to close it. */
export async function login() {
  await withLuma(
    async (page, ctx) => {
      await page.goto("https://luma.com/signin");
      console.log("Sign in to Luma in the Chrome window that opened, then close that window.");
      await new Promise((resolve) => {
        ctx.on("close", resolve);
        page.on("close", resolve);
      });
    },
    { headless: false },
  );
}

/** Event slug or api id from any luma.com / lu.ma URL. */
export function slugFromUrl(url) {
  const u = new URL(url);
  return u.pathname.replace(/^\/+|\/+$/g, "").split("/").pop();
}

const MEETING_RE =
  /https?:\/\/(?:[\w-]+\.)?(?:zoom\.us\/(?:j|w|s|wc\/join|my)\/[^\s"'<>\\]+|zoom\.us\/meeting\/register\/[^\s"'<>\\]+|meet\.google\.com\/[a-z0-9-]+[^\s"'<>\\]*|teams\.(?:microsoft|live)\.com\/[^\s"'<>\\]+|(?:www\.)?youtube\.com\/(?:live\/|watch\?v=)[^\s"'<>\\]+|youtu\.be\/[^\s"'<>\\]+|streamyard\.com\/[^\s"'<>\\]+|riverside\.(?:fm|com)\/[^\s"'<>\\]+|[\w-]+\.webex\.com\/[^\s"'<>\\]+|discord\.(?:gg|com)\/[^\s"'<>\\]+|x\.com\/i\/broadcasts\/[^\s"'<>\\]+|(?:www\.)?linkedin\.com\/events\/[^\s"'<>\\]+|(?:www\.)?twitch\.tv\/[^\s"'<>\\]+)/gi;

export function findMeetingUrls(obj) {
  const s = JSON.stringify(obj).replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  return [...new Set((s.match(MEETING_RE) || []).map((u) => u.replace(/[),.]+$/, "")))];
}

/**
 * Reads the event as the signed-in user. Returns approval status, times, and any
 * join link Luma has revealed to this guest.
 */
export async function eventStatus(url) {
  return withLuma(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const apiId = await page.evaluate(() => {
      const nd = document.getElementById("__NEXT_DATA__");
      try {
        return JSON.parse(nd.textContent).props.pageProps.initialData.data.api_id;
      } catch {
        return null;
      }
    });
    if (!apiId) throw new Error("could not read the event id from " + url);
    const data = await page.evaluate(async (id) => {
      const r = await fetch(`https://api2.luma.com/event/get?event_api_id=${id}`, { credentials: "include" });
      return { status: r.status, body: await r.json() };
    }, apiId);
    if (data.status !== 200) throw new Error(`api2 event/get returned ${data.status}`);
    const d = data.body;
    const ev = d.event || {};
    // The visible "Join" button, if the page renders one, is the most direct source.
    const pageLinks = await page
      .$$eval("a[href]", (as) => as.map((a) => a.href))
      .catch(() => []);
    const joinFromPage = findMeetingUrls(pageLinks);
    const joinFromApi = findMeetingUrls({ virtual_info: ev.virtual_info, event: ev, guest: d.guest_data });
    return {
      api_id: apiId,
      name: ev.name,
      start_at: ev.start_at,
      end_at: ev.end_at,
      timezone: ev.timezone,
      location_type: ev.location_type,
      approval_status: d.guest_data?.approval_status ?? null,
      registered: Boolean(d.guest_data?.ticket_key || d.guest_data?.approval_status),
      virtual_info: ev.virtual_info ?? null,
      join_urls: [...new Set([...joinFromApi, ...joinFromPage])],
      hosts: (d.hosts || []).map((h) => h.name),
      calendar: d.calendar?.name,
      youtube_handle: d.calendar?.youtube_handle ?? null,
    };
  });
}
