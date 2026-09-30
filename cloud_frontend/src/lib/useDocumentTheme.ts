"use client";

import { useDocumentTheme as useSharedDocumentTheme } from '@ivoryos/shared-ui';

/**
 * The theme the page is showing (shared-ui theme.tsx), starting from Cloud's server default: the
 * layout renders <html> dark unless the `theme` cookie says light.
 */
export function useDocumentTheme(): 'light' | 'dark' {
  return useSharedDocumentTheme('dark');
}
