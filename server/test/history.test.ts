import { describe, expect, it } from 'vitest';
import { parseHistory, splitHistoryOutput } from '../src/services/history.js';

describe('parseHistory: the bash format', () => {
  it('returns the commands with the freshest on top', () => {
    const content = 'ls -la\ncd /var\ndocker ps\n';
    expect(parseHistory(content, 'bash', 100)).toEqual(['docker ps', 'cd /var', 'ls -la']);
  });

  it('skips empty lines and whitespace-only lines', () => {
    const content = 'ls\n\n   \npwd\n';
    expect(parseHistory(content, 'bash', 100)).toEqual(['pwd', 'ls']);
  });
});

describe('parseHistory: the zsh format', () => {
  it('cuts off the extended `: 1234567890:0;` stamps', () => {
    const content = ': 1700000001:0;git status\n: 1700000002:0;docker ps\n';
    expect(parseHistory(content, 'zsh', 100)).toEqual(['docker ps', 'git status']);
  });

  it('tolerates lines without stamps (the plain zsh format)', () => {
    const content = 'whoami\n: 1700000001:0;git status\n';
    expect(parseHistory(content, 'zsh', 100)).toEqual(['git status', 'whoami']);
  });
});

describe('parseHistory: deduplication', () => {
  it('keeps the last occurrence of a command, the freshest on top', () => {
    const content = 'ls\ncd /tmp\nls\npwd\nls\n';
    expect(parseHistory(content, 'bash', 100)).toEqual(['ls', 'pwd', 'cd /tmp']);
  });
});

describe('parseHistory: multi-line commands', () => {
  // The history file stores a multi-line command as physical lines without any
  // continuation markers — every line becomes a separate entry.
  it('every physical line is a separate command', () => {
    const content = 'for i in 1 2 3\ndo\necho $i\ndone\n';
    expect(parseHistory(content, 'bash', 100)).toEqual(['done', 'echo $i', 'do', 'for i in 1 2 3']);
  });
});

describe('parseHistory: empty history and the limit', () => {
  it('an empty file → an empty list', () => {
    expect(parseHistory('', 'bash', 100)).toEqual([]);
    expect(parseHistory('\n\n', 'zsh', 100)).toEqual([]);
  });

  it('the limit keeps only the freshest unique ones', () => {
    const content = 'c1\nc2\nc3\nc4\nc5\n';
    expect(parseHistory(content, 'bash', 3)).toEqual(['c5', 'c4', 'c3']);
  });

  it('the limit counts unique commands, not lines', () => {
    const content = 'a\nb\na\nc\n';
    expect(parseHistory(content, 'bash', 2)).toEqual(['c', 'a']);
  });
});

describe('splitHistoryOutput', () => {
  it('recognizes the bash marker', () => {
    expect(splitHistoryOutput('@@BASH@@\nls\n')).toEqual({ format: 'bash', body: 'ls\n' });
  });

  it('recognizes the zsh marker', () => {
    expect(splitHistoryOutput('@@ZSH@@\n: 1:0;ls\n')).toEqual({ format: 'zsh', body: ': 1:0;ls\n' });
  });

  it('no marker (no history files) → null', () => {
    expect(splitHistoryOutput('')).toBeNull();
    expect(splitHistoryOutput('some noise\n')).toBeNull();
  });
});
