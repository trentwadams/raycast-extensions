import { LocalStorage } from "@raycast/api";
import {
  isInternalModel,
  ModelSelection,
  modelKey,
  modelParts,
  parseModelKey,
  PRIMARY_ENVIRONMENT,
  RuntimeMode,
  ShellSnapshot,
  ThreadEnvMode,
  threadTimestamp,
} from "./t3";

/** Everything that decides where and how a new session runs, apart from the prompt. */
export type Preset = {
  id: string;
  /** Which environment the project is on. Presets saved before there were several
   * have none, and belong to the primary one. */
  environmentKey?: string;
  projectId: string;
  modelKey: string;
  /** The selection as T3 stored it, so a saved preset keeps typed options. */
  selection?: ModelSelection;
  runtimeMode: RuntimeMode;
  envMode: ThreadEnvMode;
  saved: boolean;
};

export const CUSTOM_PRESET = "custom";
const SAVED_PRESETS_KEY = "saved-presets";
const RECENT_LIMIT = 6;

export const presetEnvironment = (preset: Pick<Preset, "environmentKey">) =>
  preset.environmentKey ?? PRIMARY_ENVIRONMENT;

/** A project's own environment's threads and projects, which a preset is read against. */
export type PresetSource = { key: string; snapshot: ShellSnapshot };

export const sameSettings = (a: Preset, b: Preset) =>
  presetEnvironment(a) === presetEnvironment(b) &&
  a.projectId === b.projectId &&
  a.modelKey === b.modelKey &&
  a.runtimeMode === b.runtimeMode &&
  a.envMode === b.envMode;

export async function loadSavedPresets(): Promise<Preset[]> {
  try {
    const stored = await LocalStorage.getItem<string>(SAVED_PRESETS_KEY);
    return stored ? (JSON.parse(stored) as Preset[]) : [];
  } catch {
    return [];
  }
}

export const storeSavedPresets = (presets: Preset[]) =>
  LocalStorage.setItem(SAVED_PRESETS_KEY, JSON.stringify(presets));

/** What every environment has actually been running lately, newest first, so the
 * list is useful before anyone has saved a thing. */
export function recentPresets(sources: PresetSource[]): Preset[] {
  const found: Preset[] = [];
  const threads = sources
    .flatMap(({ key, snapshot }) => {
      const liveProjectIds = new Set(
        snapshot.projects.filter((p) => !p.deletedAt).map((p) => p.id),
      );
      return snapshot.threads
        .filter(
          (thread) =>
            !thread.deletedAt &&
            thread.modelSelection &&
            !isInternalModel(thread.modelSelection.model) &&
            liveProjectIds.has(thread.projectId),
        )
        .map((thread) => ({ key, thread }));
    })
    .sort((a, b) => threadTimestamp(b.thread) - threadTimestamp(a.thread));
  for (const { key, thread } of threads) {
    const candidate: Preset = {
      id: "",
      environmentKey: key,
      projectId: thread.projectId,
      modelKey: modelKey(thread.modelSelection!),
      runtimeMode: thread.runtimeMode,
      // What the thread ran in, so a recent worktree session is not offered as Local.
      envMode: thread.worktreePath ? "worktree" : "local",
      saved: false,
    };
    if (found.some((existing) => sameSettings(existing, candidate))) {
      continue;
    }
    found.push({ ...candidate, id: `recent:${found.length}` });
    if (found.length === RECENT_LIMIT) {
      break;
    }
  }
  return found;
}

const MODE_NAME: Record<RuntimeMode, string> = {
  "full-access": "Full",
  auto: "Auto",
  "auto-accept-edits": "Edits",
  "approval-required": "Approval",
};

/** "Claude Opus 5.5 high 1M": every part of the model selection, space separated. */
export const shortModelName = (
  selection: ReturnType<typeof parseModelKey>,
  names: Record<string, string> = {},
) => modelParts(selection, names).join(" ");

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

/** "rohlik · Opus 5.5 · Full · Worktree": project and model, then permissions, then
 * the workspace only when it is not the default. With several environments the
 * environment comes first: "Mac · rohlik · …". */
export function presetLabel(
  preset: Pick<Preset, "projectId" | "modelKey" | "runtimeMode" | "envMode">,
  snapshot: ShellSnapshot,
  names: Record<string, string> = {},
  environmentLabel?: string,
): string {
  const project = snapshot.projects.find((p) => p.id === preset.projectId);
  return [
    environmentLabel ? clip(environmentLabel, 14) : null,
    clip(project?.title ?? "Unknown project", 22),
    shortModelName(parseModelKey(preset.modelKey), names),
    MODE_NAME[preset.runtimeMode] ?? preset.runtimeMode,
    preset.envMode === "worktree" ? "Worktree" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Saved presets whose project is gone would only ever fail, so they are not offered.
 * One for an environment that is offline right now is hidden too, but stays stored. */
export function usableSaved(
  saved: Preset[],
  sources: PresetSource[],
): Preset[] {
  return saved.filter((preset) =>
    sources.some(
      ({ key, snapshot }) =>
        key === presetEnvironment(preset) &&
        snapshot.projects.some(
          (p) => p.id === preset.projectId && !p.deletedAt,
        ),
    ),
  );
}
