import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A function whose identity never changes but always calls the latest `fn`. Dialogs pass it as `onClose`, so a
 * re-render on every keystroke never hands the Modal a "new" close function (the cause of fields losing focus after
 * each character — docs/V03-MANAGER-MODE-HIRE-PRICING.md §D.1). Belt and braces next to the Modal fix itself.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
