import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  content: string;
}

/**
 * Рендер сообщений чата как markdown (GFM: таблицы, списки, код, ссылки).
 * react-markdown не рендерит сырой HTML, поэтому вывод модели безопасен.
 */
export const Markdown = memo(function Markdown({ content }: Props) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
});
