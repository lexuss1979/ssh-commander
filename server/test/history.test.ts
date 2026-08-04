import { describe, expect, it } from 'vitest';
import { parseHistory, splitHistoryOutput } from '../src/services/history.js';

describe('parseHistory: bash-формат', () => {
  it('возвращает команды свежими сверху', () => {
    const content = 'ls -la\ncd /var\ndocker ps\n';
    expect(parseHistory(content, 'bash', 100)).toEqual(['docker ps', 'cd /var', 'ls -la']);
  });

  it('пропускает пустые строки и строки из пробелов', () => {
    const content = 'ls\n\n   \npwd\n';
    expect(parseHistory(content, 'bash', 100)).toEqual(['pwd', 'ls']);
  });
});

describe('parseHistory: zsh-формат', () => {
  it('срезает extended-метки `: 1234567890:0;`', () => {
    const content = ': 1700000001:0;git status\n: 1700000002:0;docker ps\n';
    expect(parseHistory(content, 'zsh', 100)).toEqual(['docker ps', 'git status']);
  });

  it('терпит строки без меток (простой формат zsh)', () => {
    const content = 'whoami\n: 1700000001:0;git status\n';
    expect(parseHistory(content, 'zsh', 100)).toEqual(['git status', 'whoami']);
  });
});

describe('parseHistory: дедупликация', () => {
  it('оставляет последнее вхождение команды, порядок свежих сверху', () => {
    const content = 'ls\ncd /tmp\nls\npwd\nls\n';
    expect(parseHistory(content, 'bash', 100)).toEqual(['ls', 'pwd', 'cd /tmp']);
  });
});

describe('parseHistory: многострочные команды', () => {
  // Файл истории хранит многострочную команду физическими строками без маркеров
  // продолжения — каждая строка становится отдельной записью.
  it('каждая физическая строка — отдельная команда', () => {
    const content = 'for i in 1 2 3\ndo\necho $i\ndone\n';
    expect(parseHistory(content, 'bash', 100)).toEqual(['done', 'echo $i', 'do', 'for i in 1 2 3']);
  });
});

describe('parseHistory: пустая история и лимит', () => {
  it('пустой файл → пустой список', () => {
    expect(parseHistory('', 'bash', 100)).toEqual([]);
    expect(parseHistory('\n\n', 'zsh', 100)).toEqual([]);
  });

  it('лимит обрезает до самых свежих уникальных', () => {
    const content = 'c1\nc2\nc3\nc4\nc5\n';
    expect(parseHistory(content, 'bash', 3)).toEqual(['c5', 'c4', 'c3']);
  });

  it('лимит считается по уникальным командам, а не по строкам', () => {
    const content = 'a\nb\na\nc\n';
    expect(parseHistory(content, 'bash', 2)).toEqual(['c', 'a']);
  });
});

describe('splitHistoryOutput', () => {
  it('распознаёт bash-маркер', () => {
    expect(splitHistoryOutput('@@BASH@@\nls\n')).toEqual({ format: 'bash', body: 'ls\n' });
  });

  it('распознаёт zsh-маркер', () => {
    expect(splitHistoryOutput('@@ZSH@@\n: 1:0;ls\n')).toEqual({ format: 'zsh', body: ': 1:0;ls\n' });
  });

  it('нет маркера (файлов истории нет) → null', () => {
    expect(splitHistoryOutput('')).toBeNull();
    expect(splitHistoryOutput('some noise\n')).toBeNull();
  });
});
