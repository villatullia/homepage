export interface DirectWebsiteRate {
  start: string;
  end: string;
  weeklyPrice: number;
  currency: 'EUR';
}

export const directWebsiteRates2027: DirectWebsiteRate[] = [
  ['2027-05-15', '2027-05-22', 4200],
  ['2027-05-22', '2027-05-29', 4200],
  ['2027-05-29', '2027-06-05', 4700],
  ['2027-06-05', '2027-06-12', 5000],
  ['2027-06-12', '2027-06-19', 5000],
  ['2027-06-19', '2027-06-26', 5000],
  ['2027-06-26', '2027-07-03', 5300],
  ['2027-07-03', '2027-07-10', 5600],
  ['2027-07-10', '2027-07-17', 5600],
  ['2027-07-17', '2027-07-24', 5600],
  ['2027-07-24', '2027-07-31', 5600],
  ['2027-07-31', '2027-08-07', 5800],
  ['2027-08-07', '2027-08-14', 6100],
  ['2027-08-14', '2027-08-21', 6100],
  ['2027-08-21', '2027-08-28', 5800],
  ['2027-08-28', '2027-09-04', 5300],
  ['2027-09-04', '2027-09-11', 4700],
  ['2027-09-11', '2027-09-18', 4700],
  ['2027-09-18', '2027-09-25', 4200],
  ['2027-09-25', '2027-10-02', 3700],
  ['2027-10-02', '2027-10-09', 3400],
].map(([start, end, weeklyPrice]) => ({
  start: String(start),
  end: String(end),
  weeklyPrice: Number(weeklyPrice),
  currency: 'EUR' as const,
}));

export function getDirectWebsiteRate(start: string, end: string): DirectWebsiteRate | undefined {
  return directWebsiteRates2027.find((rate) => rate.start === start && rate.end === end);
}
