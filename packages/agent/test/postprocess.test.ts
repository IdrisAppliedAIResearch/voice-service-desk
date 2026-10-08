import { describe, expect, it } from 'vitest';
import { postProcess } from '../src/postprocess';

describe('postProcess', () => {
  it.each([
    ['headings', '## Reset your password\nUse the self-service portal.', 'Reset your password. Use the self-service portal.'],
    ['bold and italics', '**Important:** restart *now* and __then__ _wait_.', 'Important: restart now and then wait.'],
    ['strikethrough and snake case', '~~old~~ new_setting', 'old new setting.'],
    ['links, keeping the text', 'Open [the reset page](https://portal.contoso-health.example/reset) and sign in.', 'Open the reset page and sign in.'],
    ['scheme URLs', 'Open https://portal.contoso-health.example/reset?x=1 in a browser.', 'Open in a browser.'],
    ['www URLs', 'Visit www.contoso.com, then call back.', 'Visit, then call back.'],
    ['bare hosts', 'Connect to vpn.contoso-health.example or help.contoso.org/vpn today.', 'Connect to or today.'],
    ['fenced code blocks', 'Run this:\n```bash\nipconfig /all\n```\nThen call back.', 'Run this: Then call back.'],
    ['an unterminated code block', 'Try this ```rm -rf /\nmore', 'Try this.'],
    ['inline code backticks', 'Type `ipconfig` and press Enter.', 'Type ipconfig and press Enter.'],
    ['lists into sentences', 'To connect:\n1. Open GlobalProtect\n2) Enter the portal\n- Sign in', 'To connect: Open GlobalProtect. Enter the portal. Sign in.'],
    ['tables', '| Priority | Meaning |\n|---|:---:|\n| P1 | Outage |', 'Priority, Meaning. P1, Outage.'],
    ['blockquotes and rules', '> Note: this is quoted\n---\n> > nested', 'Note: this is quoted. nested.'],
    ['HTML', '<b>Hi</b> there<br/>friend', 'Hi there friend.'],
    ['emoji and stray symbols', 'Done \u{1F44D}\u{1F3FD} \u2705 \u2192 next \u2764\ufe0f \u{1F468}\u200d\u{1F4BB} {ok} [x] #1', 'Done next ok x 1.'],
    ['abbreviations and decimals', 'Ask Mr. Chen, e.g. today. Version 6.2 works. Call at 7 a.m. Monday. Bye.', 'Ask Mr. Chen, e.g. today. Version 6.2 works. Call at 7 a.m. Monday.'],
    ['quoted sentence ends', 'He said "Stop!" Then he left. Okay? Yes!', 'He said "Stop!" Then he left. Okay?'],
    ['email addresses and .NET', 'Email jane.doe@contoso-health.example about .NET 4.8.', 'Email jane.doe@contoso-health.example about .NET 4.8.'],
    [
      'reasoning in a think block',
      '<think>\nThe caller gave an email. The tool said found. I should ask the question now.\n</think>\n\nWhat was the name of your first pet?',
      'What was the name of your first pet?',
    ],
    ['a think block cut off by the token limit', 'One moment. <think>The account might not exist, so I', 'One moment.'],
  ])('strips %s', (_, input, expected) => {
    expect(postProcess(input)).toBe(expected);
  });

  it('caps at three sentences by default and at maxSentences when given', () => {
    const text = 'One. Two! Three? Four. Five. Six. Seven.';
    expect(postProcess(text)).toBe('One. Two! Three?');
    expect(postProcess(text, { maxSentences: 6, maxChars: 700 })).toBe('One. Two! Three? Four. Five. Six.');
  });

  it('caps characters at a word boundary and ends with punctuation', () => {
    const out = postProcess(`${'alpha bravo, '.repeat(40)}end.`);
    expect(out.length).toBeLessThanOrEqual(350);
    expect(out).toMatch(/^(alpha bravo, )*alpha( bravo)?\.$/);
    expect(postProcess('x'.repeat(400))).toBe(`${'x'.repeat(349)}.`);
    expect(postProcess('The quick brown fox jumps.', { maxChars: 12 })).toBe('The quick.');
  });

  it.each(['', '   \n ', '```\ncode only\n```', '🙂🙂 ** __ ## ---', 'https://contoso.com'])('returns empty for %j', (input) => {
    expect(postProcess(input)).toBe('');
  });

  it('never returns markdown, list markers, URLs or code', () => {
    const out = postProcess(
      '# Title\n* **one** see https://a.example\n* `two` [link](http://b.example)\n```js\nx()\n```\n> www.c.com',
      { maxSentences: 6, maxChars: 700 },
    );
    expect(out).toBe('Title. one see. two link.');
    expect(out).not.toMatch(/[*#`>[\]]|https?:|www\.|\.example|\.com/);
  });
});
