import { memo } from 'react';

export const DiffView = memo(function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <div className="overflow-x-auto rounded-lg border border-linesoft bg-[#0e1013]">
      <pre className="mono min-w-max px-0 py-1.5 text-[12px] leading-[1.6]">
        {lines.map((line, i) => {
          let cls = 'text-[#aeb4bf]';
          let bg = '';
          if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-dim';
          else if (line.startsWith('@@')) {
            cls = 'text-[#7ca7f0]';
            bg = 'bg-[#131a26]';
          } else if (line.startsWith('+')) {
            cls = 'text-[#8ce09a]';
            bg = 'bg-[#12241a]';
          } else if (line.startsWith('-')) {
            cls = 'text-[#ff9a94]';
            bg = 'bg-[#291517]';
          }
          return (
            <div key={i} className={`px-3 ${bg} ${cls}`}>
              {line || ' '}
            </div>
          );
        })}
      </pre>
    </div>
  );
});
