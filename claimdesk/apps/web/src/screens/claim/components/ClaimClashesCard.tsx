// owned by ap-clash
/**
 * Clashes card for a claim (docs/SUPREME-AUTOPILOT.md §C.5): the stored findings with "Check again". For the top of the
 * Autopilot tab (ap-autopilot) and the Flags tab. Overrides happen where the booking is made (booking dialog), so the
 * panel here only offers "I've read this" for warnings.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { Badge } from '../../../components/Badge';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { clashApi, clashQk, useAcknowledgeClash, useClaimClashes } from '../../../api/clashApi';
import { ClashPanel } from './ClashPanel';

export function ClaimClashesCard({ claimId, title = 'Clashes' }: { claimId: string; title?: string }) {
  const q = useClaimClashes(claimId);
  const ack = useAcknowledgeClash();
  const qc = useQueryClient();
  const toast = useToast();
  const recheck = useMutation({ mutationFn: () => clashApi.check({ claimId }), onSettled: () => qc.invalidateQueries({ queryKey: clashQk.claim(claimId) }) });
  const counts = q.data?.counts;
  return (
    <Card
      title={
        <span className="row">
          {title}
          {counts && counts.block > 0 && <Badge tone="red">{counts.block} blocking</Badge>}
          {counts && counts.warn > 0 && <Badge tone="amber">{counts.warn} warning{counts.warn === 1 ? '' : 's'}</Badge>}
        </span>
      }
      actions={
        <Button size="sm" loading={recheck.isPending} onClick={() => recheck.mutate(undefined, { onError: (e) => toast.error(e instanceof Error ? e.message : String(e)) })}>
          Check again
        </Button>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ApiErrorNotice error={q.error} />
      ) : (
        <ClashPanel
          findings={q.data?.findings ?? []}
          managerMode={false}
          onAcknowledge={(id, reason) =>
            ack.mutate({ id, reason }, { onSuccess: () => toast.success('Noted — the autopilot can carry on'), onError: (e) => toast.error(e instanceof Error ? e.message : String(e)) })
          }
          onOverride={() => undefined}
        />
      )}
    </Card>
  );
}
