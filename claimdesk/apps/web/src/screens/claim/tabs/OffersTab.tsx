import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { InterventionOffer } from '@ccguk/domain';
import { formatGBP } from '@ccguk/domain';
import { useCreateDocument, useOffers, usePostOffer, useUpdateOffer } from '../../../api/hooks';
import { Card } from '../../../components/Card';
import { Table, type Column } from '../../../components/Table';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { DateText } from '../../../components/DateText';
import { Money } from '../../../components/Money';
import { ClockPill } from '../../../components/ClockPill';
import { Checkbox, DateTimeInput, MoneyInput, Select, TextArea, TextInput, YesNo } from '../../../components/Form';
import { EmptyState } from '../../../components/EmptyState';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { pickList, type ClaimView } from '../claimFile';
import { useClaimClocks } from '../useClaimDerived';
import { BasisText } from '../components/BasisText';
import { EvidencePicker } from '../components/EvidencePicker';
import { CHANNEL_LABEL, CHANNEL_OPTIONS, DECISION_LABEL, decisionBodyFrom, emptyOfferForm, offerBodyFrom, offerFormFrom, REGISTER_NOTE, replyClockForOffer, replyState, type OfferDecisionForm, type OfferForm, type ReplyState } from '../lib/offers';

const REPLY_TONE: Record<ReplyState, 'green' | 'red' | 'amber' | 'grey'> = { sent: 'green', late: 'amber', overdue: 'red', due: 'amber', none: 'grey' };
const REPLY_WORD: Record<ReplyState, string> = { sent: 'replied in time', late: 'replied late', overdue: 'reply overdue', due: 'reply due', none: 'no reply clock' };

type Dialog = { kind: 'add' } | { kind: 'edit'; offer: InterventionOffer } | { kind: 'decision'; offer: InterventionOffer } | { kind: 'reply'; offer: InterventionOffer } | null;

