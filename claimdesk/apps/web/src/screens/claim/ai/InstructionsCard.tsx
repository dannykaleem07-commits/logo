// owned by claimai-web
/**
 * Standing instructions (docs/CLAIM-AI-INPUT.md §7.4, §14.2): what the owner told the agents to do (or not do) on this
 * claim — text, who follows it, its effect, until when, who added it and from which input — with Remove (reason
 * optional) and Add an instruction. Ended and removed ones sit under "Earlier". Code enforces the holds; the agents read
 * every active instruction in their brief.
 */
import { useState } from 'react';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { DateInput, TextArea } from '../../../components/Form';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { ReasonDialog } from '../components/ReasonDialog';
import { useClaimAiMutations, type AgentScope, type StandingInstruction } from '../../../api/claimAiApi';
import { AGENT_SCOPE_LABEL, AGENT_SCOPES, toggleScope, whenText } from './aiInputModel';

const STATUS_TONE = { active: 'green', ended: 'grey', retired: 'grey' } as const;
const STATUS_TEXT = { active: 'Active', ended: 'Ended', retired: 'Removed' } as const;

function InstructionItem({ ins, onRemove, onOpenInput }: { ins: StandingInstruction; onRemove?: () => void; onOpenInput?: (inputId: string) => void }) {
  return (
    <li className={`aiin-instruction aiin-instruction-${ins.status}`}>
      <div className="aiin-instruction-text">{ins.text}</div>
      <div className="aiin-line-chips">
        {(ins.appliesTo.length ? ins.appliesTo : (['all'] as AgentScope[])).map((s) => (
          <span key={s} className="aiin-scope-chip">
            {AGENT_SCOPE_LABEL[s] ?? s}
          </span>
        ))}
        {ins.effectLabel && <Badge tone="navy">{ins.effectLabel}</Badge>}
        <Badge tone={STATUS_TONE[ins.status]}>{STATUS_TEXT[ins.status]}</Badge>
      </div>
      <div className="xs muted">
        {ins.until ? `Until ${whenText(ins.until)}` : 'Until you remove it'} · added {whenText(ins.createdAt)}
        {ins.createdByName ? ` by ${ins.createdByName}` : ''}
        {ins.source && onOpenInput && (
          <>
            {' · '}
            <button type="button" className="aiin-linkish" onClick={() => onOpenInput(ins.source!.inputId)}>
              from your update
            </button>
          </>
        )}
        {ins.status === 'retired' && ins.retiredAt && ` · removed ${whenText(ins.retiredAt)}${ins.retiredReason ? ` (${ins.retiredReason})` : ''}`}
      </div>
      {onRemove && (
        <div>
          <Button size="sm" onClick={onRemove}>
            Remove
          </Button>
        </div>
      )}
    </li>
  );
}

export function InstructionsCard({ claimId, instructions, disabled, onOpenInput }: { claimId: string; instructions: StandingInstruction[]; disabled?: boolean; onOpenInput?: (inputId: string) => void }) {
  const m = useClaimAiMutations(claimId);
  const toast = useToast();
  const [removing, setRemoving] = useState<StandingInstruction | null>(null);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [scopes, setScopes] = useState<AgentScope[]>(['all']);
  const [until, setUntil] = useState('');
  const [touched, setTouched] = useState(false);
  const active = instructions.filter((i) => i.status === 'active');
  const earlier = instructions.filter((i) => i.status !== 'active');
  const textError = text.trim().length < 3 ? 'Say what the agents should do (at least 3 characters)' : text.length > 1000 ? 'Keep it under 1000 characters' : null;

  const add = () => {
    setTouched(true);
    if (textError) return;
    m.addInstruction.mutate(
      { text, appliesTo: scopes, until: until || null },
      {
        onSuccess: () => {
          toast.success('Instruction added — the agents follow it from now');
          setText('');
          setScopes(['all']);
          setUntil('');
          setTouched(false);
          setAdding(false);
        },
      },
    );
  };

  return (
    <Card title={`Standing instructions${active.length ? ` (${active.length})` : ''}`} className="aiin-instructions">
      <div className="stack-sm">
        {active.length === 0 && <p className="small muted">None. Tell ClaimDesk something like “don't chase the client until Monday” and it becomes a standing instruction.</p>}
        {active.length > 0 && (
          <ul className="aiin-instruction-list">
            {active.map((i) => (
              <InstructionItem key={i.id} ins={i} onRemove={disabled ? undefined : () => setRemoving(i)} onOpenInput={onOpenInput} />
            ))}
          </ul>
        )}
        {!adding && !disabled && (
          <div>
            <Button size="sm" onClick={() => setAdding(true)}>
              Add an instruction
            </Button>
          </div>
        )}
        {adding && (
          <form
            className="aiin-add-instruction stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <TextArea label="Instruction" value={text} onChange={setText} rows={2} maxLength={1000} required error={touched && textError ? textError : undefined} placeholder="e.g. Ask me before sending anything to the insurer" />
            <fieldset className="aiin-scopes">
              <legend className="field-label">Who should follow it</legend>
              {AGENT_SCOPES.map((s) => (
                <button key={s} type="button" className="aiin-chip-toggle" aria-pressed={scopes.includes(s)} onClick={() => setScopes((c) => toggleScope(c, s))}>
                  {AGENT_SCOPE_LABEL[s]}
                </button>
              ))}
            </fieldset>
            <DateInput label="Until (optional)" value={until} onChange={setUntil} hint="It ends at the start of that day. Leave empty to keep it until you remove it." />
            <ApiErrorNotice error={m.addInstruction.error} what="add the instruction" />
            <div className="row">
              <Button type="submit" variant="primary" loading={m.addInstruction.isPending}>
                Add
              </Button>
              <Button onClick={() => (setAdding(false), setTouched(false))}>Cancel</Button>
            </div>
          </form>
        )}
        {earlier.length > 0 && (
          <details className="aiin-earlier">
            <summary className="small">Earlier ({earlier.length})</summary>
            <ul className="aiin-instruction-list">
              {earlier.map((i) => (
                <InstructionItem key={i.id} ins={i} onOpenInput={onOpenInput} />
              ))}
            </ul>
          </details>
        )}
      </div>
      <ReasonDialog
        open={Boolean(removing)}
        title="Remove this instruction?"
        confirmLabel="Remove"
        minLength={0}
        busy={m.retireInstruction.isPending}
        error={m.retireInstruction.error}
        onClose={() => setRemoving(null)}
        onConfirm={(reason) =>
          removing &&
          m.retireInstruction.mutate(
            { id: removing.id, reason: reason || undefined },
            {
              onSuccess: () => {
                toast.success('Instruction removed — held steps become due again');
                setRemoving(null);
              },
            },
          )
        }
      >
        <p className="strong">{removing?.text}</p>
        <p className="small muted">The agents stop following it at once. The reason is optional and is logged with your name.</p>
      </ReasonDialog>
    </Card>
  );
}
