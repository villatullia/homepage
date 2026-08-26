export interface DirectWebsiteRate {
  start: string;
  end: string;
  weeklyPrice: number;
  bookingComPrice?: number;
  currency: 'EUR';
}

export const directWebsiteRates2027: DirectWebsiteRate[] = [
  ['2027-05-15', '2027-05-22', 3675, 4676],
  ['2027-05-22', '2027-05-29', 3675, 4676],
  ['2027-05-29', '2027-06-05', 4113, 5201],
  ['2027-06-05', '2027-06-12', 4375, 5551],
  ['2027-06-12', '2027-06-19', 4375, 5551],
  ['2027-06-19', '2027-06-26', 4375, 5551],
  ['2027-06-26', '2027-07-03', 4638, 6251],
  ['2027-07-03', '2027-07-10', 4900, 6251],
  ['2027-07-10', '2027-07-17', 4900, 6251],
  ['2027-07-17', '2027-07-24', 4900, 6251],
  ['2027-07-24', '2027-07-31', 4900, 6251],
  ['2027-07-31', '2027-08-07', 5075, undefined],
  ['2027-08-07', '2027-08-14', 5338, 6776],
  ['2027-08-14', '2027-08-21', 5338, 6776],
  ['2027-08-21', '2027-08-28', 5075, 6426],
  ['2027-08-28', '2027-09-04', 4638, 5901],
  ['2027-09-04', '2027-09-11', 4113, 5201],
  ['2027-09-11', '2027-09-18', 4113, 5201],
  ['2027-09-18', '2027-09-25', 3675, 4676],
  ['2027-09-25', '2027-10-02', 3238, 4076],
  ['2027-10-02', '2027-10-09', 2975, 3976],
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
