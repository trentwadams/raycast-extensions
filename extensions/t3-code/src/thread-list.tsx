import {
  Action,
  ActionPanel,
  Color,
  Icon,
  launchCommand,
  LaunchType,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useState } from "react";
import {
  Environment,
  EnvironmentFailure,
  errorMessage,
  failureSummary,
  launchApp,
  liveProjects,
  loadShells,
  PRIMARY_ENVIRONMENT,
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

/** When every environment failed there is nothing to list. With one environment its
 * own error is shown as before; with several, each one's reason, and the primary's
 * kind decides whether launching T3 Code is offered. */
export function allFailedError(failures: EnvironmentFailure[]): Error {
  if (failures.length === 1) {
    return failures[0].error;
  }
  const primary =
    failures.find(
      (failure) => failure.environment.key === PRIMARY_ENVIRONMENT,
    ) ?? failures[0];
  const message = failures
    .map((failure) => `${failure.label}: ${failure.error.message}`)
    .join("\n");
  return primary.error instanceof T3Error
    ? new T3Error(primary.error.kind, message)
    : new Error(message);
}

export default function ThreadList({
  select,
  searchBarPlaceholder,
  emptyTitle,
  emptyDescription,
}: Props) {
  const [filter, setFilter] = useState(ALL);
  const { data, isLoading, error, revalidate } = usePromise(async () => {
    const { environments, shells, failures } = await loadShells();
    if (shells.length === 0) {
      throw allFailedError(failures);
    }
    const presets = await Promise.all(
      shells.map((shell) => snoozePresets(shell.environment)),
    );
    return {
      multiple: environments.length > 1,
      shells: shells.map((shell, index) => ({
        ...shell,
        presets: presets[index],
      })),
      failures,
    };
  });

  if (error) {
    return <ErrorView error={error} onRetry={revalidate} />;
  }

  const multiple = data?.multiple ?? false;
  const shells = data?.shells ?? [];
  const now = Date.now();
  // Thread and project ids are only unique within one environment.
  const projectKey = (environment: Environment, projectId: string) =>
    `${environment.key}:${projectId}`;
  const projectsByEnvironment = shells.map((shell) => ({
    shell,
    projects: liveProjects(shell.snapshot),
  }));
  const projectTitles = new Map(
    projectsByEnvironment.flatMap(({ shell, projects }) =>
      projects.map((project) => [
        projectKey(shell.environment, project.id),
        project.title,
      ]),
    ),
  );
  const rows = shells
    .flatMap((shell) =>
      select(shell.snapshot).map((thread) => ({
        shell,
        thread,
        section: sectionOf(thread, now),
        status: statusOf(thread),
      })),
    )
    .filter(
      ({ shell, thread, section }) =>
        filter === ALL ||
        filter === `section:${section}` ||
        filter === `environment:${shell.environment.key}` ||
        filter === `project:${projectKey(shell.environment, thread.projectId)}`,
    )
    .sort((a, b) => threadTimestamp(b.thread) - threadTimestamp(a.thread));

  const sections = SECTIONS.map(({ id, title }) => ({
    id,
    title,
    rows: rows.filter((row) => row.section === id),
  })).filter((section) => section.rows.length > 0);

  // A failed environment stays visible whatever the filter, unless the filter is
  // another environment, so a short list never hides that something is missing.
  const failures = (data?.failures ?? []).filter(
    (failure) =>
      !filter.startsWith("environment:") ||
      filter === `environment:${failure.environment.key}`,
  );

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
          {multiple ? (
            <List.Dropdown.Section title="Environment">
              {[...shells, ...(data?.failures ?? [])].map(
                ({ environment, label }) => (
                  <List.Dropdown.Item
                    key={environment.key}
                    title={label}
                    value={`environment:${environment.key}`}
                  />
                ),
              )}
            </List.Dropdown.Section>
          ) : null}
          <List.Dropdown.Section title="Section">
            {SECTIONS.map(({ id, title }) => (
              <List.Dropdown.Item
                key={id}
                title={title}
                value={`section:${id}`}
              />
            ))}
          </List.Dropdown.Section>
          {projectsByEnvironment.map(({ shell, projects }) => (
            <List.Dropdown.Section
              key={shell.environment.key}
              title={multiple ? `Projects on ${shell.label}` : "Project"}
            >
              {projects.map((project) => (
                <List.Dropdown.Item
                  key={project.id}
                  title={project.title}
                  value={`project:${projectKey(shell.environment, project.id)}`}
                />
              ))}
            </List.Dropdown.Section>
          ))}
        </List.Dropdown>
      }
    >
      {isLoading || failures.length > 0 ? null : (
        <List.EmptyView
          title={emptyTitle}
          description={emptyDescription}
          icon={Icon.Message}
        />
      )}
      {failures.length > 0 ? (
        <List.Section title="Unavailable">
          {failures.map((failure) => (
            <FailureItem
              key={failure.environment.key}
              failure={failure}
              onRetry={revalidate}
            />
          ))}
        </List.Section>
      ) : null}
      {sections.map((section) => (
        <List.Section
          key={section.id}
          title={section.title}
          subtitle={String(section.rows.length)}
        >
          {section.rows.map(({ shell, thread, section: id, status }) => {
            const projectTitle = projectTitles.get(
              projectKey(shell.environment, thread.projectId),
            );
            return (
              <ThreadItem
                key={`${shell.environment.key}:${thread.id}`}
                thread={thread}
                section={id}
                status={status}
                projectTitle={projectTitle}
                environmentLabel={multiple ? shell.label : undefined}
                actions={
                  <ThreadActions
                    environment={shell.environment}
                    thread={thread}
                    projectTitle={projectTitle}
                    section={id}
                    status={status}
                    server={shell.server}
                    snoozePresets={shell.presets}
                    onChange={revalidate}
                  />
                }
              />
            );
          })}
        </List.Section>
      ))}
    </List>
  );
}

