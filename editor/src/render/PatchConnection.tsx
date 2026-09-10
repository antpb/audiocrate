import { Presets } from 'rete-react-plugin';
import { jackFromOutputs } from '../activity';
import { useNodeActivity } from '../useActivity';

const ClassicConnection = Presets.classic.Connection;

interface PatchConnectionProps {
  data: {
    source: string;
    sourceOutput: string;
    isLoop?: boolean;
  };
  styles?: () => unknown;
}

export function PatchConnection(props: PatchConnectionProps) {
  const node = useNodeActivity(props.data.source);
  const activity = jackFromOutputs(node?.outputs, props.data.sourceOutput);
  const level = Math.max(activity.peak, Math.abs(activity.mean));
  const width = 1.1 + level * 1.6;
  const alpha = 0.35 + level * 0.45;
  return (
    <ClassicConnection
      data={props.data as never}
      styles={() => ({
        stroke: level > 0.04 ? `rgba(170,180,150,${alpha})` : `rgba(130,130,130,${alpha})`,
        strokeWidth: `${width}px`,
      })}
    />
  );
}
