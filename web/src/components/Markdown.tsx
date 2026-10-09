import { memo, useState, useCallback, createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useT } from '../i18n';
import { Mermaid } from './Mermaid';
import { Chart } from './Chart';
import { parseChartSpec } from '../chart-spec';

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

/** Plain text of a code block child tree (for copy buttons and mermaid source). */
function codeText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(codeText).join('');
  if (typeof children === 'object' && children !== null && 'props' in children) {
    return codeText((children.props as { children?: ReactNode }).children);
  }
  return '';
}

/** A <pre> block with a "Copy" button; sql blocks additionally get "To SQL". */
function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const { children, ...rest } = props;
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const [mermaidFailed, setMermaidFailed] = useState(false);
  const onInsertSql = useContext(InsertSqlContext);
  const lang = codeLanguage(children as ReactNode);
  const isSql = onInsertSql && lang?.endsWith('sql');
  const showMermaid = lang === 'mermaid' && !mermaidFailed;
  const text = codeText(children);
  // Invalid or still-streaming JSON falls back to the plain code block —
  // no latched error state, the chart "comes alive" once the JSON completes.
  const chartSpec = useMemo(
    () => (lang === 'chart' ? parseChartSpec(text.trim()) : null),
    [lang, text],
  );

  const handleCopy = useCallback(() => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  const handleInsert = useCallback(() => {
    if (text) onInsertSql?.(text.trim());
  }, [onInsertSql, text]);

  const handleMermaidError = useCallback(() => setMermaidFailed(true), []);

  return (
    <div className="code-block-wrap">
      {lang === 'mermaid' && mermaidFailed && (
        <div className="mermaid-error">{t('markdown.mermaidError')}</div>
      )}
      {showMermaid ? (
        <Mermaid code={text.trim()} onError={handleMermaidError} />
      ) : chartSpec ? (
        <Chart spec={chartSpec} />
      ) : (
        <pre {...rest}>{children}</pre>
      )}
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
