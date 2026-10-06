import { memo, useState, useCallback, useRef, createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useT } from '../i18n';

interface Props {
  content: string;
  /**
   * The "Insert into editor" button on ```sql blocks (the SQL console of the
   * "Databases" tab: agent reply → editor). Not set — no button.
   */
  onInsertSql?: (sql: string) => void;
}

const InsertSqlContext = createContext<((sql: string) => void) | null>(null);

/** The block language from the className of a child `<code class="language-*">`. */
function codeLanguage(children: ReactNode): string | null {
  if (Array.isArray(children)) children = children[0];
  if (typeof children === 'object' && children !== null && 'props' in children) {
    const cls = (children.props as { className?: string })?.className ?? '';
    const m = /language-([\w+-]+)/.exec(cls);
    return m ? m[1].toLowerCase() : null;
  }
  return null;
}

/** A <pre> block with a "Copy" button; sql blocks additionally get "To SQL". */
function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const { children, ...rest } = props;
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const onInsertSql = useContext(InsertSqlContext);
  const isSql = onInsertSql && codeLanguage(children as ReactNode)?.endsWith('sql');

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? '';
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  const handleInsert = useCallback(() => {
    const text = preRef.current?.textContent ?? '';
    if (text) onInsertSql?.(text.trim());
  }, [onInsertSql]);

  return (
    <div className="code-block-wrap">
      <pre {...rest} ref={preRef}>{children}</pre>
      <span className="code-block-actions">
        {isSql && (
          <button
            className="code-copy-btn code-insert-btn"
            onClick={handleInsert}
            title={t('markdown.insertSqlTitle')}
            aria-label={t('markdown.insertSqlAria')}
          >
            → SQL
          </button>
        )}
        <button
          className="code-copy-btn"
          onClick={handleCopy}
          title={t('markdown.copyTitle')}
          aria-label={t('markdown.copyAria')}
        >
          {copied ? '✓' : '📋'}
        </button>
      </span>
    </div>
  );
}

/**
 * Renders chat messages as markdown (GFM: tables, lists, code, links).
 * react-markdown does not render raw HTML, so model output is safe.
 */
export const Markdown = memo(function Markdown({ content, onInsertSql }: Props) {
  return (
    <InsertSqlContext.Provider value={onInsertSql ?? null}>
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock as Components['pre'] }}>
          {content}
        </ReactMarkdown>
      </div>
    </InsertSqlContext.Provider>
  );
});
