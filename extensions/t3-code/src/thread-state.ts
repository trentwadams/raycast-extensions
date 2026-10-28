import { Color, Icon, Image } from "@raycast/api";
import type { ShellSnapshot, Thread } from "./t3";

/** Where the T3 sidebar files a thread. Working splits running threads out of Active. */
export type Section = "pinned" | "working" | "active" | "snoozed" | "settled";

export const SECTIONS: { id: Section; title: string }[] = [
  { id: "pinned", title: "Pinned" },
  { id: "working", title: "Working" },
  { id: "active", title: "Active" },
  { id: "snoozed", title: "Snoozed" },
  { id: "settled", title: "Settled" },
];

/** The sidebar's status pill, in its priority order. */
export type StatusLabel =
  | "Pending Approval"
  | "Awaiting Input"
  | "Guest Request"
  | "Working"
  | "Connecting"
  | "Waiting"
  | "Failed"
  | "Plan Ready"
  | "Completed";

type RunStatus =
  | "idle"
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";

const ACTIVE_RUN_STATUSES = new Set<string>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** Agents a thread is waiting on hold its completion; commands and monitors do so only
 * when marked awaited, since they are as often a dev server as a wait. */
const holdsCompletion = (thread: Thread) =>
  (thread.pendingBackgroundTasks ?? []).some(
    (task) =>
      task.awaited === true ||
      task.kind === "subagent" ||
      task.kind === "background_task",
  );

/** What the agent is doing now, mirroring T3's runtime summary. Protocol v1 threads only
 * know their latest turn. */
export function runtimeStatus(thread: Thread): RunStatus | null {
  if (thread.status === undefined) {
    const state = thread.latestTurn?.state;
    return state === "error" ? "failed" : (state ?? null);
  }
  const parked = holdsCompletion(thread) && thread.status !== "failed";
  if (!thread.latestRunId && !thread.activeProviderThreadId && !parked) {
    return null;
  }
  return parked
    ? "idle"
    : ((thread.activityRunStatus ?? thread.status) as RunStatus);
}

function latestRun(
  thread: Thread,
): { status: RunStatus; completedAt: string | null } | null {
  if (thread.status === undefined) {
    const turn = thread.latestTurn;
    return turn
      ? {
          status: turn.state === "error" ? "failed" : turn.state,
          completedAt: turn.completedAt,
        }
      : null;
  }
  if (!thread.latestRunId) {
    return null;
  }
  return {
    status:
      thread.status === "idle" ? "completed" : (thread.status as RunStatus),
    completedAt: thread.latestRunCompletedAt ?? null,
  };
}

export const isRunning = (thread: Thread) =>
  ACTIVE_RUN_STATUSES.has(runtimeStatus(thread) ?? "");

/** An approval the agent is blocked on. Auth refreshes are handled by T3 itself. */
export function pendingApproval(thread: Thread) {
  const request = thread.pendingRuntimeRequest;
  return request &&
    request.kind !== "user_input" &&
    request.kind !== "auth_refresh"
    ? request
    : null;
}

/** A question from the agent. A non-blocking one only counts once the run has stopped. */
export function pendingQuestion(thread: Thread) {
  const request = thread.pendingRuntimeRequest;
  if (request?.kind !== "user_input") {
    return null;
  }
  const working = ["preparing", "starting", "running"].includes(
    runtimeStatus(thread) ?? "",
  );
  return request.blocking !== false || !working ? request : null;
}

const parseTime = (value: string | null | undefined) =>
  value ? Date.parse(value) : Number.NaN;

/** Unopened threads' failures count as unseen, unlike completions. */
function unseenFailure(thread: Thread): boolean {
  const run = latestRun(thread);
  if (run?.status !== "failed") {
    return false;
  }
  if (!thread.lastVisitedAt) {
    return true;
  }
  const completedAt = parseTime(run.completedAt);
  const visitedAt = parseTime(thread.lastVisitedAt);
  return Number.isNaN(completedAt) || Number.isNaN(visitedAt)
    ? true
    : completedAt > visitedAt;
}

export function unseenCompletion(thread: Thread): boolean {
  const completedAt = parseTime(latestRun(thread)?.completedAt);
  if (Number.isNaN(completedAt) || !thread.lastVisitedAt) {
    return false;
  }
  const visitedAt = parseTime(thread.lastVisitedAt);
  return Number.isNaN(visitedAt) || completedAt > visitedAt;
}

