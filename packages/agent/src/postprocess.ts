const WEB_ADDRESS =
  /(?:\b[A-Za-z][\w+.-]*:\/\/|\bwww\.|(?<![@\w.-])[\w-]+(?:\.[\w-]+)*\.(?:example|com|org|net|gov)\b)(?:[^\s<>]*[^\s<>.,!?;:'")\]])?/g;
const ABBREVIATION = /(?:^|[\s(])(?:mr|mrs|ms|dr|st|jr|sr|vs|etc|inc|e\.g|i\.e|a\.m|p\.m|\p{L})\.$/iu;
// A reasoning model served without a reasoning parser writes its private reasoning first, possibly cut off by max_tokens.
export const THINK = /<think>[\s\S]*?(?:<\/think>|$)/gi;

export function postProcess(text: string, { maxSentences = 3, maxChars = 350 } = {}): string {
  const lines = text
    .replace(THINK, '')
    .replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(WEB_ADDRESS, '')
    .replace(/[\p{Extended_Pictographic}\p{So}\p{Sk}\u2190-\u21ff\ufe0f\u200d]/gu, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(?:>\s*)*(?:#{1,6}\s|[-*+•]\s|\d+[.)]\s)?/, '')
        .replace(/^[\s|:-]*-[\s|:-]*$/, '')
        .replace(/\|/g, ',')
        .replace(/[*~#\\[\]{}<>]/g, '')
        .replace(/_/g, ' ')
        .replace(/\s+([,.;:!?])(?!\S)/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/^[\s,;:]+|[\s,;]+$/g, ''),
    )
    .filter(Boolean)
    .map((line) => (/[.!?:]['"’”)]*$/.test(line) ? line : `${line}.`));

  const sentences: string[] = [];
  for (const piece of lines.join(' ').split(/(?<=[.!?]['"’”)]*)\s+/)) {
    if (!/[\p{L}\p{N}]/u.test(piece)) continue;
    if (sentences.length && ABBREVIATION.test(sentences[sentences.length - 1])) sentences[sentences.length - 1] += ` ${piece}`;
    else sentences.push(piece);
  }
  let out = sentences.slice(0, maxSentences).join(' ');
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const space = cut.lastIndexOf(' ');
    out = (space > 0 ? cut.slice(0, space) : cut.slice(0, maxChars - 1)).replace(/[\s,;:'"(-]+$/, '');
    if (!/[.!?]$/.test(out)) out += '.';
  }
  return out;
}
