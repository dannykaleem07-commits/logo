// owned by casework
import { PageHeader } from '../../../components/PageHeader';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useBrainPacks } from '../../../api/brainApi';
import { PacksCard } from './PacksCard';
import { ImportCard } from './ImportCard';
import { SearchCard } from './SearchCard';
import { MemoryCard } from './MemoryCard';

/**
 * Settings > Brain packs (docs/SUPREME-DESIGN.md §L.10): the packs (name, version, entries, business tags, precedence,
 * active), import from the import folder / a .ccbrain file / a folder or skill path, preview before activating,
 * activate / roll back, a search box to test retrieval, and memory items awaiting approval.
 */
export function BrainSettingsPage() {
  const packs = useBrainPacks();
  return (
    <div className="page">
      <PageHeader title="Brain packs" subtitle="Company rules and playbooks the agents follow — private, kept on this computer" />
      <div className="stack">
        {packs.isLoading && <Loading />}
        <ApiErrorNotice error={packs.error} what="load the brain packs" />
        {packs.data && <PacksCard packs={packs.data.packs} />}
        <ImportCard staged={packs.data?.staged ?? []} />
        <SearchCard />
        <MemoryCard />
      </div>
    </div>
  );
}