/** Lesson c: the intervention register. Every offer, the client's decision in their words, and the written reply within 1 working day. */
export function OffersTab({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const offersQ = useOffers(claimId);
  const offers = pickList(offersQ.data, view.offers);
  const { clocks } = useClaimClocks(view);
  const now = new Date();
  const [dialog, setDialog] = useState<Dialog>(null);
  const create = useCreateDocument(claimId);
  const navigate = useNavigate();
  const toast = useToast();
  const offerEvents = useMemo(() => new Map(view.events.filter((e) => e.type === 'intervention_offer').map((e) => [String((e.data as { offerId?: string } | undefined)?.offerId ?? ''), e.id])), [view.events]);

  const generateReply = (o: InterventionOffer) => {
    create.mutate(
      { templateId: 'letter.intervention_reply', data: { offerId: o.id }, recipientPartyId: o.offerorPartyId },
      {
        onSuccess: (doc) => {
          toast.success('Reply drafted — check the consistency report, approve, then send and mark the reply sent');
          navigate(`/claims/${claimId}/documents/${doc.id}`);
        }
      }
    );
  };

  const sorted = [...offers].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const columns: Column<InterventionOffer>[] = [
    { key: 'received', header: 'Received', render: (o) => <DateText value={o.receivedAt} time /> },
    { key: 'channel', header: 'Channel', render: (o) => CHANNEL_LABEL[o.channel] },
    { key: 'offeror', header: 'Offeror', render: (o) => o.offerorName },
    { key: 'class', header: 'Vehicle class', className: 'wrap', render: (o) => o.vehicleClassOffered ?? <span className="muted">not stated</span> },
    {
      key: 'rate',
      header: 'Rate',
      numeric: true,
      render: (o) =>
        o.dailyRatePence !== undefined ? (
          <span>
            <Money pence={o.dailyRatePence} />
            <span className="xs muted">/day {o.rateIncludesVat ? 'inc VAT' : 'ex VAT'}</span>
          </span>
        ) : (
          <span className="muted">—</span>
        )
    },
    {
      key: 'terms',
      header: 'Terms',
      className: 'wrap',
      render: (o) => {
        const t = o.terms;
        const parts = [
          t.excessPence !== undefined ? `excess ${formatGBP(t.excessPence)}` : '',
          t.mileageLimitPerDay !== undefined ? `${t.mileageLimitPerDay} mi/day` : '',
          t.deliveryIncluded === undefined ? '' : t.deliveryIncluded ? 'delivery incl.' : 'no delivery',
          t.insuranceIncluded === undefined ? '' : t.insuranceIncluded ? 'insurance incl.' : 'no insurance',
          t.durationStated ? `duration: ${t.durationStated}` : '',
          t.otherTerms ?? ''
        ].filter(Boolean);
        return parts.length ? <span className="xs">{parts.join(' · ')}</span> : <span className="muted">none recorded</span>;
      }
    },
    {
      key: 'suitable',
      header: 'Suitable',
      render: (o) => (
        <div>
          {o.suitable === undefined ? <Badge tone="grey">not assessed</Badge> : o.suitable ? <Badge tone="green">yes</Badge> : <Badge tone="amber">no</Badge>}
          {o.suitabilityReasons.length > 0 && <div className="xs muted">{o.suitabilityReasons.join('; ')}</div>}
        </div>
      )
    },
    {
      key: 'decision',
      header: 'Client decision',
      className: 'wrap',
      render: (o) => (
        <div>
          <Badge tone={o.clientDecision === 'pending' ? 'amber' : o.clientDecision === 'accepted' ? 'blue' : 'grey'}>{DECISION_LABEL[o.clientDecision]}</Badge>
          {o.clientDecisionAt && (
            <div className="xs muted">
              <DateText value={o.clientDecisionAt} time />
            </div>
          )}
          {o.clientReasons && <div className="xs">“{o.clientReasons}”</div>}
        </div>
      )
    },
    {
      key: 'reply',
      header: 'Written reply (1 WD)',
      render: (o) => {
        const clock = replyClockForOffer(clocks, o, offerEvents.get(o.id));
        const state = replyState(o, clock, now);
        return (
          <div className="stack-sm" style={{ gap: 2 }}>
            <Badge tone={REPLY_TONE[state]} dot>
              {REPLY_WORD[state]}
            </Badge>
            {o.replySentAt ? (
              <span className="xs">
                sent <DateText value={o.replySentAt} time />
                {o.replyDocumentId && (
                  <>
                    {' '}
                    · <Link to={`../documents/${o.replyDocumentId}`}>letter</Link>
                  </>
                )}
              </span>
            ) : clock ? (
              <ClockPill clock={clock} now={now} />
            ) : (
              <span className="xs muted">clock derives once the API has the offer</span>
            )}
          </div>
        );
      }
    },
    {
      key: 'actions',
      header: '',
      render: (o) => (
        <div className="stack-sm" style={{ gap: 4, alignItems: 'flex-end' }}>
          {!o.replySentAt && (
            <Button size="sm" variant="primary" onClick={() => generateReply(o)} loading={create.isPending}>
              Generate reply
            </Button>
          )}
          {o.clientDecision === 'pending' && (
            <Button size="sm" onClick={() => setDialog({ kind: 'decision', offer: o })}>
              Record decision
            </Button>
          )}
          {!o.replySentAt && (
            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'reply', offer: o })}>
              Mark reply sent
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'edit', offer: o })}>
            Suitability / evidence
          </Button>
        </div>
      )
    }
  ];

  const replyClockDef = clocks.find((c) => c.kind === 'intervention_reply_1wd');

  return (
    <div className="stack">
      <div className="notice notice-info">
        <strong>Register.</strong> {REGISTER_NOTE}
        {replyClockDef && (
          <div style={{ marginTop: 4 }}>
            <BasisText basis={replyClockDef.basis} />
          </div>
        )}
      </div>
      <Card
        title="Intervention offers"
        flush
        actions={
          <Button size="sm" variant="primary" onClick={() => setDialog({ kind: 'add' })}>
            Log an offer
          </Button>
        }
      >
        <ApiErrorNotice error={offersQ.error} what="load the register" />
        <ApiErrorNotice error={create.error} what="draft the reply" />
        <Table columns={columns} rows={sorted} rowKey={(o) => o.id} caption="Intervention register" empty={<EmptyState title="No offers logged">When the client reports an offer — what exactly, by whom, when — log it here. The 1-working-day reply clock starts from the time received.</EmptyState>} />
      </Card>

      {(dialog?.kind === 'add' || dialog?.kind === 'edit') && <OfferDialog claimId={claimId} view={view} offer={dialog.kind === 'edit' ? dialog.offer : undefined} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'decision' && <DecisionDialog claimId={claimId} offer={dialog.offer} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'reply' && <ReplySentDialog claimId={claimId} view={view} offer={dialog.offer} onClose={() => setDialog(null)} />}
    </div>
  );
}

