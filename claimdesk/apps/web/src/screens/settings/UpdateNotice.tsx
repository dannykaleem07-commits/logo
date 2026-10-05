/**
 * Side-bar footer link "Update available: 0.3.15" → Settings → Updates (docs/V03-MANAGER-MODE-HIRE-PRICING.md §F.3).
 * Renders nothing when up to date, offline, switched off or on any failure.
 */
import { Link } from 'react-router-dom';
import { UPDATE_NOTICE_STALE_MS, useUpdateCheck } from '../../api/updatesApi';
import { updateNoticeText } from './updates';

export function UpdateNotice() {
  const check = useUpdateCheck({ staleTime: UPDATE_NOTICE_STALE_MS, recheck: true });
  const text = check.isError ? undefined : updateNoticeText(check.data);
  if (!text) return null;
  return (
    <div className="xs update-notice" style={{ marginTop: 4 }}>
      <Link to="/settings#updates">{text}</Link>
    </div>
  );
}
