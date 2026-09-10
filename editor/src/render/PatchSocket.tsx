import { jackFromOutputs, silentJack } from '../activity';
import { useNodeActivity } from '../useActivity';

interface PatchSocketProps {
  data: { name: string };
  nodeId: string;
  side: 'input' | 'output';
  socketKey: string;
}

export function PatchSocket({ data, nodeId, side, socketKey }: PatchSocketProps) {
  const node = useNodeActivity(nodeId);
  const activity =
    side === 'output'
      ? jackFromOutputs(node?.outputs, socketKey)
      : node?.inputs[socketKey] ?? silentJack();
  const control = data.name !== 'audio' && socketKey !== 'audio' && socketKey !== 'input';
  const fill = Math.min(1, Math.max(activity.peak, Math.abs(activity.mean)));
  return (
    <span
      className={`psock${control ? ' cv' : ' audio'}${activity.pulse ? ' pulse' : ''}`}
      title={socketKey}
    >
      <span className="psock-fill" style={{ opacity: 0.15 + fill * 0.85 }} />
    </span>
  );
}
