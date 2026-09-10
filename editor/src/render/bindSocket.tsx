import { PatchSocket } from './PatchSocket';

export function bindSocket(info: { nodeId: string; side: 'input' | 'output'; key: string }) {
  return function BoundSocket(props: { data: { name: string } }) {
    return <PatchSocket data={props.data} nodeId={info.nodeId} side={info.side} socketKey={info.key} />;
  };
}
