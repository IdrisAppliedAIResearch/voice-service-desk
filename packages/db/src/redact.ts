const EMAIL = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g;
// Written and spoken separators in any mix, as the identifier parser takes them ("jane.doe at contoso dash health dot example").
// Matching starts only where a run of address characters starts, which keeps long runs linear.
const SPOKEN_EMAIL =
  /(?<![\w.%+-])[\w.%+-]+(?:\s+(?:dot|dash|underscore)\s+[\w.%+-]+)*(?:@|\s+at\s+)[\w-]+(?:(?:\.|\s+(?:dot|dash)\s+)[\w-]+)*(?:\.|\s+dot\s+)[a-z]{2,}\b/gi;
const CODE = /(?<!\d[ -]?)\d(?:[ -]?\d){5}(?![ -]?\d)/g;
const DIGIT = String.raw`(?:\d|\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b)`;
// Digits or digit words joined by spaces, commas, dots or dashes, as the PIN and code parsers take them ("four eight two,
// nine one three", "482,913"); a longer run such as a phone number stays readable.
const SPOKEN_CODE = new RegExp(String.raw`(?<!${DIGIT}[\s,.-]*)${DIGIT}(?:[\s,.-]*${DIGIT}){5}(?![\s,.-]*${DIGIT})`, 'gi');
const SECRET_KEY = /answer|pin|code|otp|password|secret|hash|token/i;

export function maskEmail(email: string): string {
  return `${email.slice(0, 2)}***`;
}

export function maskPhone(last4: string): string {
  return `***-***-${last4}`;
}

export function redactText(text: string, opts: { fully?: boolean } = {}): string {
  if (opts.fully) return '[redacted]';
  return text.replace(EMAIL, maskEmail).replace(SPOKEN_EMAIL, maskEmail).replace(CODE, '[code]').replace(SPOKEN_CODE, '[code]');
}

export function redactDetail(detail: unknown): unknown {
  if (typeof detail === 'string') return redactText(detail);
  if (Array.isArray(detail)) return detail.map(redactDetail);
  if (detail === null || typeof detail !== 'object' || detail instanceof Date) return detail;
  return Object.fromEntries(
    Object.entries(detail).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redactDetail(v)]),
  );
}
