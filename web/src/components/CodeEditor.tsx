import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { search } from '@codemirror/search';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Extension } from '@codemirror/state';

interface Props {
  value: string;
  fileName: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  /** Ctrl/Cmd+Enter — «выполнить» (SQL-консоль вкладки «Базы данных»). */
  onRun?: () => void;
}

function currentThemeIsDark(): boolean {
  return document.documentElement.dataset.theme !== 'light';
}

export default function CodeEditor({ value, fileName, onChange, readOnly, onRun }: Props) {
  const [dark, setDark] = useState(currentThemeIsDark);
  const [langExtension, setLangExtension] = useState<Extension | null>(null);
  // Стабильный ref: onRun у SQL-консоли меняет identity на каждый ввод —
  // иначе keymap пересобирал бы extensions на каждое нажатие клавиши.
  const onRunRef = useRef(onRun);
  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);;

  // Тема редактора синхронизирована с data-theme документа
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(currentThemeIsDark()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  // Подсветка по имени/расширению файла (language-data грузит режимы лениво)
  useEffect(() => {
    let cancelled = false;
    const desc = LanguageDescription.matchFilename(languages, fileName);
    if (!desc) {
      setLangExtension(null);
      return;
    }
    desc
      .load()
      .then((support) => {
        if (!cancelled) setLangExtension(support.extension);
      })
      .catch(() => {
        if (!cancelled) setLangExtension(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fileName]);

  const extensions = useMemo(() => {
    const exts: Extension[] = [EditorView.lineWrapping, search({ top: true })];
    // Модификатор никогда не «включается» посреди жизни редактора: FilesPage
    // не передаёт onRun, DatabasesPage — передаёт всегда.
    if (onRun !== undefined) {
      exts.push(
        Prec.highest(keymap.of([
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              onRunRef.current?.();
              return true;
            },
          },
        ])),
      );
    }
    if (langExtension) exts.push(langExtension);
    return exts;
  }, [langExtension, onRun !== undefined]);

  return (
    <div className="code-editor-wrap">
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={dark ? oneDark : 'light'}
        extensions={extensions}
        readOnly={readOnly}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          autocompletion: false,
        }}
      />
    </div>
  );
}
