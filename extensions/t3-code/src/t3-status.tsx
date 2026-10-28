import {
  environment,
  launchCommand,
  LaunchType,
  updateCommandMetadata,
} from "@raycast/api";
import {
  EnvironmentFailure,
  failureSummary,
  loadShells,
  PRIMARY_ENVIRONMENT,
  ShellSnapshot,
  T3Error,
  Thread,
} from "./t3";
import {
  listedThreads,
  NEEDS_YOU,
  sectionOf,
  statusOf,
  waitingThreads,
} from "./thread-state";

type StatusCounts = {
  needYou: Thread[];
  failed: number;
  done: number;
  working: number;
  waiting: number;
};

function countThreads(snapshot: ShellSnapshot): StatusCounts {
  const now = Date.now();
  const shown = listedThreads(snapshot)
    .filter((thread) => {
      const section = sectionOf(thread, now);
      return section !== "snoozed" && section !== "settled";
    })
    .map((thread) => ({ thread, status: statusOf(thread) }));
  const needYou = shown.filter(
    ({ status }) => status !== null && NEEDS_YOU.has(status),
  );
  const counted = new Set(needYou.map(({ thread }) => thread.id));
  return {
    // Newest first, so a lone thread named in the subtitle is the latest one.
    needYou: needYou
      .map(({ thread }) => thread)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    failed: needYou.filter(({ status }) => status === "Failed").length,
    done: shown.filter(({ status }) => status === "Completed").length,
    // A thread that needs you is counted there only, even while its agent runs.
    working: shown.filter(
      ({ thread }) =>
        sectionOf(thread, now) === "working" && !counted.has(thread.id),
    ).length,
    waiting: waitingThreads(snapshot).filter(
      (thread) => !counted.has(thread.id),
    ).length,
  };
}

/** One set of counts across every environment that answered. */
function sumCounts(all: StatusCounts[]): StatusCounts {
  return {
    needYou: all
      .flatMap((counts) => counts.needYou)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    failed: all.reduce((sum, counts) => sum + counts.failed, 0),
    done: all.reduce((sum, counts) => sum + counts.done, 0),
    working: all.reduce((sum, counts) => sum + counts.working, 0),
    waiting: all.reduce((sum, counts) => sum + counts.waiting, 0),
  };
}

/** "Mac offline", so a quiet subtitle never hides an environment it could not read. */
const failuresSuffix = (failures: EnvironmentFailure[]) =>
  failures.length === 0
    ? ""
    : ` · ${failures
        .map((failure) => `${failure.label} ${failureSummary(failure.error)}`)
        .join(", ")}`;

const truncate = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;

/** A subtitle is plain text, so colour comes from emoji: red when something failed,
 * orange when something else waits on you, green for finished work you haven't seen,
 * blue for running agents. Threads that are merely idle only show when nothing else
 * does. */
function statusSubtitle(counts: StatusCounts): string {
  const { needYou, failed, done, working, waiting } = counts;
  const parts: string[] = [];
  if (needYou.length === 1) {
    parts.push(
      `${failed > 0 ? "🔴" : "🟠"} ${truncate(needYou[0].title, 40)} needs you`,
    );
  } else if (needYou.length > 1) {
    parts.push(`${failed > 0 ? "🔴" : "🟠"} ${needYou.length} need you`);
  }
  if (done > 0) {
    parts.push(`🟢 ${done} done`);
  }
  if (working > 0) {
    parts.push(`🔵 ${working} working`);
  }
  if (parts.length === 0) {
    return waiting > 0 ? `${waiting} waiting` : "All quiet";
  }
  return parts.join(" · ");
}

function errorSubtitle(error: unknown): string {
  if (error instanceof T3Error && error.kind === "unreachable") {
    return "T3 Code is not running";
  }
  if (error instanceof T3Error && error.kind === "unauthorized") {
    return "Token rejected";
  }
  return "T3 Code request failed";
}

// A background run that throws marks the command with a warning in root search, so
// every failure becomes the subtitle instead. Counts are summed over the environments
// that answered; only when none did does the subtitle become the error.
export default async function Command() {
  let counts: StatusCounts | null = null;
  try {
    const { shells, failures } = await loadShells();
    if (shells.length === 0) {
      throw (
        failures.find(
          (failure) => failure.environment.key === PRIMARY_ENVIRONMENT,
        ) ?? failures[0]
      ).error;
    }
    counts = sumCounts(shells.map((shell) => countThreads(shell.snapshot)));
    await updateCommandMetadata({
      subtitle: statusSubtitle(counts) + failuresSuffix(failures),
    });
  } catch (error) {
    await updateCommandMetadata({ subtitle: errorSubtitle(error) }).catch(
      () => undefined,
    );
  }
  if (environment.launchType === LaunchType.UserInitiated) {
    await launchCommand({
      name:
        counts && counts.needYou.length > 0
          ? "waiting-threads"
          : "search-threads",
      type: LaunchType.UserInitiated,
    });
  }
}
