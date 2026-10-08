/** React-query keys and the list query for Settings → 3D models (kept apart so the Settings card stays light). */
import { useQuery } from '@tanstack/react-query';
import { models3dApi } from '../../engineer/damage3d/exact/exactApi';

export const m3k = {
  list: ['models3d', 'list'] as const,
  limits: ['models3d', 'limits'] as const,
  one: (id: string) => ['models3d', 'one', id] as const,
};

export function useModels3d() {
  return useQuery({ queryKey: m3k.list, queryFn: ({ signal }) => models3dApi.list(signal), staleTime: 15_000 });
}