/** Mirrors resolveThreadStatusPill in T3's Sidebar.logic.ts. */
export function statusOf(thread: Thread): StatusLabel | null {
  const runtime = runtimeStatus(thread);
  if (pendingApproval(thread)) {
    return "Pending Approval";
  }
  if (pendingQuestion(thread)) {
    return "Awaiting Input";
  }
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "Guest Request";
  }
  if (
    (runtime === "running" && thread.blockedOnThreadWait !== true) ||
    runtime === "waiting"
  ) {
    return "Working";
  }
  if (
    runtime === "preparing" ||
    runtime === "starting" ||
    runtime === "queued"
  ) {
    return "Connecting";
  }
  if (
    (runtime === "running" && thread.blockedOnThreadWait === true) ||
    holdsCompletion(thread)
  ) {
    return "Waiting";
  }
  if (unseenFailure(thread)) {
    return "Failed";
  }
  const run = latestRun(thread);
  const runSettled = run !== null && !ACTIVE_RUN_STATUSES.has(runtime ?? "");
  if (
    thread.interactionMode === "plan" &&
    runSettled &&
    thread.hasActionableProposedPlan
  ) {
    return "Plan Ready";
  }
  return unseenCompletion(thread) ? "Completed" : null;
}

/** The statuses where the next move is yours. */
export const NEEDS_YOU = new Set<StatusLabel>([
  "Pending Approval",
  "Awaiting Input",
  "Guest Request",
  "Failed",
  "Plan Ready",
]);

/** A snooze ends early when the thread raises its hand: a request for you, a guest
 * message, or a failure newer than the snooze. */
function raisedHandWhileSnoozed(thread: Thread): boolean {
  if (
    thread.pendingRuntimeRequest ||
    (thread.pendingGuestMessageCount ?? 0) > 0
  ) {
    return true;
  }
  const run = latestRun(thread);
  if (run?.status !== "failed") {
    return false;
  }
  return (
    !thread.snoozedAt ||
    parseTime(run.completedAt ?? thread.updatedAt) > parseTime(thread.snoozedAt)
  );
}

export function isSnoozed(thread: Thread, now = Date.now()): boolean {
  const wakeAt = parseTime(thread.snoozedUntil);
  return (
    !Number.isNaN(wakeAt) && wakeAt > now && !raisedHandWhileSnoozed(thread)
  );
}

export function isSettled(thread: Thread): boolean {
  return thread.settledOverride !== undefined
    ? thread.settledOverride === "settled"
    : Boolean(thread.settledAt);
}

export function sectionOf(thread: Thread, now = Date.now()): Section {
  if (isSnoozed(thread, now)) {
    return "snoozed";
  }
  if (isSettled(thread)) {
    return "settled";
  }
  if (thread.pinnedAt) {
    return "pinned";
  }
  return isRunning(thread) && !thread.pendingRuntimeRequest
    ? "working"
    : "active";
}

/** The threads the sidebar lists on its own row: subagents sit under their parent. */
export function listedThreads(snapshot: ShellSnapshot): Thread[] {
  return snapshot.threads.filter(
    (thread) =>
      !thread.deletedAt &&
      !thread.archivedAt &&
      thread.lineage?.relationshipToParent !== "subagent",
  );
}

/** Pinned and active threads whose agent has stopped, so the next move is yours. */
export function waitingThreads(snapshot: ShellSnapshot): Thread[] {
  const now = Date.now();
  return listedThreads(snapshot).filter((thread) => {
    const section = sectionOf(thread, now);
    return section === "pinned" ? !isRunning(thread) : section === "active";
  });
}

const STATUS_STYLE: Record<
  StatusLabel,
  { icon: Image.ImageLike; color: Color }
> = {
  "Pending Approval": { icon: Icon.SpeechBubbleImportant, color: Color.Orange },
  "Awaiting Input": { icon: Icon.QuestionMarkCircle, color: Color.Purple },
  "Guest Request": { icon: Icon.TwoPeople, color: Color.Magenta },
  Working: { icon: Icon.CircleProgress50, color: Color.Blue },
  Connecting: { icon: Icon.CircleProgress25, color: Color.Blue },
  Waiting: { icon: Icon.Hourglass, color: Color.SecondaryText },
  Failed: { icon: Icon.ExclamationMark, color: Color.Red },
  "Plan Ready": { icon: Icon.List, color: Color.Purple },
  Completed: { icon: Icon.CheckCircle, color: Color.Green },
};

