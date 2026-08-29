import { Check, Copy } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('python', python);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`rounded-md p-1 text-dim transition-colors hover:bg-bg3 hover:text-ink ${className}`}
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
    </button>
  );
}

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const text = String(children ?? '').replace(/\n$/, '');
  const lang = /language-(\w+)/.exec(className ?? '')?.[1];
  let html: string | null = null;
  if (lang && hljs.getLanguage(lang)) {
    try {
      html = hljs.highlight(text, { language: lang }).value;
    } catch { /* fall through to plain */ }
  }
  return (
    <span className="group/code relative block">
      <CopyButton text={text} className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover/code:opacity-100 bg-bg2/80" />
      {html ? (
        <code className={className} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code className={className}>{text}</code>
      )}
    </span>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: (props) => {
            const { className, children } = props as { className?: string; children?: React.ReactNode };
            const isBlock = /language-/.test(className ?? '') || String(children ?? '').includes('\n');
            if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
            return <code>{children}</code>;
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">{children}</a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
