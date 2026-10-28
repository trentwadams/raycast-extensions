import ThreadList from "./thread-list";
import { listedThreads } from "./thread-state";

export default function Command() {
  return (
    <ThreadList
      select={listedThreads}
      searchBarPlaceholder="Search threads by title, project, branch or status"
      emptyTitle="No threads"
      emptyDescription="This T3 Code environment has no live threads."
    />
  );
}
