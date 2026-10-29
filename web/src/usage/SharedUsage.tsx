// The usage page's Shared tab (issue #362's slot, filled by #364): usage that every computer publishes to a shared repo,
// several people's in one chart, with "Mine" for one's own (Martin, Ledung question #310). The content is SharedView.tsx.
import { SharedTab } from './SharedView.tsx';

export function SharedUsage() {
  return (
    <div className="usage-body">
      <SharedTab />
    </div>
  );
}
