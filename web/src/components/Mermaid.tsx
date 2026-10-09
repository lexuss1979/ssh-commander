import { memo, useEffect, useState } from 'react';

function currentThemeIsDark(): boolean {
  return document.documentElement.dataset.theme !== 'light';
}

let renderSeq = 0;

interface Props {
  code: string;
  /** Called once when mermaid rejects the source — the parent falls back to the code block. */
  onError: () => void;
}

/**
 * Renders a ```mermaid code block to SVG. The library is imported lazily so
 * chats without diagrams never pay for it. securityLevel 'strict' sanitizes
 * labels (no scripts/links from model output); the theme follows data-theme.
 */
export const Mermaid = memo(function Mermaid({ code, onError }: Props) {
  const [svg, setSvg] = useState<string | null>(null);
  const [dark, setDark] = useState(currentThemeIsDark);

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(currentThemeIsDark()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${++renderSeq}`;
    (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });
        const result = await mermaid.render(id, code);
        if (!cancelled) setSvg(result.svg);
      } catch {
        // On a parse error mermaid leaves its error graphic in the document
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) onError();
      }
    })();
    return () => {
      cancelled = true;
      document.getElementById(`d${id}`)?.remove();
    };
  }, [code, dark, onError]);

  if (!svg) return <div className="mermaid-block mermaid-loading" aria-busy="true" />;
  return <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />;
});
