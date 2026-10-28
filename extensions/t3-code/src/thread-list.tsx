import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useState } from "react";
import {
  getServerInfo,
  getShell,
  launchApp,
  liveProjects,
  ShellSnapshot,
  snoozePresets,
  T3Error,
  Thread,
  threadTimestamp,
} from "./t3";
import { ThreadActions } from "./thread-actions";
import {
  Section,
  SECTIONS,
  sectionOf,
  statusColor,
  statusOf,
  threadIcon,
} from "./thread-state";

type Props = {
  /** Which threads the command shows, applied to the shell snapshot. */
  select: (snapshot: ShellSnapshot) => Thread[];
  searchBarPlaceholder: string;
  emptyTitle: string;
  emptyDescription: string;
};

const ALL = "all";

export default function ThreadList({
  select,
  searchBarPlaceholder,
  emptyTitle,
  emptyDescription,
}: Props) {
  const [filter, setFilter] = useState(ALL);
  const { data, isLoading, error, revalidate } = usePromise(async () => {
    const [snapshot, server, presets] = await Promise.all([
      getShell(),
      // The list still works against a server that cannot describe itself; it just
      // offers no actions beyond opening and copying.
      getServerInfo().catch(() => undefined),
      snoozePresets(),
    ]);
    return { snapshot, server, presets };
  });

  if (error) {
    return <ErrorView error={error} onRetry={revalidate} />;
  }

  const snapshot = data?.snapshot;
  const projects = snapshot ? liveProjects(snapshot) : [];
  const projectTitles = new Map(projects.map((p) => [p.id, p.title]));
  const now = Date.now();
  const rows = (snapshot ? select(snapshot) : [])
    .map((thread) => ({
      thread,
      section: sectionOf(thread, now),
      status: statusOf(thread),
    }))
    .filter(
      ({ thread, section }) =>
        filter === ALL ||
        filter === `section:${section}` ||
        filter === `project:${thread.projectId}`,
    )
    .sort((a, b) => threadTimestamp(b.thread) - threadTimestamp(a.thread));

  const sections = SECTIONS.map(({ id, title }) => ({
    id,
    title,
    rows: rows.filter((row) => row.section === id),
  })).filter((section) => section.rows.length > 0);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder={searchBarPlaceholder}
      searchBarAccessory={
        <List.Dropdown
          tooltip="Show"
          storeValue
          onChange={setFilter}
          value={filter}
        >
          <List.Dropdown.Item title="All Threads" value={ALL} />
          <List.Dropdown.Section title="Section">
            {SECTIONS.map(({ id, title }) => (
              <List.Dropdown.Item
                key={id}
                title={title}
                value={`section:${id}`}
              />
            ))}
          </List.Dropdown.Section>
          <List.Dropdown.Section title="Project">
            {projects.map((project) => (
              <List.Dropdown.Item
                key={project.id}
                title={project.title}
                value={`project:${project.id}`}
              />
            ))}
          </List.Dropdown.Section>
        </List.Dropdown>
      }
    >
      {isLoading ? null : (
        <List.EmptyView
          title={emptyTitle}
          description={emptyDescription}
          icon={Icon.Message}
        />
      )}
      {sections.map((section) => (
        <List.Section
          key={section.id}
          title={section.title}
          subtitle={String(section.rows.length)}
        >
          {section.rows.map(({ thread, section: id, status }) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              section={id}
              status={status}
              projectTitle={projectTitles.get(thread.projectId)}
              actions={
                <ThreadActions
                  thread={thread}
                  projectTitle={projectTitles.get(thread.projectId)}
                  section={id}
                  status={status}
                  server={data?.server}
                  snoozePresets={data?.presets ?? []}
                  onChange={revalidate}
                />
              }
            />
          ))}
        </List.Section>
      ))}
    </List>
  );
}

function ThreadItem(props: {
  thread: Thread;
  section: Section;
  status: ReturnType<typeof statusOf>;
  projectTitle: string | undefined;
  actions: List.Item.Props["actions"];
}) {
  const { thread, section, status, projectTitle } = props;
  const snoozedUntil =
    section === "snoozed" && thread.snoozedUntil
      ? new Date(thread.snoozedUntil)
      : undefined;
  return (
    <List.Item
      title={thread.title}
      subtitle={projectTitle ?? ""}
      icon={threadIcon(status, section)}
      keywords={[projectTitle ?? "", thread.branch ?? "", status ?? ""]}
      accessories={[
        ...(status
          ? [{ tag: { value: status, color: statusColor(status) } }]
          : []),
        ...(thread.branch ? [{ tag: thread.branch }] : []),
        snoozedUntil
          ? {
              icon: Icon.Clock,
              date: snoozedUntil,
              tooltip: `Snoozed until ${snoozedUntil.toLocaleString()}`,
            }
          : { date: new Date(thread.updatedAt) },
      ]}
      actions={props.actions}
    />
  );
}

export function ErrorView({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}) {
  const unreachable = error instanceof T3Error && error.kind === "unreachable";
  return (
    <List>
      <List.EmptyView
        icon={{ source: Icon.Plug, tintColor: Color.Red }}
        title={
          unreachable ? "T3 Code is not running" : "T3 Code request failed"
        }
        description={error.message}
        actions={
          <ActionPanel>
            {unreachable ? (
              <Action
                title="Launch T3 Code"
                icon={Icon.AppWindow}
                onAction={async () => {
                  await launchApp();
                  await showToast({
                    style: Toast.Style.Success,
                    title: "Launching T3 Code",
                  });
                }}
              />
            ) : null}
            <Action
              title="Retry"
              icon={Icon.ArrowClockwise}
              onAction={onRetry}
            />
          </ActionPanel>
        }
      />
    </List>
  );
}
