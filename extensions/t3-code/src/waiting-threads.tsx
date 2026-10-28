import ThreadList from "./thread-list";
import { waitingThreads } from "./thread-state";

export default function Command() {
  return (
    <ThreadList
      select={waitingThreads}
      searchBarPlaceholder="Filter threads waiting on you"
      emptyTitle="Nothing waiting"
      emptyDescription="Every active thread is either running or settled."
    />
  );
}
