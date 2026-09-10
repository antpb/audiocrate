export interface GraphLink {
  source: string;
  sourceOutput: string;
  target: string;
  targetInput: string;
}

export function isMainAudioInlet(name: string): boolean {
  return name === 'input';
}

export function isMainAudioOutlet(name: string): boolean {
  return name === 'audio' || name === 'cv';
}

function linkKey(link: GraphLink): string {
  return `${link.source}:${link.sourceOutput}->${link.target}:${link.targetInput}`;
}

/**
 * Cables that replace a removed insert: every main-input source is wired to
 * every main-output destination. Sidechain and CV inlets are dropped. The
 * existing graph is left unchanged; the caller removes the node and adds
 * these links.
 */
export function passthroughLinks(nodeId: string, links: readonly GraphLink[]): GraphLink[] {
  const incoming = links.filter((link) => link.target === nodeId && isMainAudioInlet(link.targetInput));
  const outgoing = links.filter((link) => link.source === nodeId && isMainAudioOutlet(link.sourceOutput));
  if (incoming.length === 0 || outgoing.length === 0) return [];

  const existing = new Set(links.map(linkKey));
  const next: GraphLink[] = [];
  for (const inn of incoming) {
    for (const out of outgoing) {
      if (inn.source === out.target) continue;
      const link: GraphLink = {
        source: inn.source,
        sourceOutput: inn.sourceOutput,
        target: out.target,
        targetInput: out.targetInput,
      };
      const key = linkKey(link);
      if (existing.has(key)) continue;
      existing.add(key);
      next.push(link);
    }
  }
  return next;
}
