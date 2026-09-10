export interface NodeMenuRequest {
  nodeId: string;
  x: number;
  y: number;
}

type Listener = (request: NodeMenuRequest) => void;

const listeners = new Set<Listener>();

export function requestNodeMenu(request: NodeMenuRequest): void {
  for (const listen of listeners) listen(request);
}

export function onNodeMenuRequest(listen: Listener): () => void {
  listeners.add(listen);
  return () => {
    listeners.delete(listen);
  };
}
