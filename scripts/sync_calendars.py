#!/usr/bin/env python3
"""Merge private iCalendar feeds into public, guest-safe availability data."""

import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "availability.json"
MANUAL_BLOCKS = ROOT / "data" / "manual-blocks.json"
FEEDS = {
    "Airbnb": os.environ.get("AIRBNB_ICAL_URL", ""),
    "Booking.com": os.environ.get("BOOKING_ICAL_URL", ""),
    "Vrbo": os.environ.get("VRBO_ICAL_URL", ""),
}


def parse_ical_date(value):
    value = value.strip().replace("Z", "+0000")
    if len(value) == 8:
        return datetime.strptime(value, "%Y%m%d").date()
    return datetime.strptime(value[:8], "%Y%m%d").date()


def get_events(feed_url):
    request = Request(feed_url, headers={"User-Agent": "VillaTulliaCalendarSync/1.0"})
    with urlopen(request, timeout=25) as response:
        raw = response.read().decode("utf-8", errors="replace")
    unfolded = re.sub(r"\r?\n[ \t]", "", raw)
    for event in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", unfolded, flags=re.DOTALL):
        start = re.search(r"^DTSTART[^:]*:(.+)$", event, flags=re.MULTILINE)
        end = re.search(r"^DTEND[^:]*:(.+)$", event, flags=re.MULTILINE)
        if not start:
            continue
        start_date = parse_ical_date(start.group(1))
        # iCalendar DTEND is exclusive. A missing end is treated as a one-night block.
        end_date = parse_ical_date(end.group(1)) if end else start_date + timedelta(days=1)
        if end_date > start_date:
            yield {"start": start_date.isoformat(), "end": end_date.isoformat()}


def merge_ranges(ranges):
    merged = []
    for current in sorted(ranges, key=lambda item: item["start"]):
        if not merged or current["start"] > merged[-1]["end"]:
            merged.append(current)
        elif current["end"] > merged[-1]["end"]:
            merged[-1]["end"] = current["end"]
    return merged


def get_manual_blocks():
    if not MANUAL_BLOCKS.exists():
        return []
    payload = json.loads(MANUAL_BLOCKS.read_text(encoding="utf-8"))
    return payload.get("blockedRanges", [])


def main():
    configured_feeds = {name: url for name, url in FEEDS.items() if url}
    if not configured_feeds:
        print("No calendar feeds configured yet. Add the iCal URLs as GitHub Actions secrets.")
        return
    blocks = get_manual_blocks()
    for name, feed_url in configured_feeds.items():
        try:
            blocks.extend(get_events(feed_url))
            print(f"Synced {name} calendar.")
        except Exception as error:
            # Do not print feed URLs: they are private credentials.
            print(f"Could not sync {name}: {error}", file=sys.stderr)
            sys.exit(1)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "lastUpdated": datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "blockedRanges": merge_ranges(blocks),
    }
    OUTPUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(payload['blockedRanges'])} blocked date ranges.")


if __name__ == "__main__":
    main()