export const statusColor = (label: StatusLabel) => STATUS_STYLE[label].color;

/** The row icon: the status when there is one, otherwise where the thread sits. */
export function threadIcon(
  status: StatusLabel | null,
  section: Section,
): Image.ImageLike {
  if (status) {
    const { icon, color } = STATUS_STYLE[status];
    return { source: icon as Image.Source, tintColor: color };
  }
  switch (section) {
    case "snoozed":
      return { source: Icon.Clock, tintColor: Color.SecondaryText };
    case "settled":
      return { source: Icon.CheckCircle, tintColor: Color.SecondaryText };
    case "pinned":
      return { source: Icon.Tack, tintColor: Color.SecondaryText };
    default:
      return { source: Icon.Circle, tintColor: Color.SecondaryText };
  }
}

/** A snooze preset as T3 stores it in settings. */
export type SnoozePresetSetting =
  | { kind: "after"; minutes: number }
  | {
      kind: "at";
      day:
        | "today"
        | "tomorrow"
        | "monday"
        | "tuesday"
        | "wednesday"
        | "thursday"
        | "friday"
        | "saturday"
        | "sunday";
      time: string;
    };

export const DEFAULT_SNOOZE_PRESETS: SnoozePresetSetting[] = [
  { kind: "after", minutes: 60 },
  { kind: "after", minutes: 180 },
  { kind: "at", day: "today", time: "18:00" },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "at", day: "monday", time: "09:00" },
];

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const plural = (count: number, unit: string) =>
  `${count} ${unit}${count === 1 ? "" : "s"}`;

function durationLabel(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    return plural(minutes / (24 * 60), "day");
  }
  return minutes % 60 === 0
    ? plural(minutes / 60, "hour")
    : plural(minutes, "minute");
}

const capitalize = (word: string) => word[0].toUpperCase() + word.slice(1);

/** One snooze choice with its wake time, labelled the way T3's snooze menu labels it. */
export type SnoozeChoice = { id: string; label: string; until: Date };

/** Mirrors resolveSnoozePresets in T3's threadSettled.ts: soonest first, one per wake
 * minute, with a "today" time that has passed left out. */
export function snoozeChoices(
  presets: SnoozePresetSetting[],
  now = new Date(),
): SnoozeChoice[] {
  const seen = new Set<number>();
  return presets
    .flatMap((preset): SnoozeChoice[] => {
      if (preset.kind === "after") {
        return [
          {
            id: `after:${preset.minutes}`,
            label: `In ${durationLabel(preset.minutes)}`,
            until: new Date(now.getTime() + preset.minutes * 60_000),
          },
        ];
      }
      const daysAhead =
        preset.day === "today"
          ? 0
          : preset.day === "tomorrow"
            ? 1
            : (WEEKDAYS.indexOf(preset.day) - now.getDay() + 7) % 7 || 7;
      // Calendar days, not 24-hour steps, so a DST change keeps the local time.
      const until = new Date(now);
      until.setDate(until.getDate() + daysAhead);
      until.setHours(
        Number(preset.time.slice(0, 2)),
        Number(preset.time.slice(3)),
        0,
        0,
      );
      if (until.getTime() <= now.getTime()) {
        return [];
      }
      const hour = Number(preset.time.slice(0, 2));
      const label =
        daysAhead === 0
          ? hour < 12
            ? "This morning"
            : hour < 17
              ? "This afternoon"
              : "This evening"
          : daysAhead === 1
            ? "Tomorrow"
            : preset.day === "monday"
              ? "Next week"
              : daysAhead === 7
                ? `Next ${capitalize(preset.day)}`
                : capitalize(preset.day);
      return [{ id: `at:${preset.day}:${preset.time}`, label, until }];
    })
    .sort((a, b) => a.until.getTime() - b.until.getTime())
    .filter((choice) => {
      const minute = Math.floor(choice.until.getTime() / 60_000);
      if (seen.has(minute)) {
        return false;
      }
      seen.add(minute);
      return true;
    });
}
