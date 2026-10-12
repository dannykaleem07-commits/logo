// owned by claimai-web
/**
 * A clarifying question (docs/CLAIM-AI-INPUT.md §5, §14.2): ClaimDesk asks instead of guessing. Option buttons answer at
 * once; a typed or dated answer is sent with "Answer".
 */
import { useId, useState } from 'react';
import { Button } from '../../../components/Button';
import { DateInput, TextInput } from '../../../components/Form';
import type { AnswerBody, AiQuestion } from '../../../api/claimAiApi';

export function QuestionCard({ question: q, onAnswer, busy = false }: { question: AiQuestion; onAnswer: (a: AnswerBody) => void; busy?: boolean }) {
  const id = useId();
  const [text, setText] = useState('');
  const [date, setDate] = useState('');
  const chosen = q.answer?.optionId ?? null;
  const canSend = (q.allowText && text.trim().length > 0) || (q.allowDate && date !== '');
  return (
    <div className="aiin-question" role="group" aria-labelledby={`${id}-q`}>
      <div id={`${id}-q`} className="aiin-question-text">
        {q.text}
      </div>
      {q.answer && (
        <div className="small muted">
          Your answer: {q.options.find((o) => o.id === q.answer?.optionId)?.label ?? q.answer.text ?? q.answer.date ?? '—'}
        </div>
      )}
      {q.options.length > 0 && (
        <div className="aiin-options">
          {q.options.map((o) => (
            <Button key={o.id} size="sm" variant={chosen === o.id ? 'primary' : 'secondary'} aria-pressed={chosen === o.id} disabled={busy} onClick={() => onAnswer({ questionId: q.id, optionId: o.id })}>
              {o.label}
            </Button>
          ))}
        </div>
      )}
      {(q.allowText || q.allowDate) && (
        <form
          className="aiin-answer-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSend) return;
            const a: AnswerBody = { questionId: q.id };
            if (q.allowText && text.trim()) a.text = text.trim().slice(0, 500);
            if (q.allowDate && date) a.date = date;
            onAnswer(a);
          }}
        >
          {q.allowText && <TextInput label="Or type your answer" value={text} onChange={setText} maxLength={500} />}
          {q.allowDate && <DateInput label="Date" value={date} onChange={setDate} />}
          <div className="field aiin-answer-send">
            <Button type="submit" size="sm" disabled={!canSend} loading={busy}>
              Answer
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