function OfferDialog({ claimId, view, offer, onClose }: { claimId: string; view: ClaimView; offer?: InterventionOffer; onClose: () => void }) {
  const nowIso = new Date().toISOString();
  const [form, setForm] = useState<OfferForm>(() => (offer ? offerFormFrom(offer) : emptyOfferForm(nowIso)));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const post = usePostOffer(claimId);
  const patch = useUpdateOffer(claimId);
  const toast = useToast();
  const set = <K extends keyof OfferForm>(k: K, v: OfferForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const editing = Boolean(offer);
  const parties = [view.atFaultInsurer, ...view.thirdParties].filter((p): p is NonNullable<typeof p> => Boolean(p));

  const submit = () => {
    if (offer) {
      // PATCH accepts suitability, reasons and evidence only: the facts of the offer (what / who / when) are immutable.
      const reasons = form.suitabilityReasons
        .split(/\n|;/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (form.suitable === false && reasons.length === 0) return setErrors({ suitabilityReasons: 'Say why the offer was not suitable (one reason per line)' });
      setErrors({});
      patch.mutate(
        { offerId: offer.id, body: { suitable: form.suitable, suitabilityReasons: reasons, evidenceIds: form.evidenceIds } },
        {
          onSuccess: () => {
            toast.success('Offer updated');
            onClose();
          }
        }
      );
      return;
    }
    const r = offerBodyFrom(form, new Date().toISOString());
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    post.mutate(r.body, {
      onSuccess: () => {
        toast.success('Offer logged — the 1-working-day reply clock is running');
        onClose();
      }
    });
  };

  return (
    <Modal
      open
      size="lg"
      title={editing ? `Offer from ${offer!.offerorName}` : 'Log an intervention offer'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={post.isPending || patch.isPending} onClick={submit}>
            {editing ? 'Save' : 'Log offer'}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {editing && <div className="notice notice-info xs">What was offered, by whom and when is fixed once logged (it is evidence). If the facts were wrong, log a new offer and note the correction on the chronology.</div>}
        <fieldset className="fieldset" disabled={editing}>
          <legend>What, by whom, when</legend>
          <div className="form-grid">
            <TextInput label="By whom (offeror)" required value={form.offerorName} onChange={(v) => set('offerorName', v)} error={errors.offerorName} autoFocus={!editing} placeholder="Insurer / company / person the client named" />
            <Select label="Offeror on file" value={form.offerorPartyId} onChange={(v) => set('offerorPartyId', v)} options={parties.map((p) => ({ value: p.id, label: p.name }))} placeholder="— (not a party on file)" />
            <Select label="How" required value={form.channel} onChange={(v) => set('channel', v)} options={CHANNEL_OPTIONS} error={errors.channel} />
            <DateTimeInput label="When received" required value={form.receivedAt} onChange={(v) => set('receivedAt', v)} error={errors.receivedAt} />
            <TextInput label="What exactly (vehicle / class)" value={form.vehicleClassOffered} onChange={(v) => set('vehicleClassOffered', v)} error={errors.vehicleClassOffered} placeholder="e.g. 'a small hatchback', 'like-for-like SUV'" className="span-2" />
            <MoneyInput label="Daily rate quoted (£)" value={form.dailyRatePence} onChange={(v) => set('dailyRatePence', v)} hint="Leave blank if no rate was mentioned" />
            <div className="field" style={{ justifyContent: 'flex-end' }}>
              <Checkbox label="Rate stated as including VAT" checked={form.rateIncludesVat} onChange={(v) => set('rateIncludesVat', v)} disabled={form.dailyRatePence === null} />
            </div>
            <MoneyInput label="Excess mentioned (£)" value={form.excessPence} onChange={(v) => set('excessPence', v)} />
            <TextInput label="Mileage limit per day" value={form.mileageLimitPerDay} onChange={(v) => set('mileageLimitPerDay', v)} inputMode="numeric" error={errors.mileageLimitPerDay} />
            <YesNo label="Delivery included?" value={form.deliveryIncluded} onChange={(v) => set('deliveryIncluded', v)} />
            <YesNo label="Insurance included?" value={form.insuranceIncluded} onChange={(v) => set('insuranceIncluded', v)} />
            <TextInput label="Duration stated" value={form.durationStated} onChange={(v) => set('durationStated', v)} placeholder="e.g. 'until repairs are done'" />
            <TextArea label="Other terms, in the client's words" value={form.otherTerms} onChange={(v) => set('otherTerms', v)} rows={2} />
          </div>
        </fieldset>
        <fieldset className="fieldset">
          <legend>Suitability (Copley v Lawn; Opoku v Tintas)</legend>
          <YesNo label="Was the offer suitable for this client's need?" value={form.suitable} onChange={(v) => set('suitable', v)} hint="Like-for-like class, terms explained, timing, excess, mileage, insurance — compared with what the client needs" />
          <TextArea label="Reasons (one per line)" value={form.suitabilityReasons} onChange={(v) => set('suitabilityReasons', v)} rows={3} error={errors.suitabilityReasons} placeholder="e.g. Client needs an estate for work equipment; offer was a small hatchback" />
        </fieldset>
        <EvidencePicker label="Evidence of the offer (letter, email, call note, screenshot)" evidence={view.evidence} value={form.evidenceIds} onChange={(ids) => set('evidenceIds', ids)} />
        <ApiErrorNotice error={post.error ?? patch.error} what="save the offer" />
      </form>
    </Modal>
  );
}

function DecisionDialog({ claimId, offer, onClose }: { claimId: string; offer: InterventionOffer; onClose: () => void }) {
  const [form, setForm] = useState<OfferDecisionForm>({ clientDecision: '', clientReasons: '', clientDecisionAt: new Date().toISOString() });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const patch = useUpdateOffer(claimId);
  const toast = useToast();
  const submit = () => {
    const r = decisionBodyFrom(form);
    if (!r.ok) return setErrors(r.errors);
    patch.mutate(
      { offerId: offer.id, body: r.body },
      {
        onSuccess: () => {
          toast.success("Client's decision recorded");
          onClose();
        }
      }
    );
  };
  return (
    <Modal
      open
      title={`Client's decision on the offer from ${offer.offerorName}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={patch.isPending} onClick={submit}>
            Record decision
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="small muted">Record what the client decided and the reasons they gave, in their words. The Mitigation Questionnaire (statement of truth) is generated from this entry.</p>
        <Select label="Decision" required value={form.clientDecision} onChange={(v) => setForm((f) => ({ ...f, clientDecision: v }))} options={[{ value: 'accepted', label: 'Client accepted the offer' }, { value: 'declined', label: 'Client declined the offer' }]} placeholder="Choose…" error={errors.clientDecision} autoFocus />
        <TextArea label="Client's reasons, as given" required value={form.clientReasons} onChange={(v) => setForm((f) => ({ ...f, clientReasons: v }))} rows={3} error={errors.clientReasons} />
        <DateTimeInput label="Decided at" required value={form.clientDecisionAt} onChange={(v) => setForm((f) => ({ ...f, clientDecisionAt: v }))} error={errors.clientDecisionAt} />
        <ApiErrorNotice error={patch.error} what="record the decision" />
      </form>
    </Modal>
  );
}

function ReplySentDialog({ claimId, view, offer, onClose }: { claimId: string; view: ClaimView; offer: InterventionOffer; onClose: () => void }) {
  const [replySentAt, setReplySentAt] = useState(new Date().toISOString());
  const [replyDocumentId, setReplyDocumentId] = useState('');
  const [error, setError] = useState<string | undefined>();
  const patch = useUpdateOffer(claimId);
  const toast = useToast();
  const replies = view.documents.filter((d) => d.templateId === 'letter.intervention_reply');
  const submit = () => {
    if (!replySentAt) return setError('When was the written reply sent?');
    patch.mutate(
      { offerId: offer.id, body: { replySentAt, replyDocumentId: replyDocumentId || undefined } },
      {
        onSuccess: () => {
          toast.success('Reply recorded — the 1-working-day clock is met');
          onClose();
        }
      }
    );
  };
  return (
    <Modal
      open
      title="Mark the written reply as sent"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={patch.isPending} onClick={submit}>
            Mark sent
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DateTimeInput label="Reply sent at" required value={replySentAt} onChange={setReplySentAt} error={error} autoFocus />
        <Select label="Reply letter on file" value={replyDocumentId} onChange={setReplyDocumentId} options={replies.map((d) => ({ value: d.id, label: `${d.title} · ${d.status} · ${d.createdAt.slice(0, 10)}` }))} placeholder="— (sent outside ClaimDesk)" hint="Prefer generating the reply so the consistency engine checks it first" />
        {replies.some((d) => d.id === replyDocumentId && d.status !== 'sent' && d.status !== 'signed') && <div className="notice notice-warn xs">That letter has not been marked as sent on the Documents tab. Nothing is sent automatically — send it there first.</div>}
        <ApiErrorNotice error={patch.error} what="record the reply" />
      </form>
    </Modal>
  );
}

