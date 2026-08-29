import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseBookingRating, parseGoogleRating, RatingsService } from '../src/services/ratings.js';
import { createTestContext } from './helpers.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('public ratings', () => {
  it('extracts aggregate scores and review counts from the public page text', () => {
    expect(parseBookingRating('Scored 9.2 9.2 Rated wonderful Wonderful 17 reviews')).toMatchObject({ score: 9.2, maximum: 10, reviews: 17 });
    expect(parseGoogleRating('Share 5.0 Excellent|[10 reviews](https://www.google.com/)')).toMatchObject({ score: 5, maximum: 5, reviews: 10 });
  });

  it('keeps a daily persistent cache instead of scraping for every visitor', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-ratings-'));
    temporaryDirectories.push(directory);
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const body = String(url).includes('booking.com')
        ? 'Scored 9.2 9.2 Rated wonderful Wonderful 17 reviews'
        : 'Share 5.0 Excellent|[10 reviews](https://www.google.com/)';
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const service = new RatingsService(directory, fetcher);

    const first = await service.getRatings();
    const second = await service.getRatings();

    expect(first).toMatchObject({ booking: { score: 9.2, reviews: 17 }, google: { score: 5, reviews: 10 } });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(directory, 'ratings-cache.json'))).toBe(true);
  });

  it('serves cached ratings through the public endpoint', async () => {
    const context = createTestContext();
    fs.mkdirSync(context.config.storagePath, { recursive: true });
    fs.writeFileSync(path.join(context.config.storagePath, 'ratings-cache.json'), JSON.stringify({
      booking: { score: 9.2, maximum: 10, reviews: 17, url: 'https://www.booking.com/' },
      google: { score: 5, maximum: 5, reviews: 10, url: 'https://www.google.com/' },
      checkedAt: new Date().toISOString(),
    }));
    const app = await buildApp({ config: context.config, db: context.db, logger: false });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/ratings' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toContain('max-age=3600');
      expect(response.json()).toMatchObject({ booking: { score: 9.2, reviews: 17 }, google: { score: 5, reviews: 10 } });
    } finally {
      await app.close();
      context.close();
    }
  });
});