/** One environment that could not be read, with the reason, in place of its threads. */
function FailureItem(props: {
  failure: EnvironmentFailure;
  onRetry: () => void;
}) {
  const { environment, label, error } = props.failure;
  const unreachable = error instanceof T3Error && error.kind === "unreachable";
  return (
    <List.Item
      title={label}
      subtitle={errorMessage(error)}
      icon={{ source: Icon.Plug, tintColor: Color.Red }}
      keywords={[label]}
      accessories={[
        {
          tag: { value: failureSummary(error), color: Color.Red },
          tooltip: environment.origin,
        },
      ]}
      actions={
        <ActionPanel>
          <Action
            title="Retry"
            icon={Icon.ArrowClockwise}
            onAction={props.onRetry}
          />
          {/* Only the primary environment is the T3 Code app on this machine. */}
          {unreachable && environment.key === PRIMARY_ENVIRONMENT ? (
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
            title="Manage Environments"
            icon={Icon.Network}
            onAction={() =>
              launchCommand({
                name: "manage-environments",
                type: LaunchType.UserInitiated,
              })
            }
          />
          <Action.CopyToClipboard
            title="Copy Error"
            content={`${label} (${environment.origin}): ${errorMessage(error)}`}
          />
        </ActionPanel>
      }
    />
  );
}

function ThreadItem(props: {
  thread: Thread;
  section: Section;
  status: ReturnType<typeof statusOf>;
  projectTitle: string | undefined;
  /** Set only when more than one environment is configured. */
  environmentLabel: string | undefined;
  actions: List.Item.Props["actions"];
}) {
  const { thread, section, status, projectTitle, environmentLabel } = props;
  const snoozedUntil =
    section === "snoozed" && thread.snoozedUntil
      ? new Date(thread.snoozedUntil)
      : undefined;
  return (
    <List.Item
      title={thread.title}
      subtitle={projectTitle ?? ""}
      icon={threadIcon(status, section)}
      keywords={[
        projectTitle ?? "",
        thread.branch ?? "",
        status ?? "",
        environmentLabel ?? "",
      ]}
      accessories={[
        ...(status
          ? [{ tag: { value: status, color: statusColor(status) } }]
          : []),
        ...(thread.branch ? [{ tag: thread.branch }] : []),
        ...(environmentLabel
          ? [
              {
                tag: { value: environmentLabel, color: Color.SecondaryText },
                tooltip: "Environment",
              },
            ]
          : []),
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
