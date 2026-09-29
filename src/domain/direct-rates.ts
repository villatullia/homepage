export interface DirectWebsiteRate {
  start: string;
  end: string;
  weeklyPrice: number;
  bookingComPrice?: number;
  currency: 'EUR';
}

export const directWebsiteRates2027: DirectWebsiteRate[] = [
  ['2027-05-15', '2027-05-22', 3491, 4134],
  ['2027-05-22', '2027-05-29', 3491, 4134],
  ['2027-05-29', '2027-06-05', 3907, 4597],
  ['2027-06-05', '2027-06-12', 4156, 4905],
  ['2027-06-12', '2027-06-19', 4156, 4905],
  ['2027-06-19', '2027-06-26', 4156, 4905],
  ['2027-06-26', '2027-07-03', 4406, 5213],
  ['2027-07-03', '2027-07-10', 4655, 5522],
  ['2027-07-10', '2027-07-17', 4655, 5522],
  ['2027-07-17', '2027-07-24', 4655, 5522],
  ['2027-07-24', '2027-07-31', 4655, 5522],
  ['2027-07-31', '2027-08-07', 4821, undefined],
  ['2027-08-07', '2027-08-14', 5071, undefined],
  ['2027-08-14', '2027-08-21', 5071, 5984],
  ['2027-08-21', '2027-08-28', 4821, 5676],
  ['2027-08-28', '2027-09-04', 4406, 5213],
  ['2027-09-04', '2027-09-11', 3907, 4597],
  ['2027-09-11', '2027-09-18', 3907, 4597],
  ['2027-09-18', '2027-09-25', 3491, 4134],
  ['2027-09-25', '2027-10-02', 3076, 3606],
  ['2027-10-02', '2027-10-09', 2826, 3518],
].map(([start, end, weeklyPrice, bookingComPrice]) => ({
  start: String(start),
  end: String(end),
  weeklyPrice: Number(weeklyPrice),
  bookingComPrice: bookingComPrice === undefined ? undefined : Number(bookingComPrice),
  currency: 'EUR' as const,
}));

export function getDirectWebsiteRate(start: string, end: string): DirectWebsiteRate | undefined {
  return directWebsiteRates2027.find((rate) => rate.start === start && rate.end === end);
}
