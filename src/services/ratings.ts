import fs from 'node:fs';
import path from 'node:path';

const ONE_DAY = 24 * 60 * 60 * 1000;
const BOOKING_SOURCE = 'https://www.booking.com/hotel/it/villa-paradiso-padenghe-sul-garda.en-gb.html';
const GOOGLE_SOURCE = 'https://www.google.com/travel/hotels/entity/CiUI5P-yo7_RxNnxARD3v5SY9YCm1oABGg0vZy8xMXo1cXN5MmZiEAI?hl=en';
const BOOKING_READER = `https://r.jina.ai/http://${BOOKING_SOURCE.replace(/^https?:\/\//, '')}`;
const GOOGLE_READER = `https://r.jina.ai/http://${GOOGLE_SOURCE.replace(/^https?:\/\//, '')}`;

export interface PublicRating {
  score: number;
  maximum: 5 | 10;
  reviews: number | null;
  url: string;
}

export interface RatingsSnapshot {
  booking: PublicRating;
  google: PublicRating;
  checkedAt: string;
}

const fallbackSnapshot = (): RatingsSnapshot => ({
  booking: { score: 9, maximum: 10, reviews: null, url: BOOKING_SOURCE },
  google: { score: 5, maximum: 5, reviews: null, url: GOOGLE_SOURCE },
  checkedAt: new Date(0).toISOString(),
});

function numberValue(value: string): number {
  return Number(value.replace(',', '.'));
}

export function parseBookingRating(content: string): PublicRating | null {
  const match = content.match(/Scored\s+(\d+(?:[.,]\d+)?)\s+(?:\d+(?:[.,]\d+)?\s+)?Rated[\s\S]{0,80}?(\d[\d,.]*)\s+reviews?/i);
  if (!match) return null;
  const score = numberValue(match[1]!);
  const reviews = Number(match[2]!.replace(/[^\d]/g, ''));
  if (!Number.isFinite(score) || score < 1 || score > 10 || !Number.isInteger(reviews) || reviews < 1) return null;
  return { score, maximum: 10, reviews, url: BOOKING_SOURCE };
}

export function parseGoogleRating(content: string): PublicRating | null {
  const match = content.match(/([1-5](?:[.,]\d+)?)\s+(?:Excellent|Very good|Good|Fair|Poor)\s*\|?\s*\[?(\d[\d,.]*)\s+reviews?/i);
  if (!match) return null;
  const score = numberValue(match[1]!);
  const reviews = Number(match[2]!.replace(/[^\d]/g, ''));
  if (!Number.isFinite(score) || score < 1 || score > 5 || !Number.isInteger(reviews) || reviews < 1) return null;
  return { score, maximum: 5, reviews, url: GOOGLE_SOURCE };
}

function isPublicRating(value: unknown, maximum: 5 | 10): value is PublicRating {
  if (!value || typeof value !== 'object') return false;
  const rating = value as Partial<PublicRating>;
  return (
    typeof rating.score === 'number' &&
    rating.score >= 1 &&
    rating.score <= maximum &&
    rating.maximum === maximum &&
    (rating.reviews === null || (Number.isInteger(rating.reviews) && (rating.reviews ?? 0) >= 1)) &&
    typeof rating.url === 'string'
  );
}

function isSnapshot(value: unknown): value is RatingsSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<RatingsSnapshot>;
  return isPublicRating(snapshot.booking, 10) && isPublicRating(snapshot.google, 5) && typeof snapshot.checkedAt === 'string' && Number.isFinite(Date.parse(snapshot.checkedAt));
}

export class RatingsService {
  private readonly cachePath: string;
  private refreshInFlight: Promise<RatingsSnapshot> | null = null;

  constructor(storagePath: string, private readonly fetcher: typeof fetch = fetch) {
    this.cachePath = path.join(storagePath, 'ratings-cache.json');
  }

  async getRatings(): Promise<RatingsSnapshot> {
    const cached = this.readCache();
    if (cached && Date.now() - Date.parse(cached.checkedAt) < ONE_DAY) return cached;
    if (cached) {
      void this.refresh(cached);
      return cached;
    }
    return this.refresh(fallbackSnapshot());
  }

  private readCache(): RatingsSnapshot | null {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      return isSnapshot(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.fetcher(url, {
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'VillaTulliaRatings/1.0 (+https://villatullia.it)',
        'X-No-Cache': 'true',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Rating source returned ${response.status}`);
    return response.text();
  }

  private refresh(previous: RatingsSnapshot): Promise<RatingsSnapshot> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const [bookingResult, googleResult] = await Promise.allSettled([
        this.fetchText(BOOKING_READER).then(parseBookingRating),
        this.fetchText(GOOGLE_READER).then(parseGoogleRating),
      ]);
      const booking = bookingResult.status === 'fulfilled' && bookingResult.value ? bookingResult.value : previous.booking;
      const google = googleResult.status === 'fulfilled' && googleResult.value ? googleResult.value : previous.google;
      const snapshot = { booking, google, checkedAt: new Date().toISOString() };
      this.writeCache(snapshot);
      return snapshot;
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private writeCache(snapshot: RatingsSnapshot): void {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      const temporaryPath = `${this.cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, this.cachePath);
    } catch {
      // A cache write failure should never prevent the public ratings from rendering.
    }
  }
}
