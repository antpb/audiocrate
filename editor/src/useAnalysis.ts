import { useSyncExternalStore } from 'react';
import { analysisBus, silentAnalysis, type AnalysisView } from './analysisBus';

export function useAnalysis(id: string | null): AnalysisView {
  const version = useSyncExternalStore(
    (listener) => analysisBus.subscribe(listener),
    () => analysisBus.getVersion(),
  );
  void version;
  return (id ? analysisBus.get(id) : undefined) ?? silentAnalysis;
}
