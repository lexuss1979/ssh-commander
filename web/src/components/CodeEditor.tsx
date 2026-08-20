import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
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
}

function currentThemeIsDark(): boolean {
  return document.documentElement.dataset.theme !== 'light';
}

export default function CodeEditor({ value, fileName, onChange, readOnly }: Props) {
  const [dark, setDark] = useState(currentThemeIsDark);
  const [langExtension, setLangExtension] = useState<Extension | null>(null);

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
    if (langExtension) exts.push(langExtension);
    return exts;
  }, [langExtension]);

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
