import { describe, expect, it } from 'vitest';
import { chunkText, parseArticle } from '../src/index';

const article = `---
title: Connect to the VPN with GlobalProtect
category: Network
tags: [vpn, remote-access, globalprotect]
updated: 2025-08-04
topic: vpn-setup   # same topic = versions of one article
---

Open GlobalProtect and select Connect.
`;

describe('parseArticle', () => {
  it('reads the frontmatter and trims the body', () => {
    expect(parseArticle('vpn-setup-globalprotect', article)).toEqual({
      slug: 'vpn-setup-globalprotect',
      title: 'Connect to the VPN with GlobalProtect',
      category: 'Network',
      tags: ['vpn', 'remote-access', 'globalprotect'],
      updated: '2025-08-04',
      topic: 'vpn-setup',
      body: 'Open GlobalProtect and select Connect.',
    });
  });

  it('defaults the topic to the slug', () => {
    expect(parseArticle('printer-mapping', article.replace(/^topic:.*\n/m, '')).topic).toBe('printer-mapping');
  });

  it.each(['title', 'category', 'tags', 'updated'])('throws when %s is missing', (field) => {
    expect(() => parseArticle('broken', article.replace(new RegExp(`^${field}:.*\\n`, 'm'), ''))).toThrow(
      `broken: ${field}`,
    );
  });

  it.each([
    ['updated: 08/04/2025', 'updated'],
    ['tags: vpn', 'tags'],
    ['tags: [vpn, 11]', 'tags'],
    ['title: ""', 'title'],
  ])('rejects %s', (line, field) => {
    const key = line.split(':')[0];
    expect(() => parseArticle('broken', article.replace(new RegExp(`^${key}:.*$`, 'm'), line))).toThrow(
      `broken: ${field}`,
    );
  });

  it('throws when there is no frontmatter', () => {
    expect(() => parseArticle('plain', '# Just markdown\n\nNo frontmatter here.')).toThrow('plain: missing frontmatter');
  });
});

let seq = 0;
const sentence = (words: number) => `Step ${Array.from({ length: words - 1 }, () => `w${seq++}`).join(' ')}.`;
const paragraph = (sentences: number) => Array.from({ length: sentences }, () => sentence(10)).join(' ');
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe('chunkText', () => {
  it('keeps a short body as one chunk', () => {
    expect(chunkText('\n  Short answer.  \n')).toEqual(['Short answer.']);
    expect(chunkText('  \n\n ')).toEqual([]);
  });

  it('packs whole paragraphs into chunks of about equal size', () => {
    const paragraphs = Array.from({ length: 6 }, () => paragraph(5));
    expect(chunkText(paragraphs.join('\n\n'))).toEqual([
      paragraphs.slice(0, 3).join('\n\n'),
      paragraphs.slice(3).join('\n\n'),
    ]);
  });

  it('keeps a heading with the paragraph after it', () => {
    const [intro, rest] = [paragraph(9), paragraph(10)];
    expect(chunkText(`${intro}\n\n## Troubleshooting\n\n${rest}`)).toEqual([intro, `## Troubleshooting\n\n${rest}`]);
  });

  it('never leaves a paragraph under 60 words as a chunk of its own', () => {
    const tail = `${paragraph(17)}\n\n${paragraph(2)}`;
    const head = `${paragraph(2)}\n\n${paragraph(17)}`;
    expect(chunkText(tail)).toEqual([tail]);
    expect(chunkText(head)).toEqual([head]);
  });

  it('splits a paragraph over 180 words between sentences', () => {
    const long = paragraph(40);
    const chunks = chunkText(long);
    expect(chunks.map(wordCount)).toEqual([140, 140, 120]);
    expect(chunks.every((c) => c.startsWith('Step ') && c.endsWith('.'))).toBe(true);
    expect(chunks.join(' ')).toBe(long);
  });

  it('splits a long list between items and keeps each number with its item', () => {
    const list = `${Array.from({ length: 10 }, (_, i) => `${i + 1}. ${sentence(17)}`).join('\n')}\nDone.`;
    const chunks = chunkText(list);
    expect(chunks.map((c) => c.split('\n')[0].split('.')[0])).toEqual(['1', '7']);
    expect(chunks.join('\n')).toBe(list);
  });
});
