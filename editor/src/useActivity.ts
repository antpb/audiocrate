import { useSyncExternalStore } from 'react';
import { activityBus, silentJack, type JackActivity, type NodeActivity } from './activity';

export function useActivityVersion(): number {
  return useSyncExternalStore(
    (listener) => activityBus.subscribe(listener),
    () => activityBus.getVersion(),
  );
}

export function useNodeActivity(id: string): NodeActivity | undefined {
  useActivityVersion();
  return activityBus.get(id);
}

export function useJackActivity(id: string, side: 'outputs' | 'inputs', key: string): JackActivity {
  useActivityVersion();
  return activityBus.jack(id, side, key) ?? silentJack();
}
