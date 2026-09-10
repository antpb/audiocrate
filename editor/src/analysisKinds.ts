import { isAnalysisKind as isCrateAnalysisKind } from '../../src/index';

export function isAnalysisKind(kind: string): boolean {
  return isCrateAnalysisKind(kind);
}

export function analysisKinds(): readonly string[] {
  return ['meter', 'scope', 'analyzer', 'tuner'];
}
