import { Presets } from 'rete-react-plugin';
import { loudestJack } from '../activity';
import { isAnalysisKind } from '../analysisKinds';
import { useAnalysis } from '../useAnalysis';
import { useNodeActivity } from '../useActivity';
import { requestNodeMenu } from '../nodeMenu';
import { isMasterKind } from '../tools';
import { MiniScope } from './MiniScope';
import { SignalFace } from './SignalFace';

const RefSocket = Presets.classic.RefSocket;
const emptyWave = new Float32Array(0);

interface PatchNodeViewProps {
  data: {
    id: string;
    label: string;
    selected?: boolean;
    width?: number;
    height?: number;
    nodeKind?: string;
    inputs: Record<string, { label?: string; socket: unknown; index?: number } | undefined>;
    outputs: Record<string, { label?: string; socket: unknown; index?: number } | undefined>;
  };
  emit: (event: unknown) => void;
}

export function PatchNodeView(props: PatchNodeViewProps) {
  const { id, label, selected, width, height } = props.data;
  const inputs = Object.entries(props.data.inputs).filter((entry) => entry[1]);
  const outputs = Object.entries(props.data.outputs).filter((entry) => entry[1]);
  const activity = useNodeActivity(id);
  const analysis = useAnalysis(id);
  const audioOut = activity?.outputs.audio ?? activity?.outputs.cv;
  const incoming = activity?.inputs.input;
  const audioIn = incoming && incoming.peak > 0.01 ? incoming : undefined;
  const primary = audioIn ?? (audioOut && audioOut.peak > 0.02 ? audioOut : loudestJack(activity) ?? audioOut);
  const master = isMasterKind(props.data.nodeKind ?? '');
  const analysisNode = isAnalysisKind(props.data.nodeKind ?? '');
  return (
    <div
      className={`pnode${selected ? ' selected' : ''}${master ? ' master' : ''}${analysisNode ? ' analysis' : ''}`}
      style={{ width, height }}
      data-testid="node"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        requestNodeMenu({ nodeId: id, x: event.clientX, y: event.clientY });
      }}
    >
      <div className="title" data-testid="title">
        <span>{label}</span>
        {!analysisNode && primary ? <MiniScope wave={primary.wave} /> : null}
        {!analysisNode ? <span className="pmeter" style={{ transform: `scaleY(${primary?.peak ?? 0})` }} /> : null}
      </div>
      {analysisNode ? (
        <SignalFace
          kind={props.data.nodeKind ?? ''}
          view={analysis}
          wave={analysis.wave.length > 0 ? analysis.wave : (primary?.wave ?? emptyWave)}
          peak={Math.max(analysis.peak, primary?.peak ?? 0)}
        />
      ) : null}
      {outputs.map(([key, output]) =>
        output ? (
          <div className="outputs">
          <div className="output" key={key} data-testid={`output-${key}`}>
            <div className="output-title">{output.label ?? key}</div>
            <RefSocket
              name="output-socket"
              side="output"
              socketKey={key}
              nodeId={id}
              emit={props.emit}
              payload={output.socket as never}
            />
            </div>
          </div>
        ) : null,
      )}
      {inputs.map(([key, input]) =>
        input ? (
          <div className="inputs">
          <div className="input" key={key} data-testid={`input-${key}`}>
            <RefSocket
              name="input-socket"
              side="input"
              socketKey={key}
              nodeId={id}
              emit={props.emit}
              payload={input.socket as never}
            />
              <div className="input-title">{input.label ?? key}</div>
            </div>
          </div>
        ) : null,
      )}
      </div>
  );
}
