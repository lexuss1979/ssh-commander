import { memo, useState, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  content: string;
}

/** Блок <pre> с кнопкой «Копировать» в правом верхнем углу. */
function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const { children, ...rest } = props;
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? '';
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  return (
    <div className="code-block-wrap">
      <pre {...rest} ref={preRef}>{children}</pre>
      <button
        className="code-copy-btn"
        onClick={handleCopy}
        title="Копировать"
        aria-label="Копировать код"
      >
        {copied ? '✓' : '📋'}
      </button>
    </div>
  );
}

const components: Components = {
  pre: CodeBlock as Components['pre'],
};

/**
 * Рендер сообщений чата как markdown (GFM: таблицы, списки, код, ссылки).
 * react-markdown не рендерит сырой HTML, поэтому вывод модели безопасен.
 */
export const Markdown = memo(function Markdown({ content }: Props) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>
    </div>
  );
});
