import RecordingControls, { type RecordingControlsProps } from './RecordingControls';

type ExportToolbarProps = RecordingControlsProps;

export default function ExportToolbar(props: ExportToolbarProps) {
  return (
    <div className="export-toolbar">
      <RecordingControls {...props} />
    </div>
  );
}
