const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
// Thousands are separated by a non-breaking space (1 298 SEK), so a number never wraps.
const group = (formatted: string): string => formatted.replaceAll(',', '\u00a0');
const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

export const formatCount = (value: number): string => group(integer.format(Math.round(value)));

export const formatSek = (value: number): string => `${formatCount(value)}\u00a0SEK`;

export const formatRate = (value: number): string => (value >= 10 ? formatCount(value) : oneDecimal.format(value));

export const formatChange = (current: number, previous: number): { text: string; direction: 'up' | 'down' | 'flat' } => {
  if (previous <= 0) return { text: current > 0 ? 'new' : '–', direction: current > 0 ? 'up' : 'flat' };
  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.5) return { text: '0%', direction: 'flat' };
  return { text: `${change > 0 ? '+' : '−'}${formatCount(Math.abs(change))}%`, direction: change > 0 ? 'up' : 'down' };
};

export const countryName = (code: string): string => {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
};

/** A flag from the bundled flag-icons set; emoji flags don't render on Windows. */
export const flag = (code: string): string =>
  /^[A-Z]{2}$/.test(code) ? `<span class="fi fi-${code.toLowerCase()}"></span>` : '<span class="fi fi-xx"></span>';
