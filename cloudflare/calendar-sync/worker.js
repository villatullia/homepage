const SITE_ORIGIN = "https://villatullia.it";
const CACHE_SECONDS = 300;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": SITE_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
    "Content-Type": "application/json; charset=utf-8",
  };
}

function parseDate(value) {
  const match = value?.match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function addOneDay(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function parseIcal(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const events = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  return events.flatMap((event) => {
    const start = parseDate(event.match(/^DTSTART[^:]*:(.+)$/m)?.[1]);
    const end = parseDate(event.match(/^DTEND[^:]*:(.+)$/m)?.[1]) || (start && addOneDay(start));
    return start && end && end > start ? [{ start, end }] : [];
  });
}

function mergeRanges(ranges) {
  return ranges.sort((a, b) => a.start.localeCompare(b.start)).reduce((merged, current) => {
    const previous = merged.at(-1);
    if (!previous || current.start > previous.end) merged.push({ ...current });
    else if (current.end > previous.end) previous.end = current.end;
    return merged;
  }, []);
}

async function fetchCalendar(url) {
  const response = await fetch(url, { headers: { "User-Agent": "VillaTulliaAvailability/1.0" } });
  if (!response.ok) throw new Error(`Calendar returned ${response.status}`);
  return parseIcal(await response.text());
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    const url = new URL(request.url);
    if (url.pathname !== "/availability.json") {
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders() });
    }

    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
      const [bookingBlockedRanges, airbnbBlockedRanges, vrboBlockedRanges] = await Promise.all([
        fetchCalendar(env.BOOKING_ICAL_URL),
        fetchCalendar(env.AIRBNB_ICAL_URL),
        fetchCalendar(env.VRBO_ICAL_URL),
      ]);
      const manualResponse = await fetch("https://villatullia.it/data/manual-blocks.json");
      const manualData = manualResponse.ok ? await manualResponse.json() : { blockedRanges: [] };
      const manualBlockedRanges = manualData.blockedRanges || [];
      const softBlockedRanges = mergeRanges([...airbnbBlockedRanges, ...vrboBlockedRanges]);
      const response = new Response(JSON.stringify({
        lastUpdated: new Date().toISOString(),
        bookingBlockedRanges: mergeRanges(bookingBlockedRanges),
        softBlockedRanges,
        manualBlockedRanges: mergeRanges(manualBlockedRanges),
        blockedRanges: mergeRanges([...bookingBlockedRanges, ...softBlockedRanges, ...manualBlockedRanges]),
      }), { headers: corsHeaders() });
      await cache.put(request, response.clone());
      return response;
    } catch {
      return new Response(JSON.stringify({ error: "Calendar refresh failed. Please try again shortly." }), {
        status: 502,
        headers: corsHeaders(),
      });
    }
  },
};
