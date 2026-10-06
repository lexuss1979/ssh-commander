import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { search } from '@codemirror/search';
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { nginx as nginxMode } from '@codemirror/legacy-modes/mode/nginx';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Extension } from '@codemirror/state';

/** Highlighting of nginx configs by full path (not only name *.conf):
 *  those opened from the file manager, `/etc/nginx/sites-available/…` or
 *  `/etc/nginx/conf.d/*.conf`, do not contain "nginx" in the basename. */
const NGINX_LANG = LanguageDescription.of({
  name: 'Nginx',
  filename: /(^|\/)nginx\/|(^|\/)sites-(available|enabled)\//i,
  load: async () => new LanguageSupport(StreamLanguage.define(nginxMode)),
});

interface Props {
  value: string;
  fileName: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  /** Ctrl/Cmd+Enter — "run" (the SQL console of the "Databases" tab). */
  onRun?: () => void;
}

function currentThemeIsDark(): boolean {
  return document.documentElement.dataset.theme !== 'light';
}

export default function CodeEditor({ value, fileName, onChange, readOnly, onRun }: Props) {
  const [dark, setDark] = useState(currentThemeIsDark);
  const [langExtension, setLangExtension] = useState<Extension | null>(null);
  // A stable ref: the SQL console's onRun changes identity on every input —
  // otherwise the keymap would rebuild extensions on every keystroke.
  const onRunRef = useRef(onRun);
  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);;

  // The editor theme is synchronized with the document's data-theme
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(currentThemeIsDark()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  // Highlighting by file name/extension (language-data loads modes lazily).
  // First try the basename (Dockerfile/sh/json etc. match by extension and
  // special names), then nginx by the full path (conf.d/sites-*).
  useEffect(() => {
    let cancelled = false;
    const base = fileName.split('/').pop() ?? fileName;
    let desc = LanguageDescription.matchFilename(languages, base);
    if (!desc && base !== fileName) {
      desc = LanguageDescription.matchFilename([NGINX_LANG], fileName);
    }
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
    // The modifier never "turns on" in the middle of the editor's life: FilesPage
    // does not pass onRun, DatabasesPage always does.
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
